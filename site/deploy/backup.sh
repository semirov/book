#!/usr/bin/env bash
#
# site/deploy/backup.sh — consistent backup of the book data volume (BOOK-28).
#
# The live database runs in WAL mode: a raw `cp book.db` can capture a torn state and misses
# everything still in -wal. This script uses the SQLite online backup API (`sqlite3 .backup`),
# which reads a consistent snapshot without stopping the service, then verifies the copy and
# moves it into a dated directory under a bounded retention.
#
# Layout (default BACKUP_ROOT=/Users/filipp/book-site-backups):
#   daily/20261027T044500/book.db          consistent copy, journal_mode=DELETE
#   daily/20261027T044500/versions/        content-addressed snapshots, complete
#   daily/20261027T044500/manifest.txt     row counts + versions file count + sha256 list
#   weekly/2026-W44/                       first successful run of each ISO week
#
# Retention: 7 daily + 4 weekly directories (11 live copies). Disk growth is therefore
# bounded by 11 x the volume size (DB after checkpoint + versions/), not by time.
#
# Exit codes: 0 ok · 1 failure (see the log line) · 75 another run holds the lock.
# One line per run is appended to $LOG_FILE; nothing is printed unless stdout is a TTY.
set -euo pipefail
umask 077

export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin

DATA_DIR="${DATA_DIR:-/Users/filipp/book-site-data}"
BACKUP_ROOT="${BACKUP_ROOT:-/Users/filipp/book-site-backups}"
LOG_FILE="${LOG_FILE:-$HOME/Library/Logs/book-backup.log}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"

DB="$DATA_DIR/book.db"
VERSIONS="$DATA_DIR/versions"
STARTED=$(date +%s)
TS=$(date +%Y%m%dT%H%M%S)
STAGE=""
DEST=""

log_line() {
  mkdir -p "$(dirname "$LOG_FILE")"
  printf '%s\n' "$1" >>"$LOG_FILE"
  if [ -t 1 ]; then printf '%s\n' "$1"; fi
  return 0
}

cleanup() {
  [ -n "$STAGE" ] && [ -d "$STAGE" ] && rm -rf "$STAGE"
  rmdir "${BACKUP_ROOT:-/nonexistent}/.lock" 2>/dev/null || true
  return 0
}

die() {
  local code="$1"; shift
  cleanup
  log_line "$(date -u +%FT%TZ) level=error job=book-backup status=fail ts=$TS reason=\"$*\" duration_s=$(($(date +%s) - STARTED))"
  if [ ! -t 1 ]; then printf 'book-backup: %s\n' "$*" >&2; fi
  exit "$code"
}
# Anything that fails outside die() (set -e) must still leave no staging dir and no stale lock.
trap 'code=$?; if [ "$code" -ne 0 ]; then rm -rf "${STAGE:-/nonexistent/none}"; rmdir "${BACKUP_ROOT}/.lock" 2>/dev/null || true; fi' EXIT

# --- preflight ---------------------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || die 1 "sqlite3 not found in PATH"
[ -f "$DB" ] || die 1 "database not found: $DB"
[ -d "$VERSIONS" ] || die 1 "versions directory not found: $VERSIONS"

mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly"

LOCK="$BACKUP_ROOT/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || date +%s) ))
  if [ "$age" -gt 21600 ]; then
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || die 75 "cannot take the lock after a stale one (${age}s)"
  else
    die 75 "another run is in progress (lock age ${age}s)"
  fi
fi

# Free space: 3x the current volume size is enough for a staging copy plus one more generation.
src_kb=$(( ($(stat -f %z "$DB") + $(du -sk "$VERSIONS" | cut -f1) * 1024) / 1024 ))
free_kb=$(df -k "$BACKUP_ROOT" | awk 'NR==2 {print $4}')
[ "${free_kb:-0}" -gt $(( src_kb * 3 )) ] || die 1 "not enough free space: ${free_kb}KB free, need $(( src_kb * 3 ))KB"

# --- backup ------------------------------------------------------------------------------
STAGE="$BACKUP_ROOT/.inprogress.$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Online backup API: a consistent snapshot including the rows still in -wal. The service keeps
# running. DELETE journal mode makes the copy self-contained (no -wal/-shm needed to read it).
sqlite3 -cmd ".timeout 10000" "$DB" ".backup '$STAGE/book.db'" \
  || die 1 "sqlite3 .backup failed"
