#!/bin/bash
# migrate-to-volume.sh — move the book's state from a host data dir into a named volume (BOOK-183).
#
#   site/deploy/migrate-to-volume.sh --confirm                       # the migration, end to end
#   site/deploy/migrate-to-volume.sh --from <dir> --volume <name> --confirm
#   site/deploy/migrate-to-volume.sh --seed-only                     # stop → seed → verify, return
#   site/deploy/migrate-to-volume.sh --dry-run                       # print the plan, touch nothing
#
# `--dry-run` needs no `--confirm` (a preview behind a confirmation flag is not a preview); `--confirm`
# is required for a real full run, because it stops prod and moves the host copy.
#
# Why this exists: the data dir was a macOS bind mount into the OrbStack VM. SQLite in WAL mode shares
# its `-shm` through the OS, so the container and the host were two kernels over one file, and a host
# `sqlite3` write while `site` held it produced `SQLITE_IOERR_SHORT_READ` (2026-10-28). The volume is
# one kernel (measured: `btrfs /dev/vdb1`, root `/docker/volumes/<name>/_data`).
#
# FULL MODE, in this order (each step refuses rather than guesses):
#   1. the source must be a directory with `book.db`;
#   2. no running container may mount the source — a live holder is a refusal, not something to kill;
#   3. the target volume must not already contain `book.db` (a second run would overwrite live state)
#      unless `--force` names a volume that is not the serving one;
#   4. the stack stops (`compose stop`, then `down` — volumes are kept);
#   5. the source is copied into the volume by a one-shot container (`cp -a`, root, then
#      `chown -R 501:20` and the stale `-shm` is deleted — it is the file the incident was about);
#   6. the copy is verified INSIDE a container on the volume: `PRAGMA integrity_check` and the row
#      counts, compared with the host DB read by the host's `sqlite3` (the stack is stopped, so that
#      read is safe — it is the only host read this script makes);
#   7. `compose-release.sh --ref <ref>` brings prod up on the volume behind the health gate;
#   8. on green, `/api/state` is read and its chapter count/characters must match the DB;
#   9. the host dir is MOVED (not deleted) to `$BACKUP_ROOT/pre-volume-<ts>/book-site-data`.
#
# `--seed-only` is steps 1–6 and returns: `flip.sh --to compose` and a rehearsal use it, and it is the
# half that has to be safe to repeat when a release fails afterwards.
#
# Exit codes (BOOK-183 IFACE): 0 seeded and verified (and, in full mode, prod healthy + runtime recorded +
# host copy moved aside); 1 refused or failed; 2 usage; 3 another deploy holds the lock; 4 prod is UP on
# the volume but a launchd job could not be disabled (runtime already recorded; the commands are printed).
#
# A failure says what is TRUE about prod, because the three states are not the same and the wrong
# advice is an outage: nothing was stopped (prod as it was); stopped but not released (the stack is
# DOWN — `flip.sh --to launchd` brings it back); or released (prod is already UP on the volume — the
# message says what answers and offers no restart). Parsing here is POSIX-only: `\b` in `sed` is a GNU
# extension and BSD sed matches nothing with it (that defect killed a green run at the last step).
set -eEuo pipefail

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

ROOT="${BOOK_DEPLOY_ROOT:-$HOME/book-deploy}"
STATE_DIR="${BOOK_STATE_DIR:-${HOME}/.local/state/book-deploy}"
# Read by lib.sh's lock_* functions.
# shellcheck disable=SC2034
LOCK_DIR="${STATE_DIR}/deploy.lock"
COMPOSE_FILE="${BOOK_COMPOSE_FILE:-${ROOT}/site/docker-compose.yml}"
PROJECT="${BOOK_PROJECT:-book}"
DOCKER="${BOOK_DOCKER:-docker}"
# `launchctl` is stubbed by tests (`BOOK_LAUNCHCTL`), like flip.sh does: the runtime file and the disabled
# jobs are the operator-facing contract, not the binary.
LCTL="${BOOK_LAUNCHCTL:-launchctl}"
VOLUME="${BOOK_DATA_VOLUME:-book-data}"
FROM="${BOOK_HOST_DATA_DIR:-$HOME/book-site-data}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/book-site-backups}"
SITE_BIND="${BOOK_SITE_PUBLISH:-192.168.1.76:8091}"
SITE_URL="${BOOK_SITE_URL:-http://${SITE_BIND%:*}:${SITE_BIND##*:}}"

