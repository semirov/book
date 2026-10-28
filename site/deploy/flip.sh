#!/bin/bash
# flip.sh — the one command that moves prod between the two runtimes (BOOK-172), and the one that
# moves it back. It is deliberately NOT part of a deploy: a deploy ships an image, a flip changes
# which runtime owns 192.168.1.76:8091.
#
#   site/deploy/flip.sh --to compose --ref main --confirm   # launchd -> containers
#   site/deploy/flip.sh --to launchd --confirm              # containers -> launchd (the fallback)
#   site/deploy/flip.sh --to compose --dry-run              # print the plan, take no lock, touch nothing
#
# Precondition, not a step: the container path is proven green BEFORE anything is unloaded — by a
# rehearsal of the same stack under `-p book-rehearsal` on a spare port, against a copy of the data
# dir made by `backup.sh`. The flip then runs the same build and the same health gate on prod; a
# failure restores launchd and leaves `runtime` untouched, so the deploy workflow keeps using it.
#
# Order inside `--to compose` is the safety: a fresh consistent backup is required, the writer lane
# stops first (no pass in flight), then the site and the engine, then the old container that holds
# 8090 is removed, then `compose-release.sh` builds and gates the new image. `launchctl disable` runs
# only after a green gate, so nothing is permanently unloaded on a failed flip.
#
# ONE LOCK FOR THE WHOLE FLIP. A confirmed flip takes the same `$STATE_DIR/deploy.lock` the deploy
# driver uses and holds it from the first `bootout` to the last check — otherwise a workflow deploy
# could start in that window, read `runtime=launchd`, `kickstart` the site and take 8091 back. The
# lock is handed to `compose-release.sh` through `BOOK_LOCK_INHERITED=1` (it must not take the lock
# a second time and refuse itself); a flip that finds the lock held exits 3 and touches nothing.
#
# `--to launchd` is the documented fallback for one deploy cycle: `compose down` (images and the data
# dir stay), the deploy root is aligned to the commit of `$STATE_DIR/last-good-image` (launchd serves
# the TREE, the containers serve the IMAGE — a rollback never moves the tree, so this is the one place
# that does), the three plists come back with `launchctl enable` + `bootstrap`, and `/healthz` on 8091
# must answer AND name the commit the deploy root is checked out at — a 200 from a stale launchd build
# is not the fallback working, so the two are compared and a disagreement is a failure.
#
# THE DATA DIR IS A VOLUME (BOOK-183). `--to compose` serves from the named volume
# `${BOOK_DATA_VOLUME:-book-data}`, so a first flip SEEDS it from the host dir
# (`migrate-to-volume.sh --seed-only`: stack down, copy, integrity + row counts) and refuses to start
# containers on a volume with no `book.db`. `--to launchd` goes the other way: launchd runs the tree
# over the host data dir, so before any bootstrap the volume is EXPORTED back to it (stack down, one
# one-shot copy whose row counts are read back ON THE HOST and compared with the volume's) — that
# one-way export is what keeps the fallback data-compatible, and a failed export is exit 1 with nothing
# bootstrapped. The host path is never opened by two kernels: every copy is made by a container, and
# the host dir is only read by launchd while the containers are down.
#
# Requires: launchctl (macOS; `BOOK_LAUNCHCTL` overrides the binary so a test can stub it), docker +
# compose, a full backup under $BACKUP_ROOT/daily newer than $BOOK_BACKUP_MAX_AGE_S (default 3600 s).
# The lock dir (`BOOK_LOCKS_DIR`, default ~/.local/state/book-locks) is created here, owned by the
# invoking user and 0755: Docker would create the bind source as root, and then every container's
# entrypoint (uid 501) could not write its lock and would exit 75. Prints no secret.
#
# Exit codes: 0 flipped and verified; 1 a flip failed (the previous runtime has been brought back and
# `runtime` is untouched, or nothing serves and a human must look); 3 the deploy lock is held — another
# deploy owns it and nothing was stopped or started; 4 the container path is green and `runtime` stays
# `compose`, but a `launchctl disable` was refused — the exact commands to run are printed on stdout
# (a job left enabled lets `deploy.sh` boot it back and a second engine could be resurrected on 8091).
set -eEuo pipefail

