#!/usr/bin/env bash
#
# site/deploy/backup.sh — the ONE command the owner (and `dev.book-backup.plist`) runs for a backup
# (BOOK-28, BOOK-183). It owns no backup logic: it dispatches on `$STATE_DIR/runtime`, which
# `flip.sh` writes.
#
#   compose  the database lives in the `book-data` volume, so the backup is taken where it lives —
#            `docker compose exec -T site node /app/bin/backup.mjs --out /backups`. The container
#            writes into the `/backups` bind (`${BOOK_BACKUPS_DIR:-~/book-site-backups}`), so the
#            copies land on the host as `daily/<ts>/…` exactly as before, and the host NEVER opens
#            `book.db` (a bind-mounted SQLite in WAL mode across two kernels is the BOOK-183 incident).
#   launchd  the tree serves prod from the host data dir, so the host implementation runs:
#            `deploy/backup-host.sh` (macOS `sqlite3`, unchanged).
#
# An absent `runtime` file means launchd: it is the default the box had before containers existed,
# and a missing file must not silently skip the nightly backup.
#
#   site/deploy/backup.sh                        # a backup, into $BOOK_BACKUPS_DIR/daily/<ts>/
#   site/deploy/backup.sh --verify <dir>         # integrity + counts of an EXISTING copy (no writes)
#
# Under `runtime=compose` every path handed to the CLI is a CONTAINER path: the host passes
# `--data /data`, `--out /backups`, and both spellings work (`--out /backups` and `--out=/backups`).
# Only `--verify` needs translating, because the operator types a HOST path that the container sees at
# `/backups`; the wrapper rewrites it and nothing else.
# `BACKUP_ROOT` is accepted as an alias of `BOOK_BACKUPS_DIR` (the launchd scripts and the plist use it).
#
# Exit codes pass through unchanged: 0 ok · 1 failure · 2 usage · 75 another run holds the lock.
# One line per run is appended to $LOG_FILE (the same log the launchd job writes); nothing is echoed
# unless stdout is a terminal, so launchd's own stdout redirection cannot duplicate the line. No
# secret is read or printed.
set -euo pipefail

# `/usr/local/bin` is where OrbStack installs `docker` on this box (measured): a launchd job
# and this shell do not inherit a login PATH, and without it the nightly backup fails with exit 127.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE_DIR="${BOOK_STATE_DIR:-${HOME}/.local/state/book-deploy}"
LOG_FILE="${LOG_FILE:-$HOME/Library/Logs/book-backup.log}"
PROJECT="${BOOK_PROJECT:-book}"
COMPOSE_FILE="${BOOK_COMPOSE_FILE:-${ROOT}/site/docker-compose.yml}"
DOCKER="${BOOK_DOCKER:-docker}"
# The host path the compose runtime exposes at `/backups`. Only used to translate a host path given to
# `--verify` into the container path — never as a place this script opens a database. `BACKUP_ROOT` is
# the launchd scripts' name for the same directory, so it is accepted when the newer variable is unset.
BACKUPS_DIR="${BOOK_BACKUPS_DIR:-${BACKUP_ROOT:-/Users/filipp/book-site-backups}}"
while [ "${BACKUPS_DIR%/}" != "$BACKUPS_DIR" ] && [ "$BACKUPS_DIR" != "/" ]; do BACKUPS_DIR="${BACKUPS_DIR%/}"; done

runtime="$(cat "$STATE_DIR/runtime" 2>/dev/null || true)"
runtime="${runtime:-launchd}"
case "$runtime" in
  compose|launchd) ;;
  *)
    printf 'book-backup: %s/runtime says "%s", expected compose|launchd — refusing (exit 1)\n' "$STATE_DIR" "$runtime" >&2
    exit 1
    ;;
esac

log_append() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  printf '%s\n' "$1" >>"$LOG_FILE"
}

if [ "$runtime" = "launchd" ]; then
  # One name for one directory: the host implementation reads `BACKUP_ROOT`.
  [ -n "${BACKUP_ROOT:-}" ] || export BACKUP_ROOT="$BACKUPS_DIR"
  exec /bin/bash "$HERE/backup-host.sh" "$@"
fi

# --- compose: the backup runs inside the container -----------------------------------------------
#
# `--verify <host path under $BACKUPS_DIR>` is the one argument that needs translating: the container
# sees that directory at `/backups`, so the path the owner typed has to be rewritten, or the CLI would
# look for a directory that does not exist on its side of the mount.
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)
      [ $# -ge 2 ] || { printf 'book-backup: --verify needs a directory\n' >&2; exit 2; }
      verify_dir="$2"
      while [ "${verify_dir%/}" != "$verify_dir" ] && [ "$verify_dir" != "/" ]; do verify_dir="${verify_dir%/}"; done
      case "$verify_dir" in
        "$BACKUPS_DIR"/*) verify_dir="/backups/${verify_dir#"$BACKUPS_DIR"/}" ;;
      esac
      args+=(--verify "$verify_dir")
      shift 2
      ;;
    *=*)
      # A `--data`/`--out` given as `--out=/path` is passed through untouched: the runbook's own
      # command always names `/backups` (the container path), and rewriting it would lie.
      args+=("$1")
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
[ ${#args[@]} -gt 0 ] || args=(--out /backups)

out=""
code=0
out="$("$DOCKER" compose --env-file /dev/null -f "$COMPOSE_FILE" -p "$PROJECT" exec -T site \
  node /app/bin/backup.mjs "${args[@]}")" || code=$?

if [ -n "$out" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && log_append "$line"
  done <<<"$out"
  if [ -t 1 ]; then printf '%s\n' "$out"; fi
fi

if [ "$code" -ne 0 ]; then
  # The one line the log owes for a failed run: the code, never the container's stdout body (that is the
  # node CLI's own `reason=` line, which the caller already sees on stderr).
  log_append "$(date -u +%FT%TZ) level=error job=book-backup status=fail exit=$code runtime=compose"
  printf 'book-backup: compose exec exited %s (project %s, log %s)\n' "$code" "$PROJECT" "$LOG_FILE" >&2
fi
exit "$code"
