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
#   * BOOK-187 AC12 + BOOK-217 — THE ORDER IS THE SAFETY: build, then the old writer is stopped
#     (`dc stop writer`, so it cannot recreate `writer/state.json` behind the cutover), then the
#     volume's home gate INSIDE the new image and BEFORE the first `up` (`bin/home-migrate.mjs
#     --apply`, then `bin/home-check.mjs`, as one-shot `dc run --no-deps` — no boot, so no DDL can
#     follow a refusal), then `up -d --wait`, the health gate with its smokes, then the same
#     `home-check` read once more (never `--apply` a second time). A volume the pre-up gate refuses
#     stops the deploy with the current stack still serving: nothing was started and nothing was
#     migrated, and the log says so. The old writer the cutover stopped is started again on the way
#     out (`WRITER_STOPPED` → `dc start writer` in the EXIT trap; the flag is cleared once `up` has
#     brought the stack back), so a refusal leaves the stack exactly as it was instead of a green
#     `/healthz` over a writing lane that stays down until the next deploy. A red post-up check takes
#     the recovery path below and `last-good` is not written. `--rollback` skips the gate on purpose,
#     because an image older than BOOK-187 does not carry the commands;
#   * BOOK-217 — THE RECOVERY IS DECIDED FROM ONE FACT: did the boot of the new image write a
#     pre-migration dump? `server/src/db/boot.ts` writes `backups/pre-v<from>-<stamp>.db` BEFORE any
#     DDL, and only when it is about to migrate — so ONE listing of `backups/` before `up` and ONE
#     after it is the whole fact: a name that was not there before and is there after is this run's
#     migration, and no new name means the boot ran no DDL. The volume marker is NOT a second signal:
#     the boot writes `.book-volume` with `flag:'wx'` and rewrites only a LEGACY marker, so `schema=`
#     is never refreshed after the first boot, and comparing it around `up` compares one number with
#     itself. Both listings are STATUS-CHECKED: a listing that failed is not "no migration", it is
#     `unknown`, and an unknown fact is never rounded to either — nothing is swapped, nothing is
#     restored, and `recovery: none` says a human must look. Migrated and the new image answers →
#     roll-forward: the previous image is NOT put back (it would refuse the future schema and
#     crash-loop), nothing is restarted, exit 1, `last-good` not written. Migrated and nothing serves
#     → the stack is STOPPED first (`dc stop site engine writer`, never `down -v`) and only then is
#     the pre-deploy dump copied over `book.db` inside the volume, then the ordinary image rollback.
#     A stop that fails is a refusal: `book.db` is not replaced and the run dies naming it, because a
#     v30 container could boot between the `mv` and the previous image's `up`, open the restored v29
#     file and migrate it straight BACK (the incident, produced by its own recovery), and a live
#     process would recreate `book.db-wal` beside the restored file. No migration → the ordinary
#     image rollback. Every failed run that reached `up` prints exactly one `recovery:` line
#     (`lib.sh:recovery_line`, four fixed sentences: roll-forward, dump-restore, image-rollback,
#     none) and audits `recovery=`. A failure before `up` has no migration and prints no such line;
#   * BOOK-217 — A MIGRATION IS RECORDED, so `--rollback` cannot walk into it: a run that migrated
#     (red or green) writes `$STATE_DIR/volume-migrated` with the `SCHEMA_VERSION` of the deployed
#     image, read from `git show <sha>:site/server/src/db/schema.ts` (`schema=unknown` when it cannot
#     be read; absent when nothing migrated). `--rollback` reads the record, reads the TARGET image's
#     constant the same way, and refuses (exit 1, no `up`, no gate) when the target understands an
#     older schema — an image swap onto a migrated volume is the incident. A successful dump-restore
#     removes the record (the volume is back on the old schema); an unknown or absent record keeps
#     today's behaviour and says so in one line;
#   * BOOK-217 — A CRASH LOOP IS THE RUN'S TO REPORT: each service's `RestartCount` is snapshotted
#     BEFORE the first `up` (a weeks-old count on a container the failed `up` never recreated is not
#     this run's loop), and after a decisive container failure or a failed health window a service is
#     reported only when its `State.Status` is `restarting`, `exited`, `dead` or `paused`, or when
#     its count grew: `CRASH LOOP: <service> restarted <n> time(s) <status> — the stack cannot boot;
#     prod is not serving` (also as `::error::` under GitHub Actions; the audit says `crashloop=1`).
#     A restarting container is never a 0, and an unchanged count is never a loop;
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
# BOOK-217: what a migrating deploy leaves for `--rollback` — `schema=<n>` or `schema=unknown`.
VOLUME_MIGRATED_FILE="${STATE_DIR}/volume-migrated"
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
# 1 while this run holds the writer down for the cutover and has not brought the stack up since. The
# writer is `restart: unless-stopped` in the compose file, so an explicit `dc stop` keeps it down
# until somebody deploys again: the flag is what `on_exit` reads to start it again on every refusal.
WRITER_STOPPED=0
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
# BOOK-217: the fact a recovery is decided from. `REACHED_UP` is 0 until this run issues its first
# `up` — a failure before it (build, pre-up gate, lock) has no migration and owes no recovery line.
REACHED_UP=0
# Tri-state: `1` the boot dumped before migrating, `0` no new dump, `unknown` a listing failed.
MIGRATED="unknown"
MIGRATION_DUMP=""
MIGRATION_WHY=""
DUMPS_BEFORE=""
# 1 once the pre-up listing of `backups/` was read successfully — the fact can only be known then.
DUMPS_KNOWN=0
# Why a dump restore did not happen, when it could not (the stop, the copy, the candidate).
RESTORE_WHY=""
# What the recovery did (`roll-forward` | `dump-restore` | `image-rollback` | `none`), for the audit.
RECOVERY_CHOICE=""
# 1 once a container is seen restarting (or its count grew), for the audit.
CRASHLOOP=0
# `name=count` per service, snapshotted before this run's `up`; a count that did not grow is old.
CRASH_BEFORE=""
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
  audit "failed mode=${MODE} runtime=compose image=${IMAGE_TAG:-none} commit=${SHA7:-none} prev=${PREV_IMAGE:-none} step=${STEP} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} recovery=${RECOVERY_CHOICE:-none} crashloop=${CRASHLOOP} cause=$*"
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
      audit "failed mode=${MODE} runtime=compose image=${IMAGE_TAG:-none} commit=${SHA7:-none} step=${STEP} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} recovery=${RECOVERY_CHOICE:-none} crashloop=${CRASHLOOP} cause=unexplained"
    fi
  fi
  # BOOK-217: the cutover stops the writer, and a refusal then never reaches the `up` that would
  # start it again. Starting it here (and only while the flag is still set) is what makes "a refusal
  # leaves the stack exactly as it was" true: the site keeps its green `/healthz` AND its passes run.
  writer_start
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