# The lock primitives are the deploy's own (BOOK-119 hotfix): one lock, one refusal shape (exit 3).
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

ROOT="${BOOK_DEPLOY_ROOT:-$HOME/book-deploy}"
STATE_DIR="${BOOK_STATE_DIR:-${HOME}/.local/state/book-deploy}"
RUNTIME_FILE="${STATE_DIR}/runtime"
# Read by lib.sh's lock_* functions.
# shellcheck disable=SC2034
LOCK_DIR="${STATE_DIR}/deploy.lock"
COMPOSE_FILE="${BOOK_COMPOSE_FILE:-${ROOT}/site/docker-compose.yml}"
PROJECT="${BOOK_PROJECT:-book}"
DOCKER="${BOOK_DOCKER:-docker}"
LCTL="${BOOK_LAUNCHCTL:-launchctl}"
LOCKS_DIR="${BOOK_LOCKS_DIR:-$HOME/.local/state/book-locks}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/book-site-backups}"
BACKUP_MAX_AGE="${BOOK_BACKUP_MAX_AGE_S:-3600}"
SITE_BIND="${BOOK_SITE_PUBLISH:-192.168.1.76:8091}"
SITE_URL="${BOOK_SITE_URL:-http://${SITE_BIND%:*}:${SITE_BIND##*:}}"
HEALTH_TIMEOUT="${BOOK_HEALTH_TIMEOUT:-180}"
JOBS="dev.book-site dev.book-engine dev.book-writer"
# BOOK-183: the volume the container runtime serves from, and the host dir the launchd runtime serves
# from (the tree's own data dir, the default the plists carry).
DATA_VOLUME="${BOOK_DATA_VOLUME:-book-data}"
HOST_DATA_DIR="${BOOK_HOST_DATA_DIR:-$HOME/book-site-data}"
# The row counts both sides of an export are compared on.
EXPORT_COUNTS_SQL="SELECT 'chapters='||(SELECT count(*) FROM chapters)||' blocks='||(SELECT count(*) FROM blocks)||' changes='||(SELECT count(*) FROM changes)||' comments='||(SELECT count(*) FROM comments);"

TO=""
REF="main"
CONFIRM=0
DRY_RUN=0

say() { printf '%s flip: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf '%s flip: FAILED: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }
dc() { "$DOCKER" compose --env-file /dev/null -f "$COMPOSE_FILE" -p "$PROJECT" "$@"; }

domain() { printf 'gui/%s' "$(id -u)"; }

# launchctl's grammar, not ours: `bootout <domain>/<service>`, `bootstrap <domain> <plist>`. Getting
# these two backwards is silent (launchctl just refuses), so the shape lives in one place.
via() { # (verb, target)
  local verb="$1" target="$2" d
  d="$(domain)"
  case "$verb" in
    bootstrap) "$LCTL" bootstrap "$d" "$target" ;;
    *) "$LCTL" "$verb" "$d/$target" ;;
  esac
}

# Always release the flip's lock, on every path — including the refusal paths after it is taken.
trap 'lock_release' EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --to) [ $# -ge 2 ] || die "--to needs compose|launchd"; TO="$2"; shift 2 ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) sed -n '2,/^set -eEuo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

case "$TO" in compose|launchd) ;; *) die "--to compose|launchd is required" ;; esac

# --- what a flip needs, checked before anything is touched ---------------------------------------
require() {
  command -v "$LCTL" >/dev/null 2>&1 || die "$LCTL is not on PATH — this is a macOS prod flip"
  "$DOCKER" version >/dev/null 2>&1 || die "docker is not available"
  dc version >/dev/null 2>&1 || die "the docker compose plugin is not available"
  [ -f "$COMPOSE_FILE" ] || die "no compose file at $COMPOSE_FILE"
}