REF="main"
SEED_ONLY=0
CONFIRM=0
DRY_RUN=0
FORCE=0
STEP="start"
IMAGE=""
# What this run has already done, so a failure never lies about prod: `STOPPED` means this run stopped
# the stack, `RELEASED` means `compose-release.sh` already put it back up on the volume.
STOPPED=0
RELEASED=0

# The counts the manifest, `bin/backup.mjs` and the admin surface all report: one line, greppable.
COUNTS_SQL="SELECT 'chapters='||(SELECT count(*) FROM chapters)
  ||' blocks='||(SELECT count(*) FROM blocks)
  ||' changes='||(SELECT count(*) FROM changes)
  ||' comments='||(SELECT count(*) FROM comments)
  ||' identities='||(SELECT count(*) FROM identities)
  ||' revisions='||(SELECT count(*) FROM revisions)
  ||' events='||(SELECT count(*) FROM events)
  ||' chars='||(SELECT coalesce(sum(chars),0) FROM chapters);"

usage() { sed -n '2,/^set -eEuo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
say() { printf '%s migrate: %s\n' "$(window_stamp)" "$*"; }

# What answers right now, in one clause: the operator needs to know whether prod is up before deciding
# anything. A read that cannot be made is an answer ("answered nothing"), never an exit.
serving_now() {
  local body="" commit=""
  body="$(curl -sS --max-time 3 "${SITE_URL}/healthz" 2>/dev/null || true)"
  commit="$(printf '%s' "$body" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -n "$commit" ]; then printf 'prod answers %s at %s' "$commit" "$SITE_URL"
  else printf 'prod answered nothing at %s' "$SITE_URL"; fi
}

# One line, then what the operator must (or must not) do. THREE states, because they are not the same:
#   nothing stopped        — prod is as it was; touching it would be the failure;
#   stopped, not released  — the stack is DOWN and the host copy is untouched: that is the one case
#                            where `flip.sh --to launchd` brings prod back;
#   released               — `compose-release.sh` already put prod up on the volume: the host copy is
#                            untouched, the stack is SERVING, and restarting it would be a second
#                            outage. Say what answers and what to check instead.
die() { # (reason)
  printf '%s migrate: FAILED at %s: %s\n' "$(window_stamp)" "$STEP" "$*" >&2
  if [ "${RELEASED:-0}" = "1" ]; then
    printf '%s migrate: prod is UP on volume %s (%s); the host copy at %s is untouched — do NOT restart the stack.\n' \
      "$(window_stamp)" "$VOLUME" "$(serving_now)" "$FROM" >&2
    printf '%s migrate: next: check %s --status and %s/api/state, then archive the host copy by hand (mv %s %s/pre-volume-<ts>/book-site-data) — re-running this script is not needed and would refuse a seeded volume.\n' \
      "$(window_stamp)" "$(dirname "$0")/compose-release.sh" "$SITE_URL" "$FROM" "$BACKUP_ROOT" >&2
  elif [ "${STOPPED:-0}" = "1" ]; then
    printf '%s migrate: recovery: the host copy at %s is untouched and the stack is DOWN — bring prod back with:\n' \
      "$(window_stamp)" "$FROM" >&2
    printf '  %s --to launchd --confirm   (or re-run this script once the cause is fixed)\n' "$(dirname "$0")/flip.sh" >&2
  else
    printf '%s migrate: recovery: nothing was stopped and the host copy at %s is untouched — prod is as it was.\n' \
      "$(window_stamp)" "$FROM" >&2
  fi
  exit 1
}

dc() { "$DOCKER" compose --env-file /dev/null -f "$COMPOSE_FILE" -p "$PROJECT" "$@"; }

# The image a one-shot copy runs from: the one the stack serves, else the recorded last good one, else
# an explicit `BOOK_IMAGE_TAG` (the rehearsal's own tag). It never builds.
image() {
  local id="" img=""
  if [ -n "${BOOK_IMAGE_TAG:-}" ]; then printf '%s' "$BOOK_IMAGE_TAG"; return 0; fi
  id="$(dc ps -q site 2>/dev/null | head -n 1 || true)"
  if [ -n "$id" ]; then img="$("$DOCKER" inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true)"; fi
  if [ -z "$img" ]; then img="$(cat "$STATE_DIR/last-good-image" 2>/dev/null || true)"; fi
  printf '%s' "$img"
}

# The live holder of the source, if there is one: `docker ps` + the mount sources of each container.
containers_mounting() { # (path) -> ids, space separated
  local src="$1" id="" line=""
  for id in $("$DOCKER" ps -q 2>/dev/null || true); do
    while IFS= read -r line; do
      if [ "$line" = "$src" ]; then printf '%s ' "${id:0:12}"; break; fi
    done <<<"$("$DOCKER" inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$id" 2>/dev/null || true)"
  done
}