# BOOK-217: the schema version an image understands, read from the image's own constant in the repo
# at its commit (`site/server/src/db/schema.ts`). The deployed sha and an old image's tag are both
# commits in `$ROOT`, so the question is answered without starting anything; a read that fails is an
# empty answer, never a 0.
schema_of_commit() { # (sha) -> the SCHEMA_VERSION that commit carries, or nothing
  local sha="$1" source=""
  [ -n "$sha" ] || return 0
  source="$(git -C "$ROOT" show "${sha}:site/server/src/db/schema.ts" 2>/dev/null)" || return 0
  printf '%s\n' "$source" | sed -n 's/^export const SCHEMA_VERSION = \([0-9][0-9]*\);.*$/\1/p' | head -n 1 || true
  return 0
}

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

# --- the volume's home gate (BOOK-187 AC12, BOOK-217) -------------------------------------------
#
# The deploy that matters is the container one, and until this step nothing here read the volume's
# shape: a volume that served the pre-BOOK-187 image still holds `writer/state.json`, `writer/pre/`
# and `writer/transcripts/`, and the site would keep serving while every backup copied them.
#
# BOOK-217 moved the gate IN FRONT of the first `up`, and that is the whole point: the boot of the
# new image is what migrates the volume, so a gate that runs after `up` can only report a volume that
# has already been written to. Measured on `a424300`: the image booted, migrated the volume to v30,
# the home gate then refused two WAL sidecars of an allow-listed dump, the deploy rolled the IMAGE
# back to a v29 build that cannot open a v30 volume (`boot refused (SCHEMA_FUTURE)`), and prod
# answered 502 until a human deleted the sidecars. In front of `up` the same refusal stops a deploy
# whose current stack never stopped serving, and no DDL ever ran.
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
# A red command is a red deploy BEFORE green. Before `up` it is a `die` (nothing was started, nothing
# migrated, the old stack still serves). After `up` the cutover is NOT repeated — it already ran, and
# a second `--apply` would only hide the refusal — and the failure takes the recovery path.
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

# The writing lane this run stopped for the cutover, started again — on every path that did not
# reach the `up` that brings the whole stack back (`up_and_gate` clears the flag when it does, so a
# normal deploy never talks to the writer twice). A start that fails is said with the command an
# operator needs, never silent: the site would still answer `/healthz` while nothing writes.
writer_start() {
  [ "${WRITER_STOPPED:-0}" = "1" ] || return 0
  WRITER_STOPPED=0
  if dc start writer >/dev/null 2>&1; then
    say "home: the writer is started again — this run did not reach its up, so the stack is as it was"
  else
    say "home: the writer could not be started again — run 'docker compose start writer' by hand; the site answers but nothing writes"
  fi
  return 0
}