# A flip changes where the book lives: no fresh backup, no flip. The check is a name and an age, not
# a body — the backup script owns its own contents.
require_fresh_backup() {
  local newest="" age=0 now mtime=0
  now="$(date +%s)"
  # An absent or empty `daily/` is the documented refusal, not a `find` failure: under `set -eE` with
  # `pipefail` a bare pipeline here aborted the whole flip before the `die` below could speak.
  if [ -d "$BACKUP_ROOT/daily" ]; then
    newest="$(find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort | tail -n 1 || true)"
  fi
  [ -n "$newest" ] || die "no backup under $BACKUP_ROOT/daily — run site/deploy/backup.sh first"
  # GNU first, BSD second. The order is not cosmetic: on GNU coreutils `stat -f` means "filesystem
  # status", so `%m` is taken as a FILE NAME and the directory's filesystem report goes to stdout —
  # `$(( ))` then read `File:` as an arithmetic variable and the script died with `File: unbound
  # variable` before every flip assertion (the Gate runner, Debian). BSD `stat -c` fails with no
  # stdout, so the other order is quiet on macOS. Whatever comes back is validated as digits, so no
  # future tool output can reach the arithmetic at all.
  mtime="$(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest" 2>/dev/null || echo 0)"
  case "$mtime" in ''|*[!0-9]*) mtime=0 ;; esac
  age=$(( now - mtime ))
  [ "$age" -le "$BACKUP_MAX_AGE" ] || die "the newest backup ($(basename "$newest")) is ${age}s old (limit ${BACKUP_MAX_AGE}s) — run site/deploy/backup.sh first"
  say "backup: $(basename "$newest") is ${age}s old (limit ${BACKUP_MAX_AGE}s)"
}

# The lock directory must exist, be ours, and be writable by uid 501 (the containers' user). Left to
# Docker, the bind source is created as root and every entrypoint exits 75 on its own lock file.
ensure_locks_dir() {
  local owner=""
  mkdir -p "$LOCKS_DIR" 2>/dev/null || die "cannot create $LOCKS_DIR — the containers run as uid 501 and must be able to write it"
  chmod 0755 "$LOCKS_DIR" 2>/dev/null || true
  owner="$(stat -c '%U' "$LOCKS_DIR" 2>/dev/null || stat -f '%Su' "$LOCKS_DIR" 2>/dev/null || echo unknown)"
  if [ "$owner" != "$(id -un)" ]; then
    die "$LOCKS_DIR is owned by '$owner', not '$(id -un)' (Docker created it as root on an earlier run) — remove it with 'sudo rm -rf $LOCKS_DIR' and re-run, or every service exits 75"
  fi
  say "locks: $LOCKS_DIR (0755, owner $owner)"
}

# 8091 answering /healthz: the only read that says "something serves the book" here.
health() { curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "${SITE_URL}/healthz" 2>/dev/null || true; }
# Same rule as `health`: a read that cannot be made is an answer ("no commit"), never an exit —
# under `set -eE` + `pipefail` a bare pipeline here killed the flip before it said a word.
health_commit() { curl -sS --max-time 2 "${SITE_URL}/healthz" 2>/dev/null | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' || true; }

wait_up() { # (seconds) -> 0 when /healthz answers 200
  local limit="$1" waited=0
  while [ "$waited" -lt "$limit" ]; do
    [ "$(health)" = "200" ] && return 0
    sleep 1
    waited=$(( waited + 1 ))
  done
  return 1
}

wait_down() { # (seconds) -> 0 when nothing answers on 8091
  local limit="$1" waited=0
  while [ "$waited" -lt "$limit" ]; do
    [ "$(health)" = "200" ] || return 0
    sleep 1
    waited=$(( waited + 1 ))
  done
  return 1
}

# MAJOR (BOOK-183): the export writes $HOST_DATA_DIR from a container. If a launchd job still runs against
# that dir, the copy races its writer and the counts compare a moving target. `containers_gone` only
# speaks for the containers. Two independent proofs, either one enough: every job is not running
# (`launchctl print`), or nothing answers on 8091 for 10 s.
launchd_not_serving() {
  local job="" label="" out=""
  for job in $JOBS; do
    label="$(domain)/$job"
    # A job that is not loaded makes `print` fail, which is the answer this check wants.
    if out="$("$LCTL" print "$label" 2>&1)"; then
      case "$out" in
        *"state = running"*) say "$label is still running (launchctl print: state = running)"; return 1 ;;
      esac
    fi
  done
  # `print` gave no running job; still prove nothing serves 8091, which is what a stale bootstrap looks
  # like from the outside.
  wait_down 10
}