volume_exists() { "$DOCKER" volume inspect "$VOLUME" >/dev/null 2>&1; }

volume_has_db() {
  volume_exists || return 1
  "$DOCKER" run --rm --entrypoint sh -v "$VOLUME":/to:ro "$IMAGE" -c 'test -f /to/book.db' >/dev/null 2>&1
}

# Row counts of the host copy. `-readonly` first: the stack is stopped, but a read-only open of a WAL
# database may still want the `-shm`, so one plain open is the fallback — the host owns this file and
# nothing else has it open, which is exactly the condition the incident did NOT have.
host_counts() {
  local out=""
  if out="$(sqlite3 -readonly "$FROM/book.db" "$COUNTS_SQL" 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
  out="$(sqlite3 "$FROM/book.db" "$COUNTS_SQL")" || return 1
  printf '%s' "$out"
}

# Row counts + integrity of the DB at `$1` in the volume, read INSIDE a container — the only reader
# that may open it. Prints one `chapters=…` line on success; exits non-zero with the reason on failure.
volume_counts() { # (volume name)
  "$DOCKER" run --rm --user 501:20 --entrypoint node -w /app -v "$1":/vol "$IMAGE" -e '
    const D = require("better-sqlite3");
    const db = new D("/vol/book.db");
    const r = db.prepare("SELECT (SELECT count(*) FROM chapters) chapters, (SELECT count(*) FROM blocks) blocks, (SELECT count(*) FROM changes) changes, (SELECT count(*) FROM comments) comments, (SELECT count(*) FROM identities) identities, (SELECT count(*) FROM revisions) revisions, (SELECT count(*) FROM events) events, (SELECT coalesce(sum(chars),0) FROM chapters) chars").get();
    const integrity = db.pragma("integrity_check", { simple: true });
    db.close();
    if (integrity !== "ok") { console.error(`integrity_check: ${String(integrity).slice(0, 200)}`); process.exit(1); }
    console.log(Object.entries(r).map(([k, v]) => `${k}=${v}`).join(" "));
  '
}

# What `/api/state` derives from the DB: `chapters` counts every written chapter, and the two basis
# slots (ch01 opens on the frozen frame, ch42 closes on it) are `basis=1`, NOT written — so the site
# reports `chapters=18 - basis` and the raw table count is not the number to compare with. Read with a
# plain (rw) connection: `-readonly` on a WAL database needs the live `-shm`, and this is a container on
# the same kernel anyway.
state_counts() { # (volume) -> "written=N chapters=N chars=N"
  "$DOCKER" run --rm --user 501:20 --entrypoint node -w /app -v "$1":/vol "$IMAGE" -e '
    const D = require("better-sqlite3");
    const db = new D("/vol/book.db");
    const r = db.prepare("SELECT (SELECT count(*) FROM chapters WHERE basis = 0) written, (SELECT count(*) FROM chapters) chapters, (SELECT coalesce(sum(chars),0) FROM chapters) chars").get();
    db.close();
    console.log(Object.entries(r).map(([k, v]) => `${k}=${v}`).join(" "));
  '
}

# One field of a `key=value …` line (`state_counts`, `host_counts`). Read with the SHELL, never with
# `sed`: the first version used `sed -n 's/.*\bwritten=\([0-9]*\).*/\1/p'`, `\b` is a GNU extension,
# BSD sed (this Mac and the self-hosted runner) matched nothing, and a GREEN full-mode run died at
# STEP=state with an empty number — after `compose-release.sh` had already put prod up. Returns 1 and
# prints nothing when the key is absent, so the caller's `is_number` check still speaks.
count_field() { # (line, key)
  local kv
  for kv in $1; do
    case "$kv" in
      "$2"=*) printf '%s' "${kv#"$2"=}"; return 0 ;;
    esac
  done
  return 1
}

