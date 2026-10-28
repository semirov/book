#!/bin/bash
# compose-release.sh — the container runtime's only way to reach prod (BOOK-172).
#
#   site/deploy/compose-release.sh --ref main             # build book:<sha>, up, health gate
#   site/deploy/compose-release.sh --rollback             # one command back to the previous image
#   site/deploy/compose-release.sh --status               # what runs now and what it reports (read-only)
#   site/deploy/compose-release.sh --ref <sha> --dry-run   # print the plan, touch nothing
#
# The launchd script (`deploy.sh`) stays the fallback for one deploy cycle and is not touched here.
# `$STATE_DIR/runtime` (written by `flip.sh`) decides which of the two the workflow runs; both take
# the SAME lock (`$STATE_DIR/deploy.lock`), so a launchd deploy and a compose deploy can never run
# at the same time.
#
# What it guarantees (BOOK-172 IFACE):
#   * exit 0 — the new image serves its own commit and every service is healthy;
#     exit 1 — the run failed and the stack is back on the previous image (or could not be): red,
#              a human must look; exit 2 — usage; exit 3 — another deploy holds the lock and nothing
#              was built, started or rolled back (the driver must not read it as a red deploy);
#   * images are immutable and commit-tagged (`book:<40-char sha>`), never `latest`; the image that
#     served before the last release is kept on disk and its tag is recorded in
#     `$STATE_DIR/previous-image` (`$STATE_DIR/last-good-image` records the last image whose gate
#     passed), so `--rollback` is one `up -d` with no rebuild;
#   * a health gate with a fixed budget (`BOOK_HEALTH_TIMEOUT`, default 180 s) and a grace window
#     (`BOOK_HEALTH_GRACE`, 60 s), polling `/healthz` for the commit the IMAGE carries; a rollback
#     needs two independent negatives (`lib.sh:rollback_allowed`), never one slow read;
#   * a bounded image build (`BOOK_BUILD_TIMEOUT`, 1200 s);
#   * THE GATE DOES NOT RACE THE WRITER (BOOK-159): no `npm`, no `node`, no manuscript check and no
#     host process against the data dir run here. Docker and curl only. The full test suite is CI's
#     (gate.yml); the deploy's own gate is the container health gate plus five HTTP smokes;
#   * the data dir is only ever mounted by the stack, never by a test: this script never mounts it;
#   * `/locks` (the entrypoint's single-instance lock dir) is created here if it is missing, owned by
#     this uid and 0755 — Docker would create the bind source as root and every service would exit 75.
#
# The deploy lock is `$STATE_DIR/deploy.lock`. A flip holds it for the whole flip and runs this script
# as its child with `BOOK_LOCK_INHERITED=1`, so the child neither re-takes it (it would refuse its own
# flip with exit 3) nor releases it.
#
# Secrets: read from files (`/run/secrets/*` in the containers, 0600 on the host); this script prints
# no value and passes none. `docker compose` is always called with `--env-file /dev/null`, so the
# host's `site/.env` (launchd paths, plain values) can never leak into a service's environment.
set -eEuo pipefail

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

ROOT="${BOOK_DEPLOY_ROOT:-$HOME/book-deploy}"
STATE_DIR="${BOOK_STATE_DIR:-${HOME}/.local/state/book-deploy}"
AUDIT_LOG="${STATE_DIR}/deploy-audit.log"
# Read by lib.sh's lock_* functions (sourced above), which is why shellcheck cannot see the use.
# shellcheck disable=SC2034
LOCK_DIR="${STATE_DIR}/deploy.lock"
COMPOSE_FILE="${BOOK_COMPOSE_FILE:-${ROOT}/site/docker-compose.yml}"
PROJECT="${BOOK_PROJECT:-book}"
DOCKER="${BOOK_DOCKER:-docker}"
IMAGE_REPO="${BOOK_IMAGE_REPO:-book}"
SITE_BIND="${BOOK_SITE_PUBLISH:-192.168.1.76:8091}"
SITE_URL="${BOOK_SITE_URL:-http://${SITE_BIND%:*}:${SITE_BIND##*:}}"
BUDGET_MS="$(( ${BOOK_HEALTH_TIMEOUT:-180} * 1000 ))"
GRACE_MS="$(( ${BOOK_HEALTH_GRACE:-60} * 1000 ))"
BUILD_TIMEOUT="${BOOK_BUILD_TIMEOUT:-1200}"
KEEP_IMAGES="${BOOK_KEEP_IMAGES:-5}"
LAST_GOOD_IMAGE="${STATE_DIR}/last-good-image"
PREV_IMAGE_FILE="${STATE_DIR}/previous-image"
# The bind source for the entrypoint's per-role `flock` files. It MUST be created by the invoking
# uid: left to Docker the source appears owned by root, uid 501 cannot write it, and every service
# exits 75 on its own lock file.
LOCKS_DIR="${BOOK_LOCKS_DIR:-$HOME/.local/state/book-locks}"