# The cutover, in the NEW image, BEFORE the stack is touched: `--apply` writes the volume, and a
# refusal here must land on a stack that is still serving.
home_gate_pre() {
  # BOOK-159/BOOK-187: the old writer may still be running against the volume and would recreate
  # `writer/state.json` between the cutover and `up`. Stop it first, exactly as the launchd driver
  # does (`writer_stop`). A stop that fails is said and NOT a refusal: the post-up check is the net.
  STEP="home: stop the writer"
  if dc stop writer; then
    WRITER_STOPPED=1
    say "home: stopped the old writer — nothing can recreate writer/state.json between the cutover and up"
  else
    say "home: the old writer could not be stopped — continuing; the post-up home-check is the net"
  fi
  STEP="home: before up"
  say "home: the volume's cutover in ${IMAGE_TAG}, BEFORE the stack is touched — bin/home-migrate.mjs --apply, then bin/home-check.mjs (BOOK-187 AC12)"
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

# The second read, kept as the check that the boot left the volume as the cutover made it. `--apply`
# never repeats: it already ran, and a second attempt would fail the same way and hide the reason.
home_check_post() {
  STEP="home: after up"
  say "home: the volume again in ${IMAGE_TAG} (the cutover ran before up; --apply is not repeated)"
  if ! home_run "home-check" bin/home-check.mjs --data-dir /data; then
    HOME_WHY="$HOME_FAILED"
    return 1
  fi
  say "home: ok — the boot left the volume as the cutover made it"
  return 0
}

# --- the migration fact, and the recovery it decides (BOOK-217) ---------------------------------
#
# The boot writes `backups/pre-v<from>-<stamp>.db` BEFORE any DDL (`server/src/db/boot.ts`), and only
# when it is about to migrate. That makes ONE listing of `backups/` before `up` and one after it the
# entire fact: a name that was not in the first and is in the second is this run's migration, and no
# new name means the boot ran no DDL. The volume marker is NOT a second signal — the boot writes
# `.book-volume` with `flag:'wx'` and rewrites only a legacy marker, so `schema=` is never refreshed
# after the first boot and comparing it around `up` compares one number with itself.
#
# Both listings are read with ONE-SHOT `sh` on the new image: `--entrypoint sh` and no service
# command means no boot, so reading around `up` can never migrate anything itself. Their STATUS is
# part of the answer: a listing that failed is `unknown`, never "no migration". (An after-read that
# failed would otherwise call a migrated volume unmigrated and put a v29 image on a v30 schema; a
# before-read that failed would make every pre-existing dump look new, and the "newest new" dump
# would be restored over the live book — silent data loss reported as success.)

# One `sh` on the site image and the volume. Its output is the answer; its status is the caller's.
volume_sh() { # (script)
  dc run --rm -T --no-deps --entrypoint sh site -c "$1" </dev/null 2>&1
}

# The pre-migration dumps in the volume, bare names, sorted. The names are filtered on THIS side of
# the pipe (`docker compose run` writes its own lifecycle lines into the same stream, and an
# unfiltered read would look like a volume that grew files it never grew), and an empty list is a
# real answer — but the one-shot's exit status is the caller's: an EXISTING `backups/` that cannot be
# listed returns 1 and says nothing at all about the volume, while an ABSENT `backups/` is an empty
# listing (the boot creates it only when it takes a dump).
volume_dumps() {
  local out=""
  out="$(volume_sh "if [ -d /data/backups ]; then ls -1 /data/backups 2>/dev/null; fi")" || return 1
  printf '%s\n' "$out" | grep -E '^pre-v.*[.]db$' | sort || true
  return 0
}

# Before `up`: what the volume looks like while it is still the previous image's.
migration_before() {
  STEP="migration: before"
  if DUMPS_BEFORE="$(volume_dumps)"; then
    DUMPS_KNOWN=1
    say "migration: before up — $(dump_count "$DUMPS_BEFORE") dump(s) in backups/"
  else
    DUMPS_BEFORE=""
    DUMPS_KNOWN=0
    say "migration: before up — backups/ could not be listed; whether the boot migrates will be unknown"
  fi
}

dump_count() {
  local n=0 line=""
  while IFS= read -r line; do [ -n "$line" ] && n=$(( n + 1 )); done <<EOF
${1:-}
EOF
  printf '%s' "$n"
}

# The `v<from>` in a boot dump's name (`pre-v29-20261029T085300Z.db`), empty when the name is not
# one the boot writes.
dump_from_version() {
  printf '%s\n' "$1" | sed -n 's/^pre-v\([0-9][0-9]*\)-.*$/\1/p' | head -n 1 || true
}

# After a failure that reached `up` (and on the green path): did the boot migrate? A new dump is the
# whole fact; a listing that failed either side is `unknown`, the state that refuses both an image
# swap and a restore.
migration_after() {
  local now_dumps="" name="" new="" from=""
  MIGRATED="unknown"; MIGRATION_DUMP=""; MIGRATION_WHY=""
  if [ "$DUMPS_KNOWN" != 1 ]; then
    MIGRATION_WHY="the listing of backups/ before up failed, so whether the boot migrated the volume cannot be known"
    say "migration: unknown — ${MIGRATION_WHY}"
    return 0
  fi
  if ! now_dumps="$(volume_dumps)"; then
    MIGRATION_WHY="the listing of backups/ after up failed, so whether the boot migrated the volume cannot be known"
    say "migration: unknown — ${MIGRATION_WHY}"
    return 0
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if printf '%s\n' "$DUMPS_BEFORE" | grep -Fxq -- "$name"; then continue; fi
    new="$name"
  done <<EOF
$now_dumps
EOF
  if [ -n "$new" ]; then
    MIGRATED=1
    MIGRATION_DUMP="$new"
    from="$(dump_from_version "$new")"
    if [ -n "$from" ]; then
      MIGRATION_WHY="the boot dumped v${from} before migrating (backups/${new})"
    else
      MIGRATION_WHY="the boot dumped the volume before migrating (backups/${new})"
    fi
    say "migration: the volume moved under this run — ${MIGRATION_WHY}"
    return 0
  fi
  MIGRATED=0
  MIGRATION_WHY="no new dump in backups/, so the boot ran no DDL"
  say "migration: none — ${MIGRATION_WHY}"
}

# Put the pre-deploy dump back over book.db, INSIDE the volume — with the stack STOPPED first.
#
# This is the part the incident's remedy got wrong: `restore_dump` must not rewrite `book.db` while
# the failed new image's containers are still up and crash-looping. A v30 container can boot between
# the `mv` and the previous image's `up`, open the restored v29 file and migrate it straight BACK to
# v30 (and then the previous image meets `SCHEMA_FUTURE` — the incident, produced by its own
# recovery), and a live process would recreate `book.db-wal` beside the restored file. So
# `dc stop site engine writer` comes first (`down -v` never: the volume is the book); a stop that
# fails is a refusal, because only the previous image's `up` may open the volume afterwards.
#
# `set -e` inside the one-shot makes a missing dump a hard failure: an image rollback over a migrated
# schema is the crash loop this exists to prevent, so a restore that cannot run must stop the run, not
# fall through to a swap. WAL and SHM go first, the copy lands under a temp name inside the
# allow-listed `backups/` (a `.restoring` file beside `book.db` would be a stray the home gate
# refuses) and is `mv`ed onto it; the dump stays where it was (the boot prunes to three of them).
restore_dump() {
  local code=0 out="" last=""
  RESTORE_WHY=""
  if [ -z "$MIGRATION_DUMP" ]; then
    RESTORE_WHY="no dump was named as this run's pre-migration dump, so nothing can be put back over book.db"
    say "restore: ${RESTORE_WHY}"
    return 1
  fi
  # Defence in depth: only a name that was absent from the SUCCESSFULLY-read before-list may be
  # restored. A name that was already there is somebody's older dump, not this run's.
  if printf '%s\n' "$DUMPS_BEFORE" | grep -Fxq -- "$MIGRATION_DUMP"; then
    RESTORE_WHY="backups/${MIGRATION_DUMP} was already in the volume before this run, so it is not this run's pre-migration dump; refusing to overwrite book.db with an old copy"
    say "restore: ${RESTORE_WHY}"
    return 1
  fi
  STEP="restore: stop"
  say "restore: stopping site engine writer (not down -v) — nothing may open book.db between the copy and the previous image's up"
  if ! dc stop site engine writer; then
    RESTORE_WHY="the stack could not be stopped, so book.db was not replaced"
    say "restore: ${RESTORE_WHY}"
    return 1
  fi
  # The whole stack is down on purpose now (nothing may open book.db until the previous image's
  # `up`), so this run no longer holds a cutover stop of its own: `on_exit` must not start the
  # writer alone against a stack that was stopped for the restore.
  WRITER_STOPPED=0
  STEP="restore"
  say "restore: backups/${MIGRATION_DUMP} over book.db, inside the volume (one-shot sh, no boot)"
  out="$(volume_sh "set -e
test -f /data/backups/${MIGRATION_DUMP}
rm -f /data/book.db-wal /data/book.db-shm
cp /data/backups/${MIGRATION_DUMP} /data/backups/.book.db.restoring
mv /data/backups/.book.db.restoring /data/book.db
printf 'restored %s\n' backups/${MIGRATION_DUMP}")" || code=$?
  if [ "$code" -ne 0 ]; then
    RESTORE_WHY="the copy of backups/${MIGRATION_DUMP} over book.db failed (exit ${code})"
    say "restore: ${RESTORE_WHY}: $(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -n 1)"
    return 1
  fi
  # The one-shot's own marker, not the last line of a stream that also carries `docker compose`'s
  # lifecycle noise (measured: it prints `Container … Creating` on the same stream).
  last="$(printf '%s\n' "$out" | grep -E '^restored ' | tail -n 1 || true)"
  # The volume is back on the pre-deploy schema: the record a `--rollback` reads no longer applies.
  rm -f "$VOLUME_MIGRATED_FILE"
  say "restore: ${last:-done} — the volume is back on the pre-deploy schema and ${VOLUME_MIGRATED_FILE##*/} is cleared"
  return 0
}

# --- what the engine says about a stack that cannot boot (BOOK-217) ------------------------------
#
# The gate reads what the site answers; a container that keeps dying is invisible to that and to a
# human who was not watching. The engine's own record is the evidence: `State.Status` and
# `RestartCount`, per service. The count is a WATERMARK, not a report: a container that has been
# restarting for weeks carries that count onto a failed `up` that never recreated it, so each `up`
# snapshots the count first and only growth — or a status that is dead/restarting — is this run's
# loop. An unchanged count on a running container says nothing and is not a 0 either.

crash_loop_before() {
  local name="" id="" restarts=""
  CRASH_BEFORE=""
  for name in site engine writer; do
    id="$(dc ps -q "$name" 2>/dev/null | head -n 1 || true)"
    [ -n "$id" ] || continue
    restarts="$("$DOCKER" inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || true)"
    is_number "$restarts" || restarts=0
    CRASH_BEFORE="${CRASH_BEFORE} ${name}=${restarts}"
  done
  say "crash loop baseline:${CRASH_BEFORE:- no container of this stack is running}"
}

# The count snapshotted before this run's `up` for one service, 0 when none was read.
crash_before_of() { # (service)
  local name="$1" pair=""
  for pair in $CRASH_BEFORE; do
    case "$pair" in
      "$name="*) printf '%s' "${pair#"${name}="}"; return 0 ;;
    esac
  done
  printf '0'
}