# Two `key=value …` count lines: same keys, same values. The pairs are sorted, so key ORDER never matters
# and a missing or extra key is a difference (the two readers are independent: host `sqlite3` and
# better-sqlite3 in a container).
counts_lines_agree() { # (a, b)
  local a b
  a="$(printf '%s\n' "$1" | tr ' ' '\n' | sed '/^$/d' | sort)"
  b="$(printf '%s\n' "$2" | tr ' ' '\n' | sed '/^$/d' | sort)"
  [ -n "$a" ] && [ "$a" = "$b" ]
}

# Compare two `key=value` lines of the same keys. Different keys, different order or a missing value is
# a mismatch: neither side is trusted to be the "right" shape.
counts_equal() { # (a, b) -> 0 when identical
  [ "$1" = "$2" ]
}

seed() {
  STEP="seed"
  say "copying $FROM -> volume $VOLUME (one-shot container, ${IMAGE})"
  # `-u 0` (a fresh volume's root is root:root — measured) so `cp -a` can write and keep the host's
  # 0600 files and their uid, and `chown` then makes the volume's root writable by the uid the services
  # run as. The stale `-shm` is deleted — it is a shared-memory index of ANOTHER kernel's page cache
  # and must never be inherited.
  "$DOCKER" run --rm -u 0 --entrypoint sh -v "$FROM":/from:ro -v "$VOLUME":/to "$IMAGE" -c '
    set -e
    # The destination is a fresh copy that nothing else owns: a journal left there by an earlier open
    # (a -wal, a -journal, a -shm) would be overlaid onto the incoming pages. Drop them BEFORE the copy,
    # then take the -wal of the source itself as data.
    rm -f /to/book.db-wal /to/book.db-shm /to/book.db-journal
    # BOOK-187: this copy is a snapshot of the PAST, so a source that still holds the files of the
    # old writer (writer/, backup/) carries them in. After a seed, run `bin/home-migrate.mjs --apply`
    # on the volume once — it is the only thing that removes them, and `bin/home-check.mjs` names
    # them until it does.
    cp -a /from/. /to/
    rm -f /to/book.db-shm
    chown -R 501:20 /to
  ' || die "the one-shot copy into volume $VOLUME failed"
}

verify() {
  STEP="verify"
  say "verifying the copy inside a container on volume $VOLUME (integrity + row counts vs the host DB)"
  local vol_counts="" host=""
  vol_counts="$(volume_counts "$VOLUME")" || die "the copy in volume $VOLUME did not pass integrity_check"
  [ -n "$vol_counts" ] || die "reading the row counts of volume $VOLUME came back empty"
  host="$(host_counts)" || die "reading the row counts of the host DB $FROM/book.db failed"
  if ! counts_equal "$vol_counts" "$host"; then
    say "volume: $vol_counts"
    say "host:   $host"
    die "the row counts differ between the volume and the host copy"
  fi
  say "counts match: $vol_counts (integrity_check ok)"
}

# --- the run ------------------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --from) [ $# -ge 2 ] || { usage >&2; exit 2; }; FROM="$2"; shift 2 ;;
    --volume) [ $# -ge 2 ] || { usage >&2; exit 2; }; VOLUME="$2"; shift 2 ;;
    --ref) [ $# -ge 2 ] || { usage >&2; exit 2; }; REF="$2"; shift 2 ;;
    --root) [ $# -ge 2 ] || { usage >&2; exit 2; }; ROOT="$2"; shift 2 ;;
    --seed-only) SEED_ONLY=1; shift ;;
    --confirm) CONFIRM=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'migrate-to-volume: unknown argument %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
if [ -z "${BOOK_COMPOSE_FILE:-}" ]; then COMPOSE_FILE="${ROOT}/site/docker-compose.yml"; fi

STEP="preflight"
[ -d "$FROM" ] || die "the source $FROM is not a directory"
[ -f "$FROM/book.db" ] || die "the source $FROM has no book.db"
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is not on PATH — the host copy cannot be counted without it"
"$DOCKER" version >/dev/null 2>&1 || die "docker is not available"
dc version >/dev/null 2>&1 || die "the docker compose plugin is not available"
[ -f "$COMPOSE_FILE" ] || die "no compose file at $COMPOSE_FILE"
[ -n "$VOLUME" ] || die "a volume name is required"