MODE="deploy"
REF="main"
DRY_RUN=0
SHA=""
SHA7=""
IMAGE_TAG=""
PREV_IMAGE=""
PREV_SHA7=""
SMOKE_WHY=""
SERVICE_WHY=""
GATE_REFUSED=""
STEP="start"
REASON_PRINTED=0
AUDIT_WRITTEN=0
HEALTH="none"
HEALTH_MS=0
REPORTED_COMMIT=""
PLAIN_COMMIT=""
WINDOW_READS=0
# shellcheck disable=SC2034  # read by lib.sh's window_* functions
FIRST_AT=0
KICKSTART_T0=""

usage() { sed -n '2,/^set -eEuo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
say() { printf '%s deploy: %s\n' "$(window_stamp)" "$*"; }

audit() {
  mkdir -p "$STATE_DIR"
  printf '%s %s\n' "$(window_stamp)" "$*" >>"$AUDIT_LOG"
  AUDIT_WRITTEN=1
}

die() {
  if [ "$REASON_PRINTED" = 1 ]; then exit 1; fi
  REASON_PRINTED=1
  say "FAILED at ${STEP}: $* — nothing further will be started"
  audit "failed mode=${MODE} runtime=compose image=${IMAGE_TAG:-none} commit=${SHA7:-none} prev=${PREV_IMAGE:-none} step=${STEP} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} cause=$*"
  exit 1
}

# A death nobody explained still owes one line and one audit record (deploy.sh's rule).
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 2 ] && [ "$code" -ne 3 ]; then
    if [ "$REASON_PRINTED" != 1 ]; then
      REASON_PRINTED=1
      say "FAILED at ${STEP}: no reason recorded"
    fi
    if [ "$AUDIT_WRITTEN" != 1 ]; then
      audit "failed mode=${MODE} runtime=compose image=${IMAGE_TAG:-none} commit=${SHA7:-none} step=${STEP} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} cause=unexplained"
    fi
  fi
  lock_release
  return 0
}

# The one compose invocation shape: pinned project, pinned file, no host env file.
dc() { BOOK_IMAGE_TAG="$IMAGE_TAG" "$DOCKER" compose --env-file /dev/null -f "$COMPOSE_FILE" -p "$PROJECT" "$@"; }

# A command with a wall (a build that hangs must not hold a deploy forever).
bounded() { # (seconds, cmd…)
  local limit="$1" pid waited=0 code=0
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      say "bounded: ${limit}s spent — stopping pid $pid"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  wait "$pid" || code=$?
  return "$code"
}

sha7() { printf '%s' "${1:0:7}"; }

# OrbStack (measured on this box, Docker 29.8.2 / compose v5.5.0) can leave the LAN publish of a
# recreated container dead — the container is healthy and answers its own address, while
# `192.168.1.76:<port>` accepts and then never proxies. One `docker restart` re-registers it.
# The condition is narrow on purpose: the probe cannot CONNECT at all (curl exit != 0) and the
# container's own health says healthy. A site that answers 200 with the wrong commit is a real red
# and is never "fixed" this way.
rebind_if_unreachable() {
  local id="" state=""
  # Two negative reads ~400 ms apart: one refused connection can be transit during a recreate, and
  # restarting a healthy site for that would be the gate causing the flake it exists to catch.
  health_read "${SITE_URL}/healthz"
  [ "$R_OK" = 1 ] && return 0
  [ "$R_CODE" -ne 0 ] || return 0
  sleep 0.4
  health_read "${SITE_URL}/healthz"
  [ "$R_OK" = 1 ] && return 0
  [ "$R_CODE" -ne 0 ] || return 0
  id="$(dc ps -q site 2>/dev/null | head -n 1 || true)"
  [ -n "$id" ] || return 0
  state="$("$DOCKER" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
  [ "$state" = "healthy" ] || return 0
  say "the container is healthy but ${SITE_URL} cannot be reached (curl exit ${R_CODE}) — re-registering the publish with one restart"
  dc restart site >/dev/null 2>&1 || say "restart: refused"
  sleep 2
  return 0
}