containers_gone() { # (seconds) -> 0 when the project has no container left
  local limit="$1" waited=0 ids=""
  while [ "$waited" -lt "$limit" ]; do
    ids="$(dc ps -q 2>/dev/null | tr -d '[:space:]' || true)"
    [ -z "$ids" ] && return 0
    sleep 1
    waited=$(( waited + 1 ))
  done
  return 1
}

write_runtime() { mkdir -p "$STATE_DIR"; printf '%s\n' "$1" >"$RUNTIME_FILE"; say "runtime=${1} recorded in $RUNTIME_FILE"; }

# --- the volume (BOOK-183) -----------------------------------------------------------------------
#
# The image every one-shot copy and every check runs from. `BOOK_IMAGE_TAG` (set by a release, or by a
# rehearsal) wins; otherwise the last image whose gate passed. It is never built here.
probe_image() {
  local img=""
  if [ -n "${BOOK_IMAGE_TAG:-}" ]; then printf '%s' "$BOOK_IMAGE_TAG"; return 0; fi
  img="$(cat "$STATE_DIR/last-good-image" 2>/dev/null || true)"
  printf '%s' "${img:-book:dev}"
}

volume_has_db() { # (volume) -> 0 when a container can see /v/book.db inside it
  local vol="$1"
  "$DOCKER" volume inspect "$vol" >/dev/null 2>&1 || return 1
  "$DOCKER" run --rm --entrypoint sh -v "$vol":/v:ro "$(probe_image)" -c 'test -f /v/book.db' >/dev/null 2>&1
}

# First flip, or a rehearsal: the volume has no DB, the host dir does. Seed it with the migration's own
# `--seed-only` under the flip's lock, and re-read the result — a seed that claims success and leaves no
# `book.db` must not reach `compose-release`.
seed_volume() {
  local migrate
  migrate="$(dirname "$0")/migrate-to-volume.sh"
  [ -f "$migrate" ] || { say "no migrate-to-volume.sh beside this flip — cannot seed volume ${DATA_VOLUME}"; return 1; }
  [ -f "$HOST_DATA_DIR/book.db" ] || { say "$HOST_DATA_DIR has no book.db and volume ${DATA_VOLUME} has none either — refusing to start containers on an empty volume"; return 1; }
  say "volume ${DATA_VOLUME}: seeding from $HOST_DATA_DIR (stop -> seed -> verify, --seed-only)"
  BOOK_LOCK_INHERITED=1 BOOK_LOCK_HOLDER="$$" BOOK_DATA_VOLUME="$DATA_VOLUME" \
    BOOK_HOST_DATA_DIR="$HOST_DATA_DIR" BOOK_IMAGE_TAG="$(probe_image)" \
    /bin/bash "$migrate" --from "$HOST_DATA_DIR" --volume "$DATA_VOLUME" --seed-only || return 1
  volume_has_db "$DATA_VOLUME"
}

# The volume's four counts, read INSIDE a container on that volume (the only reader that may open it).
# JSON, so `counts_agree` can compare it with the host `sqlite3` line.
volume_row_counts() { # (volume) -> '{"chapters":N,…}'
  "$DOCKER" run --rm --user 501:20 --entrypoint node -w /app -v "$1":/vol "$(probe_image)" -e '
    const D = require("better-sqlite3");
    const db = new D("/vol/book.db");
    const r = db.prepare("SELECT (SELECT count(*) FROM chapters) chapters, (SELECT count(*) FROM blocks) blocks, (SELECT count(*) FROM changes) changes, (SELECT count(*) FROM comments) comments").get();
    db.close();
    console.log(JSON.stringify(r));
  '
}

# The host copy's counts. Read-WRITE on purpose: launchd is stopped, the file is the fallback's own, and a
# read-only open of a WAL database needs the live `-shm` — the checkpoint below is what a read-only open
# would need anyway. The journal mode is NOT touched here (launchd keeps serving WAL).
host_row_counts() { # (db path) -> "chapters=N blocks=N changes=N comments=N"
  sqlite3 "$1" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  sqlite3 "$1" "$EXPORT_COUNTS_SQL"
}