IMAGE="$(image)"
[ -n "$IMAGE" ] || die "no image to run the one-shot copy and the verification with (BOOK_IMAGE_TAG, the running site, or last-good-image)"

held="$(containers_mounting "$FROM")"
if [ -n "$held" ]; then
  die "a running container mounts $FROM (${held% }) — stop it first: this script never kills a live holder"
fi

# --dry-run comes BEFORE the --confirm gate, like `compose-release.sh --dry-run` and `flip.sh --dry-run`:
# a preview that required the confirmation flag was not a preview. It takes no lock, starts nothing that
# changes anything, and prints the refusals a real run would hit rather than hitting them.
if [ "$DRY_RUN" -eq 1 ]; then
  say "dry run: lock $(lock_report) — this run takes nothing"
  say "dry run: source $FROM ($(stat -c %z "$FROM/book.db" 2>/dev/null || stat -f %Sm "$FROM/book.db" 2>/dev/null || echo 'mtime unknown'))"
  say "dry run: image $IMAGE, target volume $VOLUME ($(volume_exists && echo exists || echo absent)), project $PROJECT"
  if [ "$FORCE" -eq 0 ] && volume_exists && volume_has_db; then
    say "dry run: volume $VOLUME ALREADY holds book.db — a real run refuses it (use --force into a FRESH volume name)"
  fi
  if [ "$SEED_ONLY" -eq 1 ]; then
    say "dry run: would stop the stack, copy, verify integrity + row counts, and return (--seed-only)"
  else
    say "dry run: would stop the stack, copy, verify, run compose-release.sh --ref $REF, check /api/state against the DB, then move $FROM to $BACKUP_ROOT/pre-volume-<ts>/book-site-data"
  fi
  exit 0
fi

# `--confirm` is required for every run that changes state: a full migration (it stops prod and moves the
# host copy) AND any `--force`, in `--seed-only` mode too — a bare `--seed-only --force` used to slip past
# this gate and overwrite a volume that holds a database. `--seed-only` without `--force` is the safe half
# `flip.sh` calls; `--dry-run` prints the plan and needs nothing.
if [ "$CONFIRM" -eq 0 ] && [ "$SEED_ONLY" -eq 0 ]; then
  printf 'migrate-to-volume: refusing a full migration without --confirm (it stops prod and moves the host copy); --seed-only is the half that does not, and --dry-run prints the plan\n' >&2
  exit 2
fi
if [ "$CONFIRM" -eq 0 ] && [ "$FORCE" -eq 1 ]; then
  printf 'migrate-to-volume: refusing --seed-only --force without --confirm (it overwrites a volume that holds a database); add --confirm, or drop --force and let the seed write a volume that has none\n' >&2
  exit 2
fi

# `--force` is not a shortcut past the guard: it exists for a FRESH volume that already holds a partial
# copy (and it still needs `--confirm`, which the gate above already requires of every real run).
if [ "$FORCE" -eq 1 ] && [ "$VOLUME" = "${BOOK_DATA_VOLUME:-book-data}" ]; then
  die "--force refuses the serving volume $VOLUME — overwriting the live store is not a migration; seed a FRESH volume name and flip to it deliberately"
fi
if volume_has_db; then
  if [ "$FORCE" -eq 0 ]; then
    die "volume $VOLUME already contains book.db — refusing to overwrite it (re-run with --force into a FRESH volume name)"
  fi
  # The volume holds a live-looking store; overwriting it destroys whatever it has that the host copy does
  # not. The WHOLE counts line decides (every table the manifest reports), not just chapters and blocks:
  # any difference at all is a refusal, because rows cannot be told apart from "a partial seed" by
  # counting alone. A partial copy is a fresh volume: remove it and re-run without `--force`.
  STEP="preflight"
  vol_now="$(volume_counts "$VOLUME" 2>/dev/null || true)"
  host_now="$(host_counts 2>/dev/null || true)"
  if ! counts_lines_agree "$vol_now" "$host_now"; then
    say "volume $VOLUME: ${vol_now:-unreadable}"
    say "host $FROM:     ${host_now:-unreadable}"
    die "volume $VOLUME and $FROM do not hold the same rows — --force will not overwrite a differing store; if this volume is a partial seed, remove it (docker volume rm $VOLUME) and re-run without --force"
  fi
  say "force: volume $VOLUME matches $FROM on every table ($vol_now) — overwriting with an identical copy"