# The image the running site container was started from, or nothing when the stack is down.
running_image() {
  local id=""
  id="$(dc ps -q site 2>/dev/null | head -n 1 || true)"
  [ -n "$id" ] || return 0
  "$DOCKER" inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true
}

# The bind source for `/locks` must exist before the first `up`, owned by this uid: Docker would
# otherwise create it as root, and the entrypoint (uid 501) could not write its own lock file —
# every service would exit 75 and the gate would report a red deploy for a permissions accident.
ensure_locks_dir() {
  local owner=""
  mkdir -p "$LOCKS_DIR" 2>/dev/null || die "cannot create $LOCKS_DIR — the containers run as uid 501 and must be able to write it"
  chmod 0755 "$LOCKS_DIR" 2>/dev/null || true
  owner="$(stat -c '%U' "$LOCKS_DIR" 2>/dev/null || stat -f '%Su' "$LOCKS_DIR" 2>/dev/null || echo unknown)"
  if [ "$owner" != "$(id -un)" ]; then
    die "$LOCKS_DIR is owned by '$owner', not '$(id -un)' (Docker created it as root on an earlier run) — remove it with 'sudo rm -rf $LOCKS_DIR' and re-run"
  fi
  say "locks: $LOCKS_DIR (0755, owner $owner)"
}

# The lock is the deploy's, except when a flip already holds it and runs this script as its child:
# re-taking it would make the flip refuse itself. `BOOK_LOCK_INHERITED=1` says so explicitly.
take_lock() {
  if [ "${BOOK_LOCK_INHERITED:-0}" = "1" ]; then
    LOCK="inherited"
    window_say "lock: inherited from the flip (pid ${BOOK_LOCK_HOLDER:-unknown}) — this run neither takes nor releases it"
    return 0
  fi
  lock_acquire
}

# Resolved in the caller's shell (a `die` inside a command substitution would only kill the
# subshell and leave the run with an empty sha and no reason).
resolve_ref() { # (ref) -> SHA, or 1
  local ref="$1" sha=""
  git -C "$ROOT" fetch --quiet --prune --tags origin || return 1
  sha="$(git -C "$ROOT" rev-parse --verify --quiet "origin/${ref}^{commit}" || true)"
  if [ -z "$sha" ]; then sha="$(git -C "$ROOT" rev-parse --verify --quiet "refs/tags/${ref}^{commit}" || true)"; fi
  if [ -z "$sha" ]; then sha="$(git -C "$ROOT" rev-parse --verify --quiet "${ref}^{commit}" || true)"; fi
  [ -n "$sha" ] || return 1
  SHA="$sha"
}

# Five HTTP reads a browser would notice: the poll, the опись, one chapter from the volume, the
# install manifest and the worker. `/api/state` and `/api/chapters` answer plain JSON (an object and
# an array, no `ok` envelope), so the shape is checked, not a wrapper.
smoke() {
  local code ct cc body
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${SITE_URL}/api/state" 2>/dev/null || true)"
  [ "$code" = "200" ] || { SMOKE_WHY="/api/state answered ${code:-nothing}"; return 1; }
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${SITE_URL}/api/chapters/1" 2>/dev/null || true)"
  if [ "$code" != "200" ]; then
    # An empty slot answers 404 `NOT_WRITTEN` (BOOK-137's reset empties the book): that still proves
    # the volume is mounted and the DB readable, and must not turn every deploy red.
    body="$(curl -sS --max-time 5 "${SITE_URL}/api/chapters/1" 2>/dev/null | head -c 200 || true)"
    case "$body" in
      *'"code":"NOT_WRITTEN"'*) say "smoke: /api/chapters/1 is NOT_WRITTEN (the book is empty — accepted)" ;;
      *) SMOKE_WHY="/api/chapters/1 answered ${code:-nothing}"; return 1 ;;
    esac
  fi
  body="$(curl -sS --max-time 5 "${SITE_URL}/api/chapters" 2>/dev/null | head -c 64 || true)"
  case "$body" in \[*) ;; *) SMOKE_WHY="/api/chapters is not a JSON array"; return 1 ;; esac
  ct="$(curl -sSI --max-time 5 "${SITE_URL}/manifest.webmanifest" 2>/dev/null | tr -d '\r' | sed -n 's/^[Cc]ontent-[Tt]ype: *//p' | head -n 1)"
  case "$ct" in *+json*) ;; *) SMOKE_WHY="/manifest.webmanifest content-type '${ct:-none}'"; return 1 ;; esac
  cc="$(curl -sSI --max-time 5 "${SITE_URL}/sw.js" 2>/dev/null | tr -d '\r' | sed -n 's/^[Cc]ache-[Cc]ontrol: *//p' | head -n 1)"
  case "$cc" in *no-cache*) ;; *) SMOKE_WHY="/sw.js cache-control '${cc:-none}'"; return 1 ;; esac
  return 0
}