# The fallback's data must be the volume's data. Stack down; the copy is made by a container into the
# host dir (the ONLY writer of that path), converted to a self-contained DELETE journal, and the row
# counts of the export are read back on the HOST — a container-side read cannot tell a real bind from a
# shadow (measured) — and must equal the volume's. Nothing is bootstrapped unless every one holds.
export_volume() {
  local image host_counts vol_counts
  image="$(probe_image)"
  "$DOCKER" volume inspect "$DATA_VOLUME" >/dev/null 2>&1 || { say "no volume ${DATA_VOLUME} to export — refusing to bootstrap launchd on stale host data"; return 1; }
  volume_has_db "$DATA_VOLUME" || { say "volume ${DATA_VOLUME} holds no book.db — refusing to bootstrap launchd on stale host data"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || { say "sqlite3 is not on PATH — the exported copy cannot be counted on the host side"; return 1; }
  # The bind source is NOT moved aside and recreated: measured on this box, a container started on a
  # just-recreated bind path writes into a shadow — `ls` inside the container shows the files and the
  # host directory stays empty. So the export copies IN PLACE, and the proof below reads the host file.
  mkdir -p "$HOST_DATA_DIR" || { say "cannot create $HOST_DATA_DIR"; return 1; }
  say "exporting volume ${DATA_VOLUME} -> $HOST_DATA_DIR (one-shot copy, nothing else is running)"
  "$DOCKER" run --rm -u 0 --entrypoint sh -v "$DATA_VOLUME":/from:ro -v "$HOST_DATA_DIR":/to "$image" -c '
    set -e
    # The destination is a fresh copy that nothing else owns: a journal left there by an earlier open
    # (a `-wal` from launchd, a `-journal`, a `-shm`) would be overlaid onto the incoming pages. Drop
    # them BEFORE the copy, then take the -wal of the source itself as data.
    rm -f /to/book.db-wal /to/book.db-shm /to/book.db-journal
    cp -a /from/. /to/
    rm -f /to/book.db-shm
    chown -R 501:20 /to
  ' || { say "the copy out of volume ${DATA_VOLUME} failed — the host dir may now be partial; nothing was bootstrapped"; return 1; }

  # The proof is read from the HOST side on purpose: a container-side read cannot tell a real bind
  # (above) from the shadow. The host read is a COPY with nothing else opened on it — the stack is
  # down — and it also does the one conversion launchd needs: a self-contained DELETE-journal file
  # (the app sets WAL again at boot), with the -wal, if any, checkpointed into it first.
  host_counts="$(sqlite3 "$HOST_DATA_DIR/book.db" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" >/dev/null 2>&1 \
    && sqlite3 -readonly "$HOST_DATA_DIR/book.db" "PRAGMA integrity_check;" \
    && sqlite3 -readonly "$HOST_DATA_DIR/book.db" "$EXPORT_COUNTS_SQL")" \
    || { say "the exported DB at $HOST_DATA_DIR/book.db is not readable on the host (a shadowed bind?) — nothing was bootstrapped"; return 1; }
  rm -f "$HOST_DATA_DIR/book.db-wal" "$HOST_DATA_DIR/book.db-shm"
  case "$host_counts" in
    ok*) ;;
    *) say "integrity_check on the exported copy: ${host_counts%%$'\n'*} — nothing was bootstrapped"; return 1 ;;
  esac
  host_counts="$(printf '%s\n' "$host_counts" | tail -n 1)"

  vol_counts="$(volume_row_counts "$DATA_VOLUME")" \
    || { say "reading volume ${DATA_VOLUME} for the comparison failed — nothing was bootstrapped"; return 1; }

  if ! counts_agree "$host_counts" "$vol_counts"; then
    say "the export does not match volume ${DATA_VOLUME}: host ${host_counts} vs volume ${vol_counts} — nothing was bootstrapped"
    return 1
  fi
  say "export verified: host ${host_counts} == volume ${vol_counts}, integrity ok; the host dir is the fallback's data"
}

