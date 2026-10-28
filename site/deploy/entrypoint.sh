#!/bin/sh
# site/deploy/entrypoint.sh — the two guards every book container passes before it starts (BOOK-172,
# BOOK-183). Infra, not app code: the service itself knows nothing about either.
#
# 1. THE DATA GUARD (BOOK-183). SQLite in WAL mode shares its `-shm` through the OS. A macOS host
#    bind mount into the OrbStack VM is two kernels: the page cache of one is not the other, and a
#    host `sqlite3` write while `site` held the same file produced `SQLITE_IOERR_SHORT_READ`
#    (2026-10-28). So a role REFUSES to start when `DATA_DIR` resolves, through /proc/self/mountinfo,
#    to a host bind mount — and a named volume (btrfs, root /docker/volumes/…) or a container-local
#    directory passes. Exit 78 (EX_CONFIG) with one readable line: the container restart loop repeats
#    it, and the stack is never half-up on a bind mount.
#
# 2. THE SINGLE-INSTANCE LOCK (BOOK-172). `docker compose` cannot create a second `book-engine-1` in
#    its own project, but nothing stops a second project (`-p other`), a stray `docker run` or a
#    leftover launchd job from starting the same role against the same data dir. A `flock` on a file
#    every runtime can see (the /locks bind) covers all of them, and the kernel releases it the moment
#    the process dies — there is no stale-lock recovery to get wrong.
#
# `BOOK_ROLE` is set by the compose service (`site`|`engine`|`writer`). Unset means "neither guard": a
# one-off `docker compose run`/`exec` stays possible without fighting a running service.
#
# Exit 75 (EX_TEMPFAIL) is the lock holder's refusal, the same code `backup.sh` uses for "another run
# owns this"; the container is then in a restart loop that says why on every line.
set -eu

role="${BOOK_ROLE:-}"
if [ -z "$role" ]; then
  exec "$@"
fi

# --- 1. the data guard --------------------------------------------------------------------------
#
# The mountinfo file is read, never guessed: `BOOK_MOUNTINFO_FILE` exists so a test can feed a
# measured bind and a measured volume without Docker. `DATA_DIR` defaults to `/data`, the mount every
# service in site/docker-compose.yml uses.
#
# The guard FAILS CLOSED, and it looks at every mount related to DATA_DIR — the mount at that path, an
# ancestor, and anything mounted UNDER it (a single file bind at `/data/exchange` is two kernels too,
# for one file). "Related" and "suspicious" are decided separately: a table that cannot be read, or one
# where nothing at all covers DATA_DIR, is a refusal, not a pass.
data_dir="${DATA_DIR:-/data}"
mountinfo="${BOOK_MOUNTINFO_FILE:-/proc/self/mountinfo}"
while [ "${data_dir%/}" != "$data_dir" ] && [ "$data_dir" != "/" ]; do data_dir="${data_dir%/}"; done

# Fields (mountinfo(5)): 4 root, 5 mount point, then ` - ` and fstype + source. `BAD` lines are the
# refusals, `SEEN` counts the entries that are related to DATA_DIR at all. A path with spaces arrives
# octal-escaped (\040); it simply will not match, and the SEEN count still says the table was parsed.
scan=""
if [ -r "$mountinfo" ]; then
  scan="$(awk -v target="$data_dir" '
    {
      sep = 0
      for (i = 7; i <= NF; i++) if ($i == "-") { sep = i; break }
      if (sep == 0) next
      root = $4; point = $5
      related = (point == "/" || target == point \
                 || substr(target, 1, length(point) + 1) == point "/" \
                 || substr(point, 1, length(target) + 1) == target "/")
      if (!related) next
      seen++
      type = $(sep + 1); source = $(sep + 2)
      if (type ~ /^(virtiofs|fuseblk|fuse|9p|nfs|cifs|smb)/ || root ~ /^\/(Users|Volumes|private|host_mnt)(\/|$)/)
        printf "BAD\t%s\t%s\t%s\t%s\n", point, root, type, source
    }
    END { printf "SEEN\t%d\n", seen + 0 }
  ' "$mountinfo" 2>/dev/null || true)"
fi

bad=""
seen=""
if [ -n "$scan" ]; then
  bad="$(printf '%s\n' "$scan" | grep '^BAD' || true)"
  seen="$(printf '%s\n' "$scan" | grep '^SEEN' | cut -f2 || true)"
fi

guard_problem=""
guard_detail=""
if [ ! -r "$mountinfo" ]; then
  guard_problem="the mount table $mountinfo is unreadable, so DATA_DIR=$data_dir cannot be proven to be a volume"
elif [ -z "$seen" ] || [ "$seen" = "0" ]; then
  guard_problem="no mount in $mountinfo covers DATA_DIR=$data_dir, so its filesystem cannot be proven"
elif [ -n "$bad" ]; then
  first="$(printf '%s\n' "$bad" | head -n 1)"
  tab="$(printf '\t')"
  IFS="$tab" read -r _ mount_point mount_root mount_type mount_source <<EOF
$first
EOF
  count="$(printf '%s\n' "$bad" | grep -c '^BAD' || true)"
  guard_problem="DATA_DIR=$data_dir is a host bind mount ($mount_type, root $mount_root, source \"$mount_source\")"
  guard_detail="mount point $mount_point (host filesystem: fstype $mount_type, mount root $mount_root)"
  [ "$count" = "1" ] || guard_detail="$guard_detail; $count related mounts are host filesystems, the first is named above"
fi

if [ -n "$guard_problem" ]; then
  {
    echo "book: refusing to start $role: $guard_problem."
    echo "SQLite in WAL mode shares its -shm through the OS; across the macOS/OrbStack boundary that is two kernels and the file stops being coherent (BOOK-183)."
    echo "Use the named volume \${BOOK_DATA_VOLUME:-book-data}, and run stateful commands inside the container (docker compose exec site …)."
    echo "Detected from $mountinfo, ${guard_detail:-nothing usable to inspect}."
  } >&2
  exit 78
fi

# --- 2. the single-instance lock ----------------------------------------------------------------

locks="${BOOK_LOCKS_DIR:-/locks}"
file="$locks/$role.lock"

if ! command -v flock >/dev/null 2>&1; then
  echo "book: flock is missing from the image — refusing to start $role without a single-instance lock" >&2
  exit 75
fi
if ! mkdir -p "$locks" 2>/dev/null; then
  echo "book: cannot create the lock dir '$locks' — refusing to start $role (is it mounted?)" >&2
  exit 75
fi

# `>>` (append), never `>`: a losing starter must not truncate the holder's pid before it reads it.
# The redirection is TESTED first: `exec 9>>"$file" || { … }` can never speak, because a failed
# redirection on `exec` is a special-builtin error that ends the shell before the `||`.
if ! : >>"$file" 2>/dev/null; then
  echo "book: cannot write '$file' (uid $(id -u)) — refusing to start $role (exit 75)" >&2
  exit 75
fi
exec 9>>"$file"
if ! flock -n 9; then
  holder="$(cat "$file" 2>/dev/null || true)"
  echo "book: another $role holds '$file' (holder: ${holder:-unknown}) — refusing to start (exit 75)" >&2
  exit 75
fi

# `$$` is 1 inside a container (the entrypoint is PID 1), so the host name is written beside it:
# "pid 1" alone reads like launchd on the host and would send an operator looking for the wrong
# process.
printf '%s %s\n' "$$" "$(hostname 2>/dev/null || echo unknown)" >"$file"
echo "book: $role holds '$file' (pid $$)"

exec "$@"