# Old commit-tagged images are kept bounded: the running one + `KEEP_IMAGES` newest survive.
prune_images() {
  local tag="" index=0 drop=""
  local listing=""
  listing="$("$DOCKER" image ls "$IMAGE_REPO" --format '{{.CreatedAt}} {{.Tag}}' 2>/dev/null | sort -r | awk '{print $NF}')" || return 0
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    [ "$tag" = "<none>" ] && continue
    index=$(( index + 1 ))
    [ "$index" -le "$KEEP_IMAGES" ] && continue
    [ "${IMAGE_REPO}:${tag}" = "$IMAGE_TAG" ] && continue
    drop="${drop} ${tag}"
  done <<EOF
$listing
EOF
  for tag in $drop; do
    "$DOCKER" rmi "${IMAGE_REPO}:${tag}" >/dev/null 2>&1 && say "prune: removed ${IMAGE_REPO}:${tag}" || true
  done
}

# What each container really is, from the Docker engine — never from the site's own answer. One line
# per service in the deploy log; non-zero when a container is missing, is not `running`, or has a
# healthcheck that is not `healthy`. The writer has no healthcheck by design (a portless lane that
# idles 15 min), so `running` is its full contract.
service_states() {
  local name="" id="" state="" status="" health="" bad=0
  for name in site engine writer; do
    id="$(dc ps -q "$name" 2>/dev/null | head -n 1 || true)"
    if [ -z "$id" ]; then
      say "service ${name}: no container"
      bad=1
      continue
    fi
    state="$("$DOCKER" inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)"
    status="${state%% *}"
    health=""
    if [ "$state" != "$status" ]; then health="${state#* }"; fi
    say "service ${name}: ${status:-unknown}${health:+ ${health}} (container ${id:0:12})"
    case "$name:${status}:${health}" in
      "writer:running:") ;;
      "site:running:healthy") ;;
      "engine:running:healthy") ;;
      *) bad=1 ;;
    esac
  done
  return "$bad"
}

# One `up` with the health gate and the smokes. Returns 0 healthy, 1 "the gate is red and the
# evidence allows a rollback", 2 "not enough evidence — refused" (IFACE: two independent negatives),
# 3 "decisive container failure — roll back" (`up` failed, or a service is not running/healthy).
# A healthy site with a dead engine is not a green deploy: the site's own 200 cannot speak for the
# other two containers, so their state is read from the engine and it wins.
up_and_gate() { # (image tag, expected commit)
  local tag="$1" expect="$2" up_code=0 why=""
  IMAGE_TAG="$tag"
  STEP="up"
  dc up -d --wait --wait-timeout "$(( BUDGET_MS / 1000 ))" || up_code=$?
  STEP="services"
  if [ "$up_code" -ne 0 ]; then why="compose up exited ${up_code}"; fi
  if ! service_states; then why="${why:+${why}; }a service is not running/healthy"; fi
  if [ -n "$why" ]; then
    SERVICE_WHY="$why"
    say "services: ${why} — decisive, no window to wait for"
    return 3
  fi
  STEP="rebind"
  rebind_if_unreachable
  STEP="gate"
  KICKSTART_T0="$(now_ms)"
  window_settle "${SITE_URL}/healthz" "$expect" "$PREV_SHA7" "$KICKSTART_T0"
  case "$HEALTH" in
    fast) say "healthz ok after ${HEALTH_MS} ms (poll 200 ms, ${WINDOW_READS} reads) — ${REPORTED_COMMIT:-$expect}" ;;
    late) say "healthz ok LATE after ${HEALTH_MS} ms — ${expect} serves; no second restart" ;;
    *) say "healthz did not name ${expect} after ${HEALTH_MS} ms (budget ${BUDGET_MS} ms + grace ${GRACE_MS} ms, ${WINDOW_READS} reads)" ;;
  esac
  if [ "$HEALTH" != "fast" ] && [ "$HEALTH" != "late" ]; then
    # A second, independent read before anyone is restarted: the window alone is not a reason.
    STEP="evidence"
    plain_verdict "${SITE_URL}/healthz" "$expect" "$PREV_SHA7" 2 || true
    if ! rollback_allowed "$HEALTH_MS" "$BUDGET_MS" "$PLAIN_COMMIT" "$expect"; then
      GATE_REFUSED="$ROLLBACK_WHY"
      say "refused: ${ROLLBACK_WHY}"
      return 2
    fi
    return 1
  fi
  STEP="smoke"
  smoke || { say "smoke: ${SMOKE_WHY}"; return 1; }
  return 0
}

