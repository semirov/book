#!/usr/bin/env bash
#
# site/deploy/restore-drill.sh — restore the newest backup and prove it is the live state (BOOK-28,
# BOOK-183).
#
# A backup nobody restored is a hypothesis. This script copies a backup into a scratch directory, opens
# the COPY on the host (it is a copy — no other process owns it), checks integrity, and compares the row
# counts that matter (chapters, events, comments, changes — plus identities/blocks/revisions) and every
# version snapshot against the LIVE store. Nothing is written to the live store; the copy is deleted at
# the end.
#
# The live side is read the only way it may be read: INSIDE a container on the data volume
# (`${BOOK_DATA_VOLUME:-book-data}`, mounted at `/vol`), with `node`/better-sqlite3 and `sha256sum`. No
# host `sqlite3` ever opens the live `book.db` — since BOOK-183 the live store is a named volume, and a
# host read of a WAL database across the macOS/OrbStack boundary is the two-kernel hazard that produced
# SQLITE_IOERR_SHORT_READ. That also means the drill needs the container runtime: under
# `runtime=launchd` the live DB is a host path with no container to read it from, so the drill refuses
# (it says so and exits 1) instead of opening it from the host.
#
#   ./restore-drill.sh                        # newest daily backup, strict
#   ./restore-drill.sh --backup /path/to/dir  # a specific snapshot
#   ./restore-drill.sh --allow-drift           # older snapshot: live may have moved on
#   ./restore-drill.sh --keep                  # leave the scratch directory for inspection
#
# Environment: BOOK_STATE_DIR (where `runtime` lives), BOOK_DATA_VOLUME, BOOK_IMAGE_TAG (the image the
# one-shot read runs from; default: `last-good-image`, else the running site, else book:dev),
# BOOK_DOCKER, BACKUP_ROOT, LOG_FILE.
#
# Cadence: monthly, and after any deploy that carries a migration (see BOOK-DOC-2).
# Exit codes: 0 ok · 1 the backup does not match the live state, is unreadable, or the live side cannot
# be read without opening the database from the host.
set -euo pipefail
umask 077

# `/usr/local/bin` is where OrbStack installs `docker` on this box (measured): a launchd job and this
# shell do not inherit a login PATH.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

STATE_DIR="${BOOK_STATE_DIR:-${HOME}/.local/state/book-deploy}"
VOLUME="${BOOK_DATA_VOLUME:-book-data}"
DOCKER="${BOOK_DOCKER:-docker}"
BACKUP_ROOT="${BACKUP_ROOT:-/Users/filipp/book-site-backups}"
LOG_FILE="${LOG_FILE:-$HOME/Library/Logs/book-backup.log}"

BACKUP=""
ALLOW_DRIFT=0
KEEP=0

usage() {
  sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'
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
  # Single-quoted format, `%s` arguments: the original put `\"$*\"` inside a double-quoted string, which
  # flagged by shellcheck and which dropped the quoting of the reason in the log line.
  printf '%s\n' "$(date -u +%FT%TZ) level=error job=book-backup-drill status=fail backup=$BACKUP reason=\"$*\"" >>"$LOG_FILE"
  exit 1
}

# --- the live side, read inside a container ------------------------------------------------
#
# One image, resolved the way `flip.sh` does it: an explicit tag, else the last good image, else the
# running site. The volume is mounted rw because a `readonly` open of a WAL database needs the live
# `-shm`; nothing here writes (SELECTs and `sha256sum` only), and the volume is the one place a container
# may open it.
probe_image() {
  local img="" id=""
  if [ -n "${BOOK_IMAGE_TAG:-}" ]; then printf '%s' "$BOOK_IMAGE_TAG"; return 0; fi
  img="$(cat "$STATE_DIR/last-good-image" 2>/dev/null || true)"
  if [ -z "$img" ]; then
    id="$("$DOCKER" compose --env-file /dev/null -p "${BOOK_PROJECT:-book}" ps -q site 2>/dev/null | head -n 1 || true)"
    if [ -z "$id" ]; then
      id="$("$DOCKER" ps -q --filter "label=com.docker.compose.service=site" 2>/dev/null | head -n 1 || true)"
    fi
    if [ -n "$id" ]; then img="$("$DOCKER" inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true)"; fi
  fi
  printf '%s' "${img:-book:dev}"
}