# Statuses that are a crash loop on their own, whatever the count says.
CRASHED_STATUSES=" restarting exited dead paused "

crash_loop_check() {
  local name="" id="" status="" restarts="" before=""
  for name in site engine writer; do
    id="$(dc ps -q "$name" 2>/dev/null | head -n 1 || true)"
    [ -n "$id" ] || continue
    status="$("$DOCKER" inspect -f '{{.State.Status}}' "$id" 2>/dev/null || true)"
    restarts="$("$DOCKER" inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || true)"
    is_number "$restarts" || restarts=0
    before="$(crash_before_of "$name")"
    case "$CRASHED_STATUSES" in
      *" ${status} "*) crash_loop_line "$name" "$restarts" "$status"; continue ;;
    esac
    if [ "$restarts" -gt "$before" ]; then crash_loop_line "$name" "$restarts" "$status"; fi
  done
  return 0
}

crash_loop_line() { # (service, restarts, status)
  local line="CRASH LOOP: ${1} restarted ${2} time(s) ${3:-unknown} — the stack cannot boot; prod is not serving"
  CRASHLOOP=1
  say "$line"
  # The workflow reads `::error::` as a failed step annotation: the alarm is the run, not a human
  # noticing a 502 two minutes later.
  if [ -n "${GITHUB_ACTIONS:-}" ]; then printf '::error::%s\n' "$line"; fi
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
  # BOOK-217: from here the volume may be migrated by the boot — a failure past this point owes a
  # recovery line, and one before it does not. The restart counts are snapshotted here too, so a
  # weeks-old count on a container this `up` never recreated cannot be reported as this run's loop.
  REACHED_UP=1
  crash_loop_before
  dc up -d --wait --wait-timeout "$(( BUDGET_MS / 1000 ))" || up_code=$?
  # The stack is up, so the writer stopped for the cutover is running again under its own restart
  # policy: the flag that would send `on_exit` after it is cleared here, once, and never twice.
  if [ "$up_code" -eq 0 ]; then WRITER_STOPPED=0; fi
  STEP="services"
  if [ "$up_code" -ne 0 ]; then why="compose up exited ${up_code}"; fi
  if ! service_states; then why="${why:+${why}; }a service is not running/healthy"; fi
  if [ -n "$why" ]; then
    SERVICE_WHY="$why"
    say "services: ${why} — decisive, no window to wait for"
    crash_loop_check
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
    # BOOK-217: a failed window is exactly where a crash-looping container hides — the engine's own
    # restart record is read before the verdict is accepted.
    crash_loop_check
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

# --- the migration record a `--rollback` reads (BOOK-217) ---------------------------------------
#
# A deploy that migrated leaves the fact on the host, with the schema the new image understands. An
# old image put on that volume would refuse the boot (`SCHEMA_FUTURE`) and crash-loop — the incident
# — so `--rollback` asks before it starts anything. The number comes from the image's own constant in
# the repo at its commit; a read that fails is never a 0.

# The record a migrating run leaves: `schema=<n>`, or `schema=unknown` when the constant cannot be
# read (the record then says "migrated, schema unknown" and `--rollback` keeps today's behaviour
# rather than inventing a number).
record_volume_migrated() {
  local schema=""
  [ "$MIGRATED" = 1 ] || return 0
  schema="$(schema_of_commit "${SHA:-${IMAGE_TAG##*:}}")"
  mkdir -p "$STATE_DIR"
  printf 'schema=%s\n' "${schema:-unknown}" >"$VOLUME_MIGRATED_FILE"
  say "volume-migrated: recorded schema=${schema:-unknown} in ${VOLUME_MIGRATED_FILE} — --rollback will refuse an image that predates it"
}

# The guard `--rollback` runs before its `up` and its gate. An image that understands an older schema
# than the record names is refused with nothing started; an absent or unreadable record keeps today's
# behaviour and says so in one line.
volume_migrated_guard() { # (target image tag)
  local target="$1" recorded="" target_schema=""
  if [ ! -f "$VOLUME_MIGRATED_FILE" ]; then
    say "volume-migrated: no record at ${VOLUME_MIGRATED_FILE} — nothing says a deploy moved the volume, so the image swap proceeds as usual (a migration this host did not record cannot be ruled out)"
    return 0
  fi
  recorded="$(sed -n 's/^schema=//p' "$VOLUME_MIGRATED_FILE" | head -n 1 || true)"
  if ! is_number "$recorded"; then
    say "volume-migrated: the record says schema=${recorded:-nothing}, not a number — the volume was migrated but its schema is unknown, so the image swap proceeds as usual"
    return 0
  fi
  target_schema="$(schema_of_commit "${target##*:}")"
  if ! is_number "$target_schema"; then
    say "volume-migrated: the volume is at schema v${recorded}; ${target} carries no readable SCHEMA_VERSION, so the image swap proceeds as usual"
    return 0
  fi
  if [ "$target_schema" -lt "$recorded" ]; then
    die "the volume is at schema v${recorded} (a deploy migrated it) and ${target} understands v${target_schema} — an image swap would refuse the schema and crash-loop; restore a dump instead: the volume dump restore is the deploy's own path (or an explicit operator restore of a dump into the volume ${DATA_VOLUME}; site/deploy/restore-drill.sh restores into a scratch copy and never touches the volume), and ${VOLUME_MIGRATED_FILE} is the record that must be deleted to override this refusal deliberately; nothing was started and nothing was rolled back"
  fi
  say "volume-migrated: the volume is at schema v${recorded} and ${target} understands v${target_schema} — the image swap is safe"
}

# The failed release: one recovery line, and exactly one of the four outcomes (BOOK-217).
#
# The fact comes first — did the boot write a pre-migration dump? — because it decides what a
# rollback would mean. On a migrated volume the previous image cannot boot (`SCHEMA_FUTURE`), so
# putting it back is how a red deploy becomes a 502; when the new image answers, it keeps serving
# instead (degraded but alive), when nothing answers the dump is the way back, and when the fact could
# not be read nothing is touched at all.
red() { # (why)
  local target="$PREV_IMAGE" target_commit="$PREV_SHA7" from="$IMAGE_TAG" serving=0 choice=""
  STEP="rollback"
  say "red: $1"
  if [ "$REACHED_UP" = 1 ]; then
    STEP="migration: after"
    migration_after
    STEP="rollback"
  fi
  # A migrated volume is a fact a later `--rollback` must see, whatever this run decides next.
  if [ "$MIGRATED" = 1 ]; then record_volume_migrated; fi
  case "$HEALTH" in fast|late) serving=1 ;; *) serving=0 ;; esac
  # BOOK-217: on a decisive container failure (`up` exited non-zero, a service is not up) the health
  # window never ran, so `HEALTH=none` is the ABSENCE of a measurement, not evidence that nothing
  # serves. A container can restart inside `up -d --wait` (exactly what the wait trips on) and the
  # new image be answering by the time it is read: deciding `dump-restore` from that silence stops
  # the stack, puts the pre-migration dump over every write since it, and brings the previous image
  # back — while the rule says migrated + answering is a roll-forward. One plain read, the same call
  # the launchd driver makes, and only when the run really reached `up`: no new window, no restart.
  if [ "$REACHED_UP" = 1 ] && [ "$serving" = 0 ]; then
    STEP="evidence"
    plain_verdict "${SITE_URL}/healthz" "$SHA7" "$PREV_SHA7" 2 || true
    if names_commit "$PLAIN_COMMIT" "$SHA7"; then serving=1; fi
    STEP="rollback"
  fi
  if [ "$REACHED_UP" = 1 ]; then
    choice="$(recovery_choice "$MIGRATED" "$serving")"
    RECOVERY_CHOICE="$choice"
  fi
  if [ "$choice" = "none" ]; then
    # The fact is unknown: an image swap on a volume that may have migrated is the crash loop, and a
    # restore on a volume that may not have is an old copy over the live book. Touch nothing.
    say "$(recovery_line none "$MIGRATION_WHY")"
    die "$1 — the migration fact is unknown (${MIGRATION_WHY}), so no image was swapped and no dump was restored; a human must look"
  fi
  if [ "$choice" = "roll-forward" ]; then
    # The new image answers and the volume already moved: the previous image would refuse the schema
    # and take prod down with it. Nothing is swapped, nothing is restarted, and it is not green.
    say "$(recovery_line "$choice" "$MIGRATION_WHY")"
    STEP="roll-forward"
    audit "roll-forward runtime=compose image=${from} commit=${SHA7:-none} prev=${PREV_IMAGE:-none} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} recovery=${choice} crashloop=${CRASHLOOP} cause=$1"
    REASON_PRINTED=1
    say "FAILED at ${STEP}: $1 — ${from} keeps serving (degraded); last-good was not written, a human must look"
    exit 1
  fi
  if [ "$choice" = "dump-restore" ]; then
    # The line is printed only once the dump is really over book.db: it says the dump was restored,
    # so a restore that could not run (the stop, the copy) must not carry it — it dies below with
    # `recovery: none` and the reason, and nothing is recovered.
    if ! restore_dump; then
      RECOVERY_CHOICE="none"
      say "$(recovery_line none "$RESTORE_WHY")"
      die "$1 — ${RESTORE_WHY}; no older image was put back, so nothing was recovered — a human must look"
    fi
    say "$(recovery_line "$choice" "$MIGRATION_WHY")"
  else
    say "$(recovery_line "$choice" "$MIGRATION_WHY")"
  fi
  if [ -n "$target" ] && [ "$target" != "$IMAGE_TAG" ]; then
    if rollback_to "$target" "$target_commit"; then
      printf '%s\n' "$target" >"$LAST_GOOD_IMAGE"
      audit "rollback ok runtime=compose image=${target} commit=${target_commit} health=${HEALTH} health_ms=${HEALTH_MS} from=${from} recovery=${RECOVERY_CHOICE:-none} crashloop=${CRASHLOOP} cause=$1"
      REASON_PRINTED=1
      say "FAILED at ${STEP}: $1 — back on ${target}, which answers ${target_commit}; the new image is red"
      exit 1
    fi
    die "$1 — and the rollback to ${target} did not come up either; $(serving_now) — a human must look"
  fi
  if [ "$choice" = "dump-restore" ]; then
    # The volume was put back on the pre-deploy schema but there is no image to run on it: say so
    # loudly instead of leaving an operator to guess what the volume holds now.
    die "$1 — the pre-deploy dump was restored over book.db, but there is no previous image to run on it; prod is NOT healthy, a human must look"
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
    # BOOK-217: the guard is read-only (a file and `git show`), so a dry run runs it too — an
    # operator must see the refusal a real `--rollback` would meet, not a plan built on a target the
    # volume would refuse. `deploy.sh` refuses on its dry-run path for the same reason.
    STEP="rollback: volume guard"
    volume_migrated_guard "$PREV_IMAGE"
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
  # BOOK-217: a volume a deploy migrated is not one an older image may serve — the record is asked
  # before anything is started, and a target that understands an older schema is refused here.
  STEP="rollback: volume guard"
  volume_migrated_guard "$PREV_IMAGE"
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
  say "dry run: would build ${IMAGE_REPO}:${SHA} (commit $(sha7 "$SHA"), timeout ${BUILD_TIMEOUT}s)"
  say "dry run: then, BEFORE the first up and in that image on the volume, dc run --rm -T --no-deps --entrypoint node site bin/home-migrate.mjs --apply, then ... bin/home-check.mjs --data-dir /data — a volume it refuses stops the deploy before any DDL, with the current stack still serving"
  say "dry run: then record prev=$(running_image), up -d --wait, gate ${SITE_URL}/healthz for $(sha7 "$SHA") (budget ${BUDGET_MS} ms + grace ${GRACE_MS} ms), smoke 5 reads, then bin/home-check.mjs once more (never --apply again)"
  say "dry run: a red one picks one of four (did the boot dump? is the image serving? could backups/ be listed?): roll-forward (no image swap, last-good not written), dump-restore (stop site engine writer FIRST, then backups/pre-v*.db over book.db, then the previous image), image-rollback (no new dump: no migration ran), none (the fact is unknown — nothing swapped, nothing restored); one recovery: line and crashloop= in the audit, one volume-migrated record when the volume moved, exit 1"
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

# BOOK-217: the volume is judged BEFORE the stack is touched. The new image is only read with a
# one-shot `dc run` (no boot, so no DDL), and a refusal here leaves the current stack serving and
# says so — the deploy that produced the 502 never got this far.
if ! home_gate_pre; then
  die "$HOME_WHY — the deploy stopped before any DDL: nothing was started and nothing was migrated"
fi

# What the volume looks like while it is still the previous image's: the fact the recovery is
# decided from is the difference after `up`.
migration_before

gate_code=0
up_and_gate "$IMAGE_TAG" "$SHA7" || gate_code=$?
if [ "$gate_code" -eq 0 ]; then
  # BOOK-217: the second read of the volume, kept as the check that the boot left it as the cutover
  # made it. `--apply` is not repeated: it already ran, before `up`, and a second attempt could only
  # fail the same way and hide the reason. A red one takes the recovery path, `last-good` is not
  # written.
  if ! home_check_post; then
    red "the home gate is red on ${IMAGE_TAG}: ${HOME_WHY}"
  fi
  # BOOK-217: a GREEN deploy that migrated is still a migrated volume — the fact is read here too and
  # recorded, so a later `--rollback` cannot put an older image on it. An unknown fact (a listing
  # that failed after the boot) is not green-rollbacked either: it says so and writes no record.
  STEP="migration: after"
  migration_after
  record_volume_migrated
  if [ "$MIGRATED" = "unknown" ]; then
    say "volume-migrated: the fact is unknown (${MIGRATION_WHY}) — no record was written, so --rollback keeps its usual behaviour and cannot rule a migration out"
  fi
  STEP="green"
  printf '%s\n' "$IMAGE_TAG" >"$LAST_GOOD_IMAGE"
  PERCENT=0
  if [ "$BUDGET_MS" -gt 0 ]; then PERCENT=$(( HEALTH_MS * 100 / BUDGET_MS )); fi
  say "healthy: ${IMAGE_TAG} at ${SITE_URL}; health=${HEALTH} ${HEALTH_MS} ms = ${PERCENT}% of ${BUDGET_MS} ms, ${WINDOW_READS} reads, lock=${LOCK}"
  audit "ok mode=deploy runtime=compose image=${IMAGE_TAG} commit=${SHA7} prev=${PREV_IMAGE:-none} health=${HEALTH} health_ms=${HEALTH_MS} budget_ms=${BUDGET_MS} migrated=${MIGRATED} smoke=ok lock=${LOCK}"
  prune_images
  exit 0
fi

if [ "$gate_code" -eq 2 ]; then
  # Refused for lack of evidence: restarting prod on one slow read is how a green deploy turns red.
  # BOOK-217: this run reached `up` and refuses to roll back, so it still owes the fact and exactly
  # one `recovery:` line — nothing was rolled back and nothing was restored: `none`. A migrated
  # volume is recorded all the same, so a later `--rollback` cannot walk into it.
  STEP="migration: after"
  migration_after
  record_volume_migrated
  STEP="refused"
  RECOVERY_CHOICE="none"
  say "$(recovery_line none "$MIGRATION_WHY")"
  die "refused to roll back: ${GATE_REFUSED} — ${IMAGE_TAG} has not been seen serving ${SHA7}; prod may be degraded, a human must look"
fi

if [ "$gate_code" -eq 3 ]; then
  # Container state is decisive evidence on its own — it needs no window and no second read.
  red "the stack did not come up on ${IMAGE_TAG}: ${SERVICE_WHY}"
fi

red "the new image did not pass the gate on ${SHA7} at ${SITE_URL} (health=${HEALTH}, ${HEALTH_MS} ms of ${BUDGET_MS} ms${SMOKE_WHY:+, smoke: ${SMOKE_WHY}}) after ${WINDOW_READS} reads"