# The two counts as one comparable shape: the host `sqlite3` prints `key=value` pairs separated by
# spaces, the container prints a JSON object. Same pairs, same values, or the export is not the volume.
counts_agree() { # (host "chapters=N blocks=N …", volume '{"chapters":N,…}')
  local host_side volume_side
  host_side="$(printf '%s\n' "$1" | tr ' ' '\n' | sed '/^$/d' | sort)"
  volume_side="$(printf '%s\n' "$2" | tr -d '{}"' | tr ',' '\n' | sed 's/^ *//; s/ *$//; s/:/=/' | sed '/^$/d' | sort)"
  [ -n "$host_side" ] && [ "$host_side" = "$volume_side" ]
}

# --- to compose -----------------------------------------------------------------------------------
to_compose() {
  local before="" code=0 host_c="" vol_c=""
  before="$(health_commit)"
  say "current prod answers ${before:+commit }${before:-no commit reported by the endpoint} at ${SITE_URL}"

  if [ "$DRY_RUN" -eq 1 ]; then
    say "dry run: would check the backup, create $LOCKS_DIR, take $LOCK_DIR (exit 3 if a deploy holds it),"
    say "dry run: bootout ${JOBS}, wait for 8091 to go quiet (60 s), remove the stale 8090 container 'book-site',"
    say "dry run: check volume ${DATA_VOLUME}: seed it from $HOST_DATA_DIR when it holds no book.db, and REFUSE when both hold a database that differs (the fallback window),"
    say "dry run: run compose-release.sh --ref ${REF}, then write runtime=compose and 'launchctl disable' the three jobs"
    return 0
  fi

  [ "$CONFIRM" -eq 1 ] || die "refusing a flip without --confirm (it stops prod for a few seconds)"
  require
  require_fresh_backup
  ensure_locks_dir

  # One lock for the whole flip: from the first bootout to the last check, no deploy may run.
  lock_acquire

  say "stopping the writer lane (the lease expires within LEASE_TTL_MS=120 s; the engine reaps it)"
  via bootout dev.book-writer 2>/dev/null || say "writer: not loaded"
  say "stopping launchd site and engine"
  via bootout dev.book-site 2>/dev/null || say "site: not loaded"
  via bootout dev.book-engine 2>/dev/null || say "engine: not loaded"
  if ! wait_down 60; then
    say "8091 still answers after 60 s — bringing launchd back before giving up"
    launchd_up
    if wait_up "$HEALTH_TIMEOUT"; then
      die "nothing was started: the launchd site did not stop, and launchd serves ${SITE_URL} again (commit $(health_commit)); runtime untouched"
    fi
    die "nothing was started and NOTHING serves ${SITE_URL}: the launchd site did not stop and launchd did not come back within ${HEALTH_TIMEOUT} s; a human must look"
  fi

  if "$DOCKER" container inspect book-site >/dev/null 2>&1; then
    say "removing the stale pre-BOOK-172 container 'book-site' (was 8090, named volume) — its volume stays until the cycle closes"
    "$DOCKER" rm -f book-site >/dev/null || die "could not remove the stale container 'book-site'"
  fi

  # BOOK-183: the container runtime serves the VOLUME. A first flip seeds it from the host dir (the
  # stack is already down, so the host copy is a safe source); after that the volume is the store and
  # only `--to launchd` writes the host path. Containers never start on an empty volume.
  say "checking volume ${DATA_VOLUME} before any container starts"
  if volume_has_db "$DATA_VOLUME"; then
    say "volume ${DATA_VOLUME}: holds book.db"
    # THE FALLBACK WINDOW (BOOK-183). A volume with `book.db` is not automatically the newer store: after
    # `--to launchd`, launchd kept writing the host dir while the volume stayed at the last export. Serving
    # it would silently publish stale data, and there is no merge. So when BOTH sides hold a database the
    # flip compares them — launchd is already stopped, so the host read is safe — and refuses on any
    # difference, restoring launchd exactly like a failed seed.
    if [ -f "$HOST_DATA_DIR/book.db" ]; then
      host_c="$(host_row_counts "$HOST_DATA_DIR/book.db" 2>/dev/null || true)"
      vol_c="$(volume_row_counts "$DATA_VOLUME" 2>/dev/null || true)"
      if ! counts_agree "$host_c" "$vol_c"; then
        say "host ${HOST_DATA_DIR}: ${host_c:-unreadable}"
        say "volume ${DATA_VOLUME}: ${vol_c:-unreadable}"
        say "the volume does not hold what the host dir holds (the fallback kept writing) — bringing launchd back before giving up"
        launchd_up
        if wait_up "$HEALTH_TIMEOUT"; then
          die "nothing was started: volume ${DATA_VOLUME} and $HOST_DATA_DIR hold DIFFERENT books and there is no merge; launchd serves ${SITE_URL} again (commit $(health_commit)); runtime unchanged — move the difference into a FRESH volume with: $(dirname "$0")/migrate-to-volume.sh --from $HOST_DATA_DIR --volume <fresh-name> --confirm"
        fi
        die "volume ${DATA_VOLUME} differs from $HOST_DATA_DIR and launchd did not come back within ${HEALTH_TIMEOUT} s; a human must look"
      fi
      say "host and volume agree (${host_c}) — the volume is not stale"
    fi
  elif ! seed_volume; then
    say "the volume could not be seeded — bringing launchd back before giving up"
    launchd_up
    if wait_up "$HEALTH_TIMEOUT"; then
      die "nothing was started: volume ${DATA_VOLUME} has no book.db and the seed failed; launchd serves ${SITE_URL} again (commit $(health_commit)); runtime unchanged"
    fi
    die "volume ${DATA_VOLUME} could not be seeded and launchd did not come back within ${HEALTH_TIMEOUT} s; a human must look"
  fi

  say "running the container release (build + up + health gate) — this is the fail-closed step"
  # The lock is handed over, not re-taken: the child would otherwise refuse its own flip with exit 3.
  code=0
  BOOK_LOCK_INHERITED=1 BOOK_LOCK_HOLDER="$$" /bin/bash "$(dirname "$0")/compose-release.sh" --ref "$REF" || code=$?
  if [ "$code" -ne 0 ]; then
    say "the container path is NOT green (compose-release exit ${code}) — stopping the stack before it can hold 8091"
    # A half-started stack would keep 8091 and launchd could not bind: containers down first, always.
    dc down 2>/dev/null || say "compose down: nothing was running"
    say "bootstrapping launchd back"
    launchd_up
    if wait_up "$HEALTH_TIMEOUT"; then
      die "flip aborted: the container gate failed; launchd serves ${SITE_URL} again (commit $(health_commit)); runtime stays $(cat "$RUNTIME_FILE" 2>/dev/null || echo launchd)"
    fi
    die "flip aborted: BOTH runtimes are down — containers stopped and launchd did not answer within ${HEALTH_TIMEOUT} s; a human must look (runtime unchanged: $(cat "$RUNTIME_FILE" 2>/dev/null || echo launchd))"
  fi

  wait_up "$HEALTH_TIMEOUT" || die "compose-release reported success but /healthz does not answer"
  write_runtime compose
  say "disabling the three launchd jobs so no deploy can resurrect them behind the containers"
  local job="" refused=""
  for job in $JOBS; do "$LCTL" disable "$(domain)/$job" >/dev/null 2>&1 || refused="${refused} launchctl disable $(domain)/$job"; done
  if [ -n "$refused" ]; then
    say "the container runtime is green and runtime=compose is recorded, but a job could not be disabled:"
    say "  ${refused# }"
    say "until it is, a deploy can bootstrap that job and take 8091 back — run the command(s) above by hand"
    exit 4
  fi
  say "flip complete: $("$DOCKER" ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Image}} {{.Status}}' | tr '\n' ';')"
}