fi

# A run that dies must not leave its lock behind for the next one to take over: release only what this
# process owns (`lib.sh:lock_release` checks `LOCK_OWNED`), on every exit path.
# Preserve the run's status across the trap: `lock_release` returns 0, and a plain `trap 'lock_release' EXIT`
# would let a refusal (exit 4) or a fatal error read as a clean run. `EXIT_CODE` is captured before the
# release and re-exited after it, so 0/1/2/3/4 all arrive intact.
EXIT_CODE=0
trap 'EXIT_CODE=$?; lock_release; exit "$EXIT_CODE"' EXIT

# One deploy at a time. A flip that already holds the lock hands it over (`BOOK_LOCK_INHERITED=1`), the
# same contract compose-release.sh has: the child must not refuse its own parent with exit 3.
STEP="lock"
if [ "${BOOK_LOCK_INHERITED:-0}" = "1" ]; then
  # `LOCK` is lib.sh's own contract (`held`/`taken-over`/`inherited`); this run only inherits it.
  # shellcheck disable=SC2034
  LOCK="inherited"
  say "lock: inherited from pid ${BOOK_LOCK_HOLDER:-unknown} — this run neither takes nor releases it"
else
  lock_acquire
fi

mkdir -p "$BACKUP_ROOT" 2>/dev/null || die "cannot create $BACKUP_ROOT"

STEP="stop"
say "stopping project $PROJECT (volumes are kept)"
dc stop --timeout 30 || say "stop: nothing was running"
if dc down; then
  STOPPED=1
else
  # Not `die`: `die` says "the stack is DOWN", and after a half-failed `down` that would be a guess — and
  # the wrong guess sends the operator to a launchd bootstrap under a running container.
  printf '%s migrate: FAILED at stop: compose down failed — the stack state is UNKNOWN; the host copy at %s is untouched.\n' \
    "$(window_stamp)" "$FROM" >&2
  printf '%s migrate: next: check `%s compose -p %s ps` and `docker ps`, then bring prod back with %s --to launchd --confirm (or finish this run).\n' \
    "$(window_stamp)" "$DOCKER" "$PROJECT" "$(dirname "$0")/flip.sh" >&2
  exit 1
fi

seed
verify

if [ "$SEED_ONLY" -eq 1 ]; then
  STEP="done"
  say "seed only: volume $VOLUME is seeded and verified; project $PROJECT is down"
  say "next: compose-release.sh --ref $REF (or flip.sh --to compose) starts the stack on it"
  exit 0
fi

STEP="release"
say "bringing the stack up on volume $VOLUME behind the compose health gate (ref $REF)"
release_code=0
BOOK_LOCK_INHERITED=1 BOOK_LOCK_HOLDER="$$" BOOK_DATA_VOLUME="$VOLUME" BOOK_PROBE_IMAGE="$IMAGE" \
  /bin/bash "$(dirname "$0")/compose-release.sh" --ref "$REF" || release_code=$?
if [ "$release_code" -ne 0 ]; then
  die "compose-release.sh exited $release_code — the volume is seeded and verified, prod did not come up on it"
fi
# From here prod is SERVING on the volume: every later failure must say so (see `die`).
RELEASED=1

# The runtime file and the disabled jobs are part of the migration, not of the flip that preceded it: a
# box whose `$STATE_DIR/runtime` still says `launchd` sends `backup.sh`/`admin.sh` to the fastify-free
# host path this run just moved away, and an enabled job lets `deploy.sh` resurrect launchd on 8091.
STEP="runtime"
mkdir -p "$STATE_DIR" || die "cannot create $STATE_DIR — runtime=compose could not be recorded"
printf 'compose\n' >"$STATE_DIR/runtime" || die "cannot write $STATE_DIR/runtime — the backup and admin wrappers would keep dispatching to launchd"
say "runtime=compose recorded in $STATE_DIR/runtime"
refused=""
if [ -f "$HOME/Library/LaunchAgents/dev.book-site.plist" ] && command -v "$LCTL" >/dev/null 2>&1; then
  for job in site engine writer; do
    "$LCTL" disable "gui/$(id -u)/dev.book-$job" >/dev/null 2>&1 \
      || refused="${refused} launchctl disable gui/$(id -u)/dev.book-$job"
  done