# The default is `launchd`, the same default `backup.sh` and `admin.sh` use: an absent runtime file is the
# pre-container box, and then the live DB is a host path with no container to read it from — the drill
# refuses below rather than guessing `compose` and opening a host file.
runtime="$(cat "$STATE_DIR/runtime" 2>/dev/null || true)"
runtime="${runtime:-launchd}"
if [ "$runtime" != "compose" ]; then
  fail "runtime=$runtime: the live DB is a host path and the drill reads it only through a container (BOOK-183) — run the drill in the container runtime (after the next flip), it will not open book.db from the host"
fi
command -v "$DOCKER" >/dev/null 2>&1 || fail "docker is not on PATH — the live side is read inside a container"
IMAGE="$(probe_image)"
[ -n "$IMAGE" ] || fail "no image to read the live volume with (BOOK_IMAGE_TAG, last-good-image, the running site)"
"$DOCKER" volume inspect "$VOLUME" >/dev/null 2>&1 || fail "no data volume ${VOLUME} — run 'site/deploy/compose-release.sh --status'"
"$DOCKER" run --rm --entrypoint sh -v "$VOLUME":/vol:ro "$IMAGE" -c 'test -f /vol/book.db' >/dev/null 2>&1 \
  || fail "volume ${VOLUME} holds no book.db"

# The live DB, read by a container on the volume. Same key order as COUNTS_SQL below, so the two lines
# compare as strings.
live_counts() {
  "$DOCKER" run --rm --user 501:20 --entrypoint node -w /app -v "$VOLUME":/vol "$IMAGE" -e '
    const D = require("better-sqlite3");
    const db = new D("/vol/book.db");
    const tables = ["chapters", "events", "comments", "changes", "identities", "blocks", "revisions"];
    console.log(tables.map((t) => `${t}=${db.prepare(`SELECT count(*) c FROM ${t}`).get().c}`).join(" "));
    db.close();
  '
}

# The live versions/, hashed inside the same container: `<sha256>  ./chapter/rev.md`, sorted. The backup
# side below hashes its own copy on the host the same way, so `comm` compares like with like.
live_versions_hash() {
  "$DOCKER" run --rm --entrypoint sh -v "$VOLUME":/vol:ro "$IMAGE" -c \
    'cd /vol/versions && find . -type f -print0 | sort -z | xargs -0 sha256sum | sort'
}

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

# --- verify the restored copy (a copy: the host may open it) -------------------------------
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
live="$(live_counts)" || fail "counting rows in the live volume failed (container read on ${VOLUME})"
[ -n "$live" ] || fail "the container read of volume ${VOLUME} came back empty"

versions_backup=$(find "$SCRATCH/versions" -type f | wc -l | tr -d ' ')
versions_live=$(live_versions_hash | wc -l | tr -d ' ')
[ "$versions_backup" -gt 0 ] || fail "restored versions/ is empty"

# Every snapshot that exists in both must be byte-identical; with --allow-drift the live tree may
# legitimately hold files written after the backup. The left-hand list is the host's hash of the copy,
# the right-hand one the container's hash of the live volume.
backup_hashes=$(cd "$SCRATCH/versions" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | sort)
live_hashes="$(live_versions_hash)" || fail "hashing the live versions/ inside the container failed"
same_bytes=$(comm -12 <(printf '%s\n' "$backup_hashes") <(printf '%s\n' "$live_hashes") | wc -l | tr -d ' ')
changed=$(comm -23 <(printf '%s\n' "$backup_hashes") <(printf '%s\n' "$live_hashes") | wc -l | tr -d ' ')

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
printf 'live_read=volume=%s image=%s (inside a container)\n' "$VOLUME" "$IMAGE"
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