# The rollback: swap the tag, same gate, no rebuild.
rollback_to() { # (image tag, expected commit)
  local tag="$1" expect="$2"
  "$DOCKER" image inspect "$tag" >/dev/null 2>&1 || { say "rollback: ${tag} is not on disk"; return 1; }
  say "rollback: $tag (${expect})"
  PREV_SHA7=""
  up_and_gate "$tag" "$expect"
}

red() { # (why)
  local target="$PREV_IMAGE" target_commit="$PREV_SHA7" from="$IMAGE_TAG"
  STEP="rollback"
  say "red: $1"
  if [ -n "$target" ] && [ "$target" != "$IMAGE_TAG" ]; then
    if rollback_to "$target" "$target_commit"; then
      printf '%s\n' "$target" >"$LAST_GOOD_IMAGE"
      # `--rollback` checks the tree out at its target, so a red deploy must too: after it,
      # `git -C $ROOT HEAD` names the image that serves, not the commit this run failed on. A refused
      # checkout is a log line — never a reason to start another rollback.
      local target_sha="${target##*:}"
      if [ -d "$ROOT/.git" ] && git -C "$ROOT" rev-parse --verify --quiet "${target_sha}^{commit}" >/dev/null 2>&1; then
        git -C "$ROOT" checkout --quiet --detach "$target_sha" || say "checkout: refused after the rollback — the tree still names the failed commit; the previous image serves"
      else
        say "checkout: ${target_sha:0:7} is not in $ROOT — the tree still names the failed commit; the previous image serves"
      fi
      audit "rollback ok runtime=compose image=${target} commit=${target_commit} health=${HEALTH} health_ms=${HEALTH_MS} from=${from} cause=$1"
      REASON_PRINTED=1
      say "FAILED at ${STEP}: $1 — back on ${target}, which answers ${target_commit}; the new image is red"
      exit 1
    fi
    die "$1 — and the rollback to ${target} did not come up either; prod is NOT healthy, a human must look"
  fi
  die "$1 — there is no previous image to roll back to; prod is NOT healthy, a human must look"
}

# --- status (read-only) -------------------------------------------------------------------------
status() {
  say "runtime=compose project=$PROJECT file=$COMPOSE_FILE"
  dc ps || true
  health_read "${SITE_URL}/healthz"
  say "healthz: status=${R_STATUS} commit=${R_COMMIT:-none} err=${R_ERR:-none} ok=${R_OK} at ${SITE_URL}"
  local id="" image=""
  for name in site engine writer; do
    id="$(dc ps -q "$name" 2>/dev/null | head -n 1 || true)"
    [ -n "$id" ] || { say "$name: no container"; continue; }
    image="$("$DOCKER" inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true)"
    say "$name: container=${id:0:12} image=${image:-unknown}"
  done
  say "last-good-image: $(cat "$LAST_GOOD_IMAGE" 2>/dev/null || echo none)"
  say "previous-image: $(cat "$PREV_IMAGE_FILE" 2>/dev/null || echo none)"
}

# --- the run ------------------------------------------------------------------------------------
trap on_exit EXIT
trap 'fail_on_err ${LINENO} "$BASH_COMMAND"' ERR

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || { usage >&2; exit 2; }; REF="$2"; shift 2 ;;
    --root) [ $# -ge 2 ] || { usage >&2; exit 2; }; ROOT="$2"; shift 2 ;;
    --rollback) MODE="rollback"; shift ;;
    --status) MODE="status"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'compose-release: unknown argument %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# `--root` moves the tree the compose file is read from, unless BOOK_COMPOSE_FILE pinned it.
