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
#   * a rollback swaps the IMAGE, not the tree: the compose file is packaging and always comes from
#     the deployed release, so `--rollback`/`red()` never check the deploy root out at the image's sha
#     (measured: a pre-container commit makes `docker compose` read the old single-service file and
#     the rollback never runs). `flip.sh --to launchd` is the only place that moves the tree, because
#     launchd serves the tree;
#   * images are immutable and commit-tagged (`book:<40-char sha>`), never `latest`; the image that
#     served before the last release is kept on disk and its tag is recorded in
#     `$STATE_DIR/previous-image` (`$STATE_DIR/last-good-image` records the last image whose gate
#     passed), so `--rollback` is one `up -d` with no rebuild;
#   * a health gate with a fixed budget (`BOOK_HEALTH_TIMEOUT`, default 180 s) and a grace window
#     (`BOOK_HEALTH_GRACE`, 60 s), polling `/healthz` for the commit the IMAGE carries; a rollback
#     needs two independent negatives (`lib.sh:rollback_allowed`), never one slow read;
#   * a bounded image build (`BOOK_BUILD_TIMEOUT`, 1200 s);
#   * BOOK-187 AC12: once the new image is up and healthy, the volume is cut over INSIDE that image
#     (`bin/home-migrate.mjs --apply`, then `bin/home-check.mjs`) and only then may the run be called
#     green. It is safe here — `up -d --wait` already replaced the old writer and the new one writes no
#     files — and a red one takes the ordinary rollback path: `last-good` is not written. `--rollback`
#     skips it on purpose, because an image older than BOOK-187 does not carry the commands;
#   * THE GATE DOES NOT RACE THE WRITER (BOOK-159): no `npm`, no node on the HOST, no manuscript
#     check and no host process against the data dir run here — Docker and curl only, and the one
#     node that runs (the home gate) runs in a container, on the same volume, one kernel. The full
#     test suite is CI's (gate.yml); the deploy's own gate is the container health gate, five HTTP
#     reads, the volume's home gate and, when the host carries a usable OAuth client id, the sign-in
#     redirect (BOOK-205);
#   * the data dir is the named volume `${BOOK_DATA_VOLUME:-book-data}`, never a host bind (BOOK-183):
#     a volume without `book.db` is refused with a named reason BEFORE anything is built or started, and
#     a rollback does not run either — a stack on an empty volume is a 500, not a deploy. Only a
#     one-shot `-v <volume>:/v:ro` is used to READ it (the same volume, inside the VM: one kernel).
#   * `/locks` (the entrypoint's single-instance lock dir) is created here if it is missing, owned by
#     this uid and 0755 — Docker would create the bind source as root and every service would exit 75.
#   * the sign-in pair (BOOK-205) is mounted as two files, and Docker turns an absent source into an
#     empty directory: the deploy removes such a directory under `${BOOK_SECRETS_DIR:-./secrets}`
#     before the build and refuses a non-empty one by name, so dropping the 0600 file in stays the
#     documented switch and no release ships red because of the other shape.
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
# BOOK-183: the store is the volume; `/backups` is the only host bind for state and this script creates
# its source (Docker would create it as root, and the container runs as uid 501).
DATA_VOLUME="${BOOK_DATA_VOLUME:-book-data}"
BACKUPS_DIR="${BOOK_BACKUPS_DIR:-$HOME/book-site-backups}"