else
  say "no launchd jobs installed on this box ($HOME/Library/LaunchAgents/dev.book-site.plist) — nothing to disable"
fi
if [ -n "$refused" ]; then
  say "prod is UP on volume $VOLUME and runtime=compose is recorded, but a launchd job could not be disabled:"
  say "  ${refused# }"
  say "until it is, a deploy can bootstrap that job against $FROM and take 8091 back — run the command(s) above by hand"
  exit 4
fi

STEP="state"
say "reading /api/state and comparing it with the DB (counts move with the writer, so this is a before/after, not a constant)"
body="$(curl -sS --max-time 5 "${SITE_URL}/api/state" 2>/dev/null || true)"
[ -n "$body" ] || die "/api/state answered nothing at ${SITE_URL}"
api_chapters="$(printf '%s' "$body" | sed -n 's/.*"chapters":{[^}]*"count":\([0-9][0-9]*\).*/\1/p' | head -n 1)"
api_chars="$(printf '%s' "$body" | sed -n 's/.*"chapters":{[^}]*"totalChars":\([0-9][0-9]*\).*/\1/p' | head -n 1)"
db_state="$(state_counts "$VOLUME")" || die "reading the volume's state counts after the release failed"
db_state="${db_state%%$'\n'*}"
db_written="$(count_field "$db_state" written || true)"
db_chars="$(count_field "$db_state" chars || true)"
if [ -z "$api_chapters" ] || [ -z "$api_chars" ]; then
  die "/api/state did not carry chapters.count/totalChars — cannot prove the site reads the volume"
fi
is_number "$db_written" && is_number "$api_chapters" && is_number "$db_chars" && is_number "$api_chars" \
  || die "the counts are not numbers (site '$api_chapters/$api_chars', volume '$db_written/$db_chars') — cannot compare them"
# The writer lane may land a chapter between the two reads, so the DB is allowed to be ahead of the
# site's cached snapshot. The other direction is the failure this checks: the site reading LESS than the
# volume holds means it is not reading this volume at all.
if [ "$api_chapters" -lt "$db_written" ]; then
  die "/api/state reports $api_chapters written chapters, the volume has $db_written — the site is not reading this volume"
fi
if [ "$api_chars" -lt "$db_chars" ]; then
  say "note: /api/state totalChars ($api_chars) is behind the volume's ($db_chars) — the site's snapshot was taken mid-write"
fi
say "api/state: chapters=$api_chapters totalChars=$api_chars; volume: written=$db_written totalChars=$db_chars"

STEP="archive"
# Before the host copy stops being the store: prove the content-addressed snapshots really came over. The
# writer lane may have added more to the volume since the seed (that is progress, not loss), so only
# FEWER files on the volume is a failure.
if [ -d "$FROM/versions" ]; then
  src_versions="$(find "$FROM/versions" -type f 2>/dev/null | wc -l | tr -d ' ')"
  vol_versions="$("$DOCKER" run --rm --entrypoint sh -v "$VOLUME":/v:ro "$IMAGE" -c 'find /v/versions -type f 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ' || true)"
  is_number "$src_versions" && is_number "$vol_versions" \
    || die "cannot count versions/ files (host '$src_versions', volume '$vol_versions') — refusing to move the host copy with the snapshots unproven"
  [ "$vol_versions" -ge "$src_versions" ] \
    || die "volume $VOLUME holds $vol_versions versions/ files, the host dir has $src_versions — refusing to move the host copy with snapshots missing"
  say "versions: ${vol_versions} on the volume, ${src_versions} on the host (kept)"
fi
ts="$(date +%Y%m%dT%H%M%S)"
dest="$BACKUP_ROOT/pre-volume-$ts"
mkdir -p "$dest" || die "cannot create $dest"
say "moving the host copy to $dest/book-site-data (kept as a backup, never deleted)"
mv "$FROM" "$dest/book-site-data" || die "moving $FROM to $dest failed — the host copy is still in place"

STEP="done"
say "migrated: prod serves from volume $VOLUME; the host copy is at $dest/book-site-data"
say "the host path $FROM is now empty of state — a bind mount of it would be refused by the entrypoint (exit 78)"
exit 0