sqlite3 "$STAGE/book.db" "PRAGMA journal_mode=DELETE;" >/dev/null \
  || die 1 "journal_mode=DELETE failed on the copy"

integrity=$(sqlite3 -readonly "$STAGE/book.db" "PRAGMA integrity_check;")
[ "$integrity" = "ok" ] || die 1 "integrity_check on the copy: $(printf '%s' "$integrity" | head -3 | tr '\n' ' ')"
rm -f "$STAGE/book.db-wal" "$STAGE/book.db-shm"

cp -a "$VERSIONS" "$STAGE/versions" || die 1 "copying versions/ failed"

src_files=$(find "$VERSIONS" -type f | wc -l | tr -d ' ')
dst_files=$(find "$STAGE/versions" -type f | wc -l | tr -d ' ')
[ "$src_files" = "$dst_files" ] || die 1 "versions file count differs: source $src_files, copy $dst_files"

# Complete, cheap proof that every snapshot came over intact: sorted path->sha256 lists must match.
src_manifest=$(cd "$VERSIONS" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256)
dst_manifest=$(cd "$STAGE/versions" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256)
[ "$src_manifest" = "$dst_manifest" ] || die 1 "versions checksums differ (file count $src_files)"

counts=$(sqlite3 -readonly "$STAGE/book.db" "SELECT 'chapters='||(SELECT count(*) FROM chapters)
  ||' events='||(SELECT count(*) FROM events)
  ||' comments='||(SELECT count(*) FROM comments)
  ||' changes='||(SELECT count(*) FROM changes)
  ||' identities='||(SELECT count(*) FROM identities)
  ||' blocks='||(SELECT count(*) FROM blocks)
  ||' revisions='||(SELECT count(*) FROM revisions);") \
  || die 1 "recording row counts failed"
[ -n "$counts" ] || die 1 "row counts came back empty"

{
  printf 'taken_at=%s\n' "$(date -u +%FT%TZ)"
  printf 'source=%s\n' "$DB"
  printf 'schema_version=%s\n' "$(sqlite3 -readonly "$STAGE/book.db" 'PRAGMA user_version;')"
  printf 'integrity_check=ok\n'
  printf 'versions_files=%s\n' "$dst_files"
  printf '%s\n' "$counts" | tr ' ' '\n'
  printf 'sha256_db=%s\n' "$(shasum -a 256 "$STAGE/book.db" | cut -d' ' -f1)"
  printf 'sha256_versions:\n%s\n' "$dst_manifest"
} >"$STAGE/manifest.txt" || die 1 "writing manifest failed"

DEST="$BACKUP_ROOT/daily/$TS"
mv "$STAGE" "$DEST" || die 1 "publishing $DEST failed"
STAGE=""

# --- retention ---------------------------------------------------------------------------
# Weekly: the first successful run of an ISO week becomes that week's snapshot.
week="$(date +%G-W%V)"
if [ ! -d "$BACKUP_ROOT/weekly/$week" ]; then
  cp -a "$DEST" "$BACKUP_ROOT/weekly/$week" || die 1 "creating weekly snapshot $week failed"
fi

prune() {
  local dir="$1" keep="$2"
  # newest first; tail drops the kept prefix and deletes the rest (bounded, never the fresh one)
  ls -1t "$dir" 2>/dev/null | tail -n +$(( keep + 1 )) | while IFS= read -r stale; do
    [ -n "$stale" ] || continue
    rm -rf "${dir:?}/$stale"
    printf '%s\n' "$stale"
  done
}
pruned_daily=$(prune "$BACKUP_ROOT/daily" "$KEEP_DAILY" | tr '\n' ',' | sed 's/,$//')
pruned_weekly=$(prune "$BACKUP_ROOT/weekly" "$KEEP_WEEKLY" | tr '\n' ',' | sed 's/,$//')
pruned_total=$(( $(printf '%s' "$pruned_daily" | grep -c . || true) + $(printf '%s' "$pruned_weekly" | grep -c . || true) ))

size=$(du -sh "$DEST" | cut -f1)
rmdir "$LOCK" 2>/dev/null || true
log_line "$(date -u +%FT%TZ) level=info job=book-backup status=ok ts=$TS path=$DEST size=$size integrity=ok versions_files=$dst_files $counts pruned=$pruned_total weekly=$week duration_s=$(($(date +%s) - STARTED))"