# --- to launchd (the fallback) --------------------------------------------------------------------
launchd_up() {
  local job=""
  local plist_dir="${HOME}/Library/LaunchAgents"
  for job in $JOBS; do "$LCTL" enable "$(domain)/$job" 2>/dev/null || true; done
  # engine first: the writer's first request needs something to answer on 8081.
  for job in dev.book-engine dev.book-site dev.book-writer; do
    via bootout "$job" 2>/dev/null || true
    via bootstrap "$plist_dir/$job.plist" || say "$job: bootstrap refused (already loaded?)"
  done
}

to_launchd() {
  local serving="" root_commit="" last_good="" lg_sha=""
  if [ "$DRY_RUN" -eq 1 ]; then
    say "dry run: would 'compose down' project ${PROJECT} (images and volume ${DATA_VOLUME} stay),"
    say "dry run: prove the launchd jobs are not serving $HOST_DATA_DIR, export volume ${DATA_VOLUME} -> $HOST_DATA_DIR (one-shot copy, counts compared), then enable+bootstrap ${JOBS},"
    say "dry run: then wait for ${SITE_URL}/healthz to name the deploy root's sha, then write runtime=launchd"
    return 0
  fi
  [ "$CONFIRM" -eq 1 ] || die "refusing a flip without --confirm"
  require
  lock_acquire
  say "stopping the container stack (images and the data dir stay)"
  dc down || say "compose down: nothing was running (or it failed)"
  # A stack that is still up owns 8091: launchd could not bind, and `wait_up` would then read the
  # container's 200 and wrongly record runtime=launchd.
  if ! containers_gone 10; then
    die "the compose stack (project ${PROJECT}) still has containers after 'compose down' — runtime untouched; a human must look at 'docker compose -p ${PROJECT} ps'"
  fi
  # launchd runs the tree, so the tree has to be the code that was running: align it to the last good
  # image's commit. Guarded — a refused or missing commit is one log line, and the check after
  # `wait_up` then either compares like with like or says the root is not readable.
  last_good="$(cat "$STATE_DIR/last-good-image" 2>/dev/null || true)"
  lg_sha="${last_good##*:}"
  if [ -n "$last_good" ] && [ -d "$ROOT/.git" ] && git -C "$ROOT" rev-parse --verify --quiet "${lg_sha}^{commit}" >/dev/null 2>&1; then
    if git -C "$ROOT" checkout --quiet --detach "$lg_sha"; then
      say "tree: deploy root at ${lg_sha:0:7} (the last good image)"
    else
      say "tree: checkout of ${lg_sha:0:7} refused — the deploy root stays at $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    fi
  elif [ -n "$last_good" ]; then
    say "tree: ${lg_sha:0:7} from last-good-image is not in $ROOT — the deploy root stays where it is"
  else
    say "tree: no last-good-image recorded — the deploy root stays where it is"
  fi
  # BOOK-183: launchd serves the TREE over the HOST data dir. Export the volume back to it before any
  # bootstrap (the stack is down, so the export is the only writer), and refuse with exit 1 when the
  # export or the counts fail: the fallback must not come up on data older than the volume's.
  if ! launchd_not_serving; then
    die "a launchd job is still serving $HOST_DATA_DIR (or 8091 still answers) — nothing was exported, nothing was bootstrapped; runtime unchanged"
  fi
  if ! export_volume; then
    die "the volume was not exported to $HOST_DATA_DIR — nothing was bootstrapped and the containers are down; recovery: 'site/deploy/flip.sh --to compose --confirm' brings the stack back on volume ${DATA_VOLUME}, or fix the export and re-run this flip"
  fi
  say "bootstrapping the launchd fallback"
  launchd_up
  wait_up "$HEALTH_TIMEOUT" || die "launchd did not bring 8091 back within ${HEALTH_TIMEOUT} s — a human must look (plists are installed, runtime unchanged)"
  serving="$(health_commit)"
  root_commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  if [ -z "$root_commit" ]; then
    say "commit check skipped: cannot read HEAD in $ROOT; prod answers ${serving:-none}"
  elif ! names_commit "$serving" "$root_commit"; then
    die "launchd answers ${serving:-no commit}, but the deploy root is at ${root_commit} — the plist runs a different build; runtime unchanged, a human must look"
  fi
  say "prod answers commit ${serving} at ${SITE_URL} (deploy root ${root_commit:-unknown})"
  write_runtime launchd
  say "flip back complete: runtime=launchd"
}

if [ "$TO" = "compose" ]; then to_compose; else to_launchd; fi