if [ -z "${BOOK_COMPOSE_FILE:-}" ]; then COMPOSE_FILE="${ROOT}/site/docker-compose.yml"; fi

if [ "$MODE" = "status" ]; then
  [ "$DRY_RUN" -eq 0 ] || { usage >&2; exit 2; }
  STEP="status"
  command -v curl >/dev/null 2>&1 || die "curl is not on PATH — the gate reads /healthz with it"
  "$DOCKER" version >/dev/null 2>&1 || die "docker is not available"
  status
  exit 0
fi

if [ "$MODE" = "rollback" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is not on PATH — the gate reads /healthz with it"
  # What the last deploy replaced. `last-good-image` is the fallback: it is the last image whose
  # gate passed, which is what an operator means when there is no recorded predecessor.
  ROLLBACK_IMAGE="$(cat "$PREV_IMAGE_FILE" 2>/dev/null || true)"
  CURRENT_IMAGE="$(running_image)"
  if [ -z "$ROLLBACK_IMAGE" ] || [ "$ROLLBACK_IMAGE" = "$CURRENT_IMAGE" ]; then
    ROLLBACK_IMAGE="$(cat "$LAST_GOOD_IMAGE" 2>/dev/null || true)"
  fi
  [ -n "$ROLLBACK_IMAGE" ] || die "nothing to roll back to: $PREV_IMAGE_FILE and $LAST_GOOD_IMAGE are empty"
  PREV_IMAGE="$ROLLBACK_IMAGE"
  ROLLBACK_SHA7="$(sha7 "${PREV_IMAGE##*:}")"
  SHA7="$ROLLBACK_SHA7"
  STEP="dry run"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "dry run: would roll back to ${PREV_IMAGE} (${ROLLBACK_SHA7}) and gate ${SITE_URL}/healthz for it"
    exit 0
  fi
  if [ "$ROLLBACK_IMAGE" = "$CURRENT_IMAGE" ]; then
    say "already serving ${ROLLBACK_IMAGE} — nothing to roll back"
    exit 0
  fi
  STEP="lock"
  take_lock
  ensure_locks_dir
  # The tree must match the image a flip-back would serve: an operator reading `git -C $ROOT HEAD`
  # after a rollback must see the code that answers, not the commit the rollback moved away from.
  STEP="checkout"
  ROLLBACK_SHA="${PREV_IMAGE##*:}"
  if [ -d "$ROOT/.git" ] && git -C "$ROOT" rev-parse --verify --quiet "${ROLLBACK_SHA}^{commit}" >/dev/null 2>&1; then
    git -C "$ROOT" checkout --quiet --detach "$ROLLBACK_SHA" || say "checkout: refused — the tree stays where it is; the image still serves"
    say "checkout: deploy root at $(sha7 "$ROLLBACK_SHA") (same code as the image)"
  else
    say "checkout: $(sha7 "$ROLLBACK_SHA") is not in $ROOT — the image still serves; the tree may be newer"
  fi
  STEP="rollback"
  # A rollback has no "previous build" of its own to classify as stale: the only identity that
  # matters is the one the target image carries.
  PREV_SHA7=""
  roll_code=0
  up_and_gate "$PREV_IMAGE" "$ROLLBACK_SHA7" || roll_code=$?
  if [ "$roll_code" -eq 0 ]; then
    printf '%s\n' "$PREV_IMAGE" >"$LAST_GOOD_IMAGE"
    rm -f "$PREV_IMAGE_FILE"
    say "rollback healthy: ${PREV_IMAGE} answers ${ROLLBACK_SHA7} at ${SITE_URL}: ${HEALTH_MS} ms of ${BUDGET_MS} ms; previous-image cleared (nothing to bounce back to)"
    audit "rollback ok mode=rollback runtime=compose image=${PREV_IMAGE} commit=${ROLLBACK_SHA7} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} lock=${LOCK}"
    exit 0
  fi
  die "the rollback to ${PREV_IMAGE} did not come up (health=${HEALTH}, ${HEALTH_MS} ms, ${WINDOW_READS} reads${GATE_REFUSED:+, refused: ${GATE_REFUSED}}); prod is NOT healthy, a human must look"
fi

STEP="dry run"
command -v git >/dev/null 2>&1 || die "git is not on PATH"
command -v curl >/dev/null 2>&1 || die "curl is not on PATH — the gate reads /healthz with it"
[ -d "$ROOT/.git" ] || die "deploy root $ROOT is not a git clone"
"$DOCKER" version >/dev/null 2>&1 || die "docker is not available"
dc version >/dev/null 2>&1 || die "the docker compose plugin is not available"

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry run: lock $(lock_report) — this run takes nothing"
  if ! resolve_ref "$REF"; then die "cannot resolve '$REF' in $ROOT"; fi
  say "dry run: would build ${IMAGE_REPO}:${SHA} (commit $(sha7 "$SHA"), timeout ${BUILD_TIMEOUT}s), record prev=$(running_image), up -d --wait, gate ${SITE_URL}/healthz for $(sha7 "$SHA") (budget ${BUDGET_MS} ms + grace ${GRACE_MS} ms), smoke 5 reads"
  exit 0
fi

# The lock is taken before the fetch and the checkout, exactly like deploy.sh: two runs must never
# flip one tree between `git checkout` and `docker build`.
STEP="prepare: lock"
take_lock

STEP="prepare: resolve"
if ! resolve_ref "$REF"; then die "cannot resolve '$REF' in $ROOT"; fi
SHA7="$(sha7 "$SHA")"
IMAGE_TAG="${IMAGE_REPO}:${SHA}"
PREV_IMAGE="$(running_image)"
PREV_SHA7="$(sha7 "${PREV_IMAGE##*:}")"

STEP="prepare: checkout"
git -C "$ROOT" checkout --quiet --detach "$SHA" || die "cannot check out ${SHA} in $ROOT"
say "target ${SHA7} (${REF}), image ${IMAGE_TAG}"

STEP="validate"
dc config -q || die "docker compose config is invalid"
ensure_locks_dir

STEP="build"
if bounded "$BUILD_TIMEOUT" env BOOK_BUILD_COMMIT="$SHA7" BOOK_IMAGE_TAG="$IMAGE_TAG" bash -c \
     "\"$DOCKER\" compose --env-file /dev/null -f \"$COMPOSE_FILE\" -p \"$PROJECT\" build site"; then
  say "built ${IMAGE_TAG}"
else
  die "the image build failed or exceeded ${BUILD_TIMEOUT}s — nothing was started"
fi

STEP="previous"
if [ -n "$PREV_IMAGE" ]; then printf '%s\n' "$PREV_IMAGE" >"$PREV_IMAGE_FILE"; fi
say "previous image: ${PREV_IMAGE:-none}${PREV_SHA7:+ (${PREV_SHA7})}"

gate_code=0
up_and_gate "$IMAGE_TAG" "$SHA7" || gate_code=$?
if [ "$gate_code" -eq 0 ]; then
  STEP="green"
  printf '%s\n' "$IMAGE_TAG" >"$LAST_GOOD_IMAGE"
  PERCENT=0
  if [ "$BUDGET_MS" -gt 0 ]; then PERCENT=$(( HEALTH_MS * 100 / BUDGET_MS )); fi
  say "healthy: ${IMAGE_TAG} at ${SITE_URL}; health=${HEALTH} ${HEALTH_MS} ms = ${PERCENT}% of ${BUDGET_MS} ms, ${WINDOW_READS} reads, lock=${LOCK}"
  audit "ok mode=deploy runtime=compose image=${IMAGE_TAG} commit=${SHA7} prev=${PREV_IMAGE:-none} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} smoke=ok lock=${LOCK}"
  prune_images
  exit 0
fi

if [ "$gate_code" -eq 2 ]; then
  # Refused for lack of evidence: restarting prod on one slow read is how a green deploy turns red.
  die "refused to roll back: ${GATE_REFUSED} — ${IMAGE_TAG} has not been seen serving ${SHA7}; prod may be degraded, a human must look"
fi

if [ "$gate_code" -eq 3 ]; then
  # Container state is decisive evidence on its own — it needs no window and no second read.
  red "the stack did not come up on ${IMAGE_TAG}: ${SERVICE_WHY}"
fi

red "the new image did not serve ${SHA7} at ${SITE_URL} (health=${HEALTH}, ${HEALTH_MS} ms of ${BUDGET_MS} ms${SMOKE_WHY:+, smoke: ${SMOKE_WHY}}) after ${WINDOW_READS} reads"
