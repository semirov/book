#!/usr/bin/env bash
#
# site/deploy/restore-drill.sh — restore the newest backup and prove it is the live state (BOOK-28).
#
# A backup nobody restored is a hypothesis. This script copies a backup into a scratch
# directory, opens the copy read-only, checks integrity, compares the row counts that matter
# (chapters, events, comments, changes — plus identities/blocks/revisions) against the live
# database, and proves that every version snapshot in the copy is byte-identical to the live
# one. Nothing is written to the live volume; the copy is deleted at the end.
#
#   ./restore-drill.sh                        # newest daily backup, strict
#   ./restore-drill.sh --backup /path/to/dir  # a specific snapshot
#   ./restore-drill.sh --allow-drift           # older snapshot: live may have moved on
#   ./restore-drill.sh --keep                  # leave the scratch directory for inspection
#
# Cadence: monthly, and after any deploy that carries a migration (see BOOK-DOC-2).
# Exit codes: 0 ok · 1 the backup does not match the live state or is unreadable.
set -euo pipefail
umask 077

export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin

DATA_DIR="${DATA_DIR:-/Users/filipp/book-site-data}"
BACKUP_ROOT="${BACKUP_ROOT:-/Users/filipp/book-site-backups}"
LOG_FILE="${LOG_FILE:-$HOME/Library/Logs/book-backup.log}"

BACKUP=""
ALLOW_DRIFT=0
KEEP=0

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="${2:-}"; shift 2 || usage ;;
    --backup=*) BACKUP="${1#*=}"; shift ;;
    --allow-drift) ALLOW_DRIFT=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done

fail() {
  printf 'drill: FAIL — %s\n' "$*" >&2
  printf '%s\n' "$(date -u +%FT%TZ) level=error job=book-backup-drill status=fail backup="$BACKUP" reason=\"$*\"" >>"$LOG_FILE"
  exit 1
}

[ -f "$DATA_DIR/book.db" ] || fail "live database not found: $DATA_DIR/book.db"

if [ -z "$BACKUP" ]; then
  BACKUP=$(ls -1td "$BACKUP_ROOT"/daily/*/ 2>/dev/null | head -1)
  BACKUP="${BACKUP%/}"
fi
[ -n "$BACKUP" ] && [ -d "$BACKUP" ] || fail "no backup found under $BACKUP_ROOT/daily"
[ -f "$BACKUP/book.db" ] || fail "not a backup directory (no book.db): $BACKUP"
[ -d "$BACKUP/versions" ] || fail "backup has no versions/: $BACKUP"

# --- restore into scratch (same bytes, different directory: that is all a restore is) ------
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/book-restore-drill.XXXXXX")
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    printf 'scratch kept at %s\n' "$SCRATCH"
  else
    rm -rf "$SCRATCH"
  fi
  return 0
}
trap cleanup EXIT

cp -a "$BACKUP/book.db" "$SCRATCH/book.db" || fail "copying book.db failed"
cp -a "$BACKUP/versions" "$SCRATCH/versions" || fail "copying versions/ failed"
chmod 600 "$SCRATCH/book.db"

# --- verify the restored copy ------------------------------------------------------------
integrity=$(sqlite3 -readonly "file:$SCRATCH/book.db?mode=ro" "PRAGMA integrity_check;") \
  || fail "restored copy does not open read-only"
[ "$integrity" = "ok" ] || fail "integrity_check on the restored copy: $(printf '%s' "$integrity" | head -3 | tr '\n' ' ')"

COUNTS_SQL="SELECT 'chapters='||(SELECT count(*) FROM chapters)
  ||' events='||(SELECT count(*) FROM events)
  ||' comments='||(SELECT count(*) FROM comments)
  ||' changes='||(SELECT count(*) FROM changes)
  ||' identities='||(SELECT count(*) FROM identities)
  ||' blocks='||(SELECT count(*) FROM blocks)
  ||' revisions='||(SELECT count(*) FROM revisions);"

restored=$(sqlite3 -readonly "file:$SCRATCH/book.db?mode=ro" "$COUNTS_SQL") || fail "counting rows in the restored copy failed"
live=$(sqlite3 -readonly "$DATA_DIR/book.db" "$COUNTS_SQL") || fail "counting rows in the live database failed"

versions_backup=$(find "$SCRATCH/versions" -type f | wc -l | tr -d ' ')
versions_live=$(find "$DATA_DIR/versions" -type f | wc -l | tr -d ' ')
[ "$versions_backup" -gt 0 ] || fail "restored versions/ is empty"

# Every snapshot that exists in both must be byte-identical; with --allow-drift the live tree
# may legitimately hold files written after the backup.
same_bytes=$(comm -12 \
  <(cd "$SCRATCH/versions" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | sort) \
  <(cd "$DATA_DIR/versions" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | sort) | wc -l | tr -d ' ')
changed=$(comm -23 \
  <(cd "$SCRATCH/versions" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | sort) \
  <(cd "$DATA_DIR/versions" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | sort) | wc -l | tr -d ' ')

status=ok
notes=""
if [ "$restored" != "$live" ]; then
  if [ "$ALLOW_DRIFT" -eq 1 ]; then
    notes="drift=allowed"
  else
    status=fail
  fi
fi
if [ "$versions_backup" != "$versions_live" ] && [ "$ALLOW_DRIFT" -ne 1 ]; then
  status=fail
fi
if [ "$changed" -ne 0 ] && [ "$ALLOW_DRIFT" -ne 1 ]; then
  status=fail
fi

printf 'backup=%s\n' "$BACKUP"
printf 'restored_to=%s\n' "$SCRATCH"
printf 'integrity=ok read_only=ok\n'
printf 'counts_backup: %s\n' "$restored"
printf 'counts_live:   %s\n' "$live"
printf 'versions_backup=%s versions_live=%s identical_files=%s leftover_in_backup=%s\n' \
  "$versions_backup" "$versions_live" "$same_bytes" "$changed"

if [ "$status" != ok ]; then
  printf 'drill: counts or versions disagree with the live state; a backup taken now should match.\n' >&2
  printf '%s\n' "$(date -u +%FT%TZ) level=error job=book-backup-drill status=fail backup=$BACKUP counts_backup=\"$restored\" counts_live=\"$live\" versions_backup=$versions_backup versions_live=$versions_live" >>"$LOG_FILE"
  exit 1
fi

printf '%s\n' "$(date -u +%FT%TZ) level=info job=book-backup-drill status=ok backup=$BACKUP integrity=ok read_only=ok $restored versions_backup=$versions_backup identical_files=$same_bytes $notes" >>"$LOG_FILE"
printf 'drill: ok — the backup restores and matches the live state.\n'