# BOOK-205: the host directory the compose file mounts each secret from (`${BOOK_SECRETS_DIR:-./secrets}`
# there, and compose resolves a relative one against the compose file's own directory). The sign-in smoke
# only asks whether ONE name there is a usable file (`yandex_client_id`); no value is read and no path
# other than that name is printed.
secrets_dir() {
  local dir="${BOOK_SECRETS_DIR:-./secrets}" base=""
  case "$dir" in
    /*) printf '%s' "$dir" ;;
    *) base="$(dirname "$COMPOSE_FILE")"
       # A compose file that is not on disk has no secrets dir: an empty answer, never a failed `cd`.
       [ -d "$base" ] || return 0
       printf '%s/%s' "$(cd "$base" && pwd)" "${dir#./}" ;;
  esac
}

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
HOME_WHY=""
# BOOK-205: 1 while the gate is judging an image that is going back into service (an automatic rollback
# inside a red deploy, or `--rollback`). Only then may the sign-in read pass instead of refusing.
ROLLING_BACK=0
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

# The `/backups` bind source must exist and be writable by the container's uid (501), or the nightly
# backup writes nothing. Same shape as `ensure_locks_dir`.
ensure_backups_dir() {
  local owner=""
  mkdir -p "$BACKUPS_DIR" 2>/dev/null || die "cannot create $BACKUPS_DIR — the backup runs inside the container (uid 501) and must be able to write it"
  owner="$(stat -c '%U' "$BACKUPS_DIR" 2>/dev/null || stat -f '%Su' "$BACKUPS_DIR" 2>/dev/null || echo unknown)"
  if [ "$owner" != "$(id -un)" ]; then
    die "$BACKUPS_DIR is owned by '$owner', not '$(id -un)' — fix it with 'sudo chown -R $(id -un) $BACKUPS_DIR' and re-run"
  fi
  say "backups: $BACKUPS_DIR (owner $owner)"
}

# BOOK-205: the sign-in pair is mounted per file, and Docker creates an absent bind SOURCE as a
# directory — so one `up` on a host without OAuth leaves `${SECRETS_DIR}/yandex_client_id` as a
# directory and the operator's next `cp` lands inside it, which makes the documented "put the file
# there" switch impossible. The empty directory is the no-OAuth shape and is removed here; a non-empty
# one is a named refusal before anything is built. The two names are printed by name, never a value.
ensure_signin_mounts() {
  local dir="" name="" path=""
  dir="$(secrets_dir)"
  [ -n "$dir" ] || return 0
  for name in yandex_client_id yandex_client_secret; do
    path="${dir}/${name}"
    [ -d "$path" ] || continue
    if rmdir "$path" 2>/dev/null; then
      say "secrets: removed the empty directory Docker left at ${path} — put the 0600 ${name} file there to turn sign-in on"
      continue
    fi
    die "${path} is a directory, not the 0600 file — remove it with 'sudo rm -rf ${path}' and put the ${name} file in place; nothing was built and nothing was rolled back"
  done
}

# BOOK-183: the release never seeds and never starts on an empty volume. Both are named refusals with
# exit 1, and by then nothing has been built, started or rolled back.
data_volume_preflight() {
  local image=""
  STEP="preflight: volume"
  "$DOCKER" volume inspect "$DATA_VOLUME" >/dev/null 2>&1 \
    || die "the data volume ${DATA_VOLUME} does not exist — seed it once with site/deploy/migrate-to-volume.sh (BOOK-183); nothing was started and nothing was rolled back"
  image="${BOOK_PROBE_IMAGE:-}"
  [ -n "$image" ] || image="$(cat "$LAST_GOOD_IMAGE" 2>/dev/null || true)"
  [ -n "$image" ] || image="$(running_image)"
  # Last resort: the newest image of this repo on disk. A first release after a migration has no
  # recorded last-good yet, and the volume still has to be read before anything is built.
  [ -n "$image" ] || image="$("$DOCKER" image ls "$IMAGE_REPO" --format '{{.CreatedAt}} {{.Repository}}:{{.Tag}}' 2>/dev/null | sort -r | awk 'NF > 1 && $NF !~ /:<none>$/ { print $NF; exit }')"
  if [ -z "$image" ]; then
    die "no image on disk to read volume ${DATA_VOLUME} with (last-good-image and the running site are both empty); nothing was started and nothing was rolled back"
  fi
  "$DOCKER" run --rm --entrypoint sh -v "$DATA_VOLUME":/v:ro "$image" -c 'test -f /v/book.db' >/dev/null 2>&1 \
    || die "volume ${DATA_VOLUME} holds no book.db — the stack would serve 500s, so it was not started (seed it with site/deploy/migrate-to-volume.sh or 'site/deploy/flip.sh --to compose'); nothing was started and nothing was rolled back"
  say "volume: ${DATA_VOLUME} (holds book.db; read with ${image})"
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

# BOOK-205: sign-in. A host whose `yandex_client_id` is a USABLE file says the operator configured
# OAuth, so `/auth/yandex/start` must send the browser to Yandex — a 503 there is `OAUTH_UNCONFIGURED`
# and the release would ship with nobody able to sign in (the measured prod state). "Usable" is the
# rule `configSecrets.ts` reads as "sign-in off": absent, a directory (what Docker mounts for an absent
# bind source), empty, or unreadable — a touched 0-byte file must not strand a release. A host with no
# credential has sign-in off by design (ADR-021) and this check says nothing. Names only: no value is
# read, the redirect is never printed.
signin_smoke() {
  local file="" reply="" code="" location=""
  file="$(secrets_dir)/yandex_client_id"
  [ -f "$file" ] && [ -s "$file" ] && [ -r "$file" ] || return 0
  # `%{redirect_url}` is the `location` a 302 carries, read without following it.
  reply="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 "${SITE_URL}/auth/yandex/start" 2>/dev/null || true)"
  code="${reply%% *}"
  location="${reply#* }"
  if [ "$code" != "302" ]; then
    SMOKE_WHY="sign-in is off although the host carries the client id (/auth/yandex/start answered ${code:-nothing}, not 302)"
    return 1
  fi
  case "$location" in
    *oauth.yandex.ru/authorize*) return 0 ;;
  esac
  SMOKE_WHY="/auth/yandex/start does not redirect to oauth.yandex.ru/authorize"
  return 1
}

# Five HTTP reads a browser would notice: the poll, the опись, one chapter from the volume, the
# install manifest and the worker. `/api/state` and `/api/chapters` answer plain JSON (an object and
# an array, no `ok` envelope), so the shape is checked, not a wrapper. Plus the conditional sign-in
# read (BOOK-205): it only speaks when the host carries the OAuth client id.
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
  # BOOK-205, last and separate: sign-in is a different contract from the five reads above, and a
  # rollback exists to get the book serving again. `ROLLING_BACK` — set for an automatic rollback and
  # for `--rollback` — is what keeps this read from refusing one; the compose file mounts the same two
  # files for any image, so an older image with sign-in off is never a reason to reject the swap back.
  if ! signin_smoke; then
    if [ "$ROLLING_BACK" = "1" ]; then
      say "smoke: ${SMOKE_WHY} — accepted on a rollback (the book serves)"
      SMOKE_WHY=""
      return 0
    fi
    return 1
  fi
  return 0
}

# --- the volume's home gate (BOOK-187 AC12) -----------------------------------------------------
#
# The deploy that matters is the container one, and until this step nothing here read the volume's
# shape: a volume that served the pre-BOOK-187 image still holds `writer/state.json`, `writer/pre/`
# and `writer/transcripts/`, and the site would keep serving while every backup copied them.
#
# The order is safe in a way the launchd path's is not: `dc up -d --wait` has ALREADY replaced the
# old writer container, and the new writer writes no files at all (BOOK-187) — there is no old lane
# left to stop, so the cutover can run here, after the image is up and before green is recorded.
#
# Both commands run INSIDE the new image, on the same volume, with the service's own environment
# (`DATA_DIR=/data`): one kernel, the reader SQLite expects (BOOK-183), and the code that is about
# to be recorded as last-good. `--entrypoint node` is deliberate — the image's entrypoint is the
# per-role single-instance lock wrapper (`deploy/entrypoint.sh`), which is for the long-running
# role; a one-shot CLI must not take that lock (and would exit 75 on it). `--no-deps` keeps
# `dc run` from starting the engine behind a check. `home-check` is given the volume only — the
# image carries no book tree since BOOK-187, and a missing `manuscript/` is the normal state
# there, not a finding.
#
# A red command is a red deploy BEFORE green, and it goes through the existing rollback path: the
# migration is idempotent and refuses anything it cannot name, so a second attempt would fail the
# same way and hide the reason.
HOME_FAILED="the volume holds something it may not (every path above is named) — run bin/home-migrate.mjs --apply once"

# One one-shot CLI on the site image and the volume. Output is streamed (the operator reads the
# path home-check prints) and the last non-empty line is repeated as one `home:` line, because a red
# deploy is read from the audit and the log, not from a wall of container output.
home_run() { # (label, argv…)
  local label="$1" log code=0 last=""
  shift
  log="$(mktemp "${TMPDIR:-/tmp}/book-home-XXXXXX")"
  # `-T` and `</dev/null`: a `run` that attaches stdin would keep the deploy's own input open (or
  # consume it in CI) and can hang; nothing interactive belongs in a gate.
  dc run --rm -T --no-deps --entrypoint node site "$@" </dev/null 2>&1 | tee "$log" || code=$?
  if [ "$code" -ne 0 ]; then
    last="$(sed '/^[[:space:]]*$/d' "$log" | tail -n 1)"
    say "home: ${label} exited ${code}: ${last:-no output}"
  fi
  rm -f "$log"
  return "$code"
}

home_gate() {
  STEP="home"
  say "home: the volume's cutover in ${IMAGE_TAG} — bin/home-migrate.mjs --apply, then bin/home-check.mjs (BOOK-187 AC12)"
  if ! home_run "home-migrate --apply" bin/home-migrate.mjs --apply; then
    HOME_WHY="bin/home-migrate.mjs --apply refused (its last line is above); the old writer's files are still in the volume"
    return 1
  fi
  # No `--manuscript`: the image carries no book tree (BOOK-187) and a missing `manuscript/`
  # passes by design — the volume is the only home of the text.
  if ! home_run "home-check" bin/home-check.mjs --data-dir /data; then
    HOME_WHY="$HOME_FAILED"
    return 1
  fi
  say "home: ok — the volume holds the book and its dumps and nothing else"
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

# What answers right now, for a failure line. A failed rollback does not imply a dead prod: the stack
# may still be serving the image that was already running (the rollback `up` can fail before it
# touches anything), and the difference decides what a human does next.
serving_now() {
  health_read "${SITE_URL}/healthz"
  if [ "$R_OK" = 1 ]; then
    printf 'prod still answers %s at %s' "${R_COMMIT:-no commit}" "${SITE_URL}"
  else
    printf 'prod answers nothing at %s (curl exit %s, status %s)' "${SITE_URL}" "${R_CODE}" "${R_STATUS}"
  fi
}

# The rollback: swap the tag, same gate, no rebuild — and a rollback swaps the IMAGE, not the tree.
# The compose file is packaging and must come from the deployed release; checking the root out at a
# pre-BOOK-172 commit would make `docker compose` read the old single-service file (measured: an
# `env_file: .env` the clone does not have) and the rollback would never happen.
rollback_to() { # (image tag, expected commit)
  local tag="$1" expect="$2"
  "$DOCKER" image inspect "$tag" >/dev/null 2>&1 || { say "rollback: ${tag} is not on disk"; return 1; }
  say "rollback: $tag (${expect})"
  # BOOK-205: from here on the gate judges an image that is going back into service, not a release, so
  # the sign-in read reports instead of refusing — an automatic rollback must not become red because of
  # a check that has nothing to do with the book being served.
  ROLLING_BACK=1
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
      audit "rollback ok runtime=compose image=${target} commit=${target_commit} health=${HEALTH} health_ms=${HEALTH_MS} from=${from} cause=$1"
      REASON_PRINTED=1
      say "FAILED at ${STEP}: $1 — back on ${target}, which answers ${target_commit}; the new image is red"
      exit 1
    fi
    die "$1 — and the rollback to ${target} did not come up either; $(serving_now) — a human must look"
  fi
  die "$1 — there is no previous image to roll back to; prod is NOT healthy, a human must look"
}

# --- status (read-only) -------------------------------------------------------------------------
status() {
  say "runtime=compose project=$PROJECT file=$COMPOSE_FILE"
  say "data-volume: ${DATA_VOLUME}"
  dc ps || true
  health_read "${SITE_URL}/healthz"
  say "healthz: status=${R_STATUS} commit=${R_COMMIT:-none} err=${R_ERR:-none} ok=${R_OK} at ${SITE_URL}"
  # What /data really is inside the running site: the type and source from the container's own mount
  # table. `btrfs /dev/vdb1` is the volume; `virtiofs mac` would be a host bind, which the entrypoint
  # now refuses (BOOK-183) — so this line is the positive proof, not the guard.
  local id="" image=""
  for name in site engine writer; do
    id="$(dc ps -q "$name" 2>/dev/null | head -n 1 || true)"
    [ -n "$id" ] || { say "$name: no container"; continue; }
    image="$("$DOCKER" inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true)"
    say "$name: container=${id:0:12} image=${image:-unknown}"
    if [ "$name" = "site" ]; then
      data_mount="$("$DOCKER" exec "$id" sh -c "grep ' /data ' /proc/self/mountinfo | head -n 1" 2>/dev/null || true)"
      say "site /data: ${data_mount:-no mountinfo entry for /data (is the container up?)}"
    fi
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
  ensure_backups_dir
  # A rollback swaps the image; the data it serves must already be there.
  data_volume_preflight
  # The tree must match the image a flip-back would serve: an operator reading `git -C $ROOT HEAD`
  # after a rollback must see the code that answers, not the commit the rollback moved away from.
  STEP="rollback"
  # A rollback has no "previous build" of its own to classify as stale: the only identity that
  # matters is the one the target image carries.
  PREV_SHA7=""
  # BOOK-205: what `rollback_to()` sets for an automatic rollback — this path must never be refused
  # because the older image answers 503 on sign-in.
  ROLLING_BACK=1
  roll_code=0
  up_and_gate "$PREV_IMAGE" "$ROLLBACK_SHA7" || roll_code=$?
  if [ "$roll_code" -eq 0 ]; then
    printf '%s\n' "$PREV_IMAGE" >"$LAST_GOOD_IMAGE"
    rm -f "$PREV_IMAGE_FILE"
    say "rollback healthy: ${PREV_IMAGE} answers ${ROLLBACK_SHA7} at ${SITE_URL}: ${HEALTH_MS} ms of ${BUDGET_MS} ms; previous-image cleared (nothing to bounce back to)"
    audit "rollback ok mode=rollback runtime=compose image=${PREV_IMAGE} commit=${ROLLBACK_SHA7} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} lock=${LOCK}"
    exit 0
  fi
  die "the rollback to ${PREV_IMAGE} did not come up (health=${HEALTH}, ${HEALTH_MS} ms, ${WINDOW_READS} reads${GATE_REFUSED:+, refused: ${GATE_REFUSED}}); $(serving_now) — a human must look"
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
  say "dry run: then, in that image on the volume, dc run --rm -T --no-deps --entrypoint node site bin/home-migrate.mjs --apply, then ... bin/home-check.mjs --data-dir /data; a red one rolls back and last-good is not written"
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
ensure_backups_dir
# BOOK-205: before the build, so a stray directory at a mount source is a named refusal and not a
# release that ships with sign-in silently off.
ensure_signin_mounts
data_volume_preflight

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
  # BOOK-187 AC12: the stack is up on the new image and healthy; the volume is cut over by that
  # image before the run may be called green. A red one takes the same rollback path as any gate:
  # the cutover is idempotent, so a silent retry would only repeat a refusal.
  if ! home_gate; then
    red "the home gate is red on ${IMAGE_TAG}: ${HOME_WHY}"
  fi
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
