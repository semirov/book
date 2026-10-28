#!/bin/sh
# site/deploy/entrypoint.sh — the single-instance lock every book container takes before it starts
# (BOOK-172). Infra, not app code: the service itself knows nothing about it.
#
# Why a second guard beside compose's own service naming: `docker compose` cannot create a second
# `book-engine-1` *in its own project*, but nothing stops a second project (`-p other`), a stray
# `docker run` or a leftover launchd job from starting the same role against the same data dir. A
# `flock` on a file that every runtime can see (a host bind mount) covers all of them, and the
# kernel releases it the moment the process dies — there is no stale-lock recovery to get wrong.
#
# `BOOK_ROLE` is set by the compose service (`site`|`engine`|`writer`). Unset means "no lock": a
# one-off `docker compose run`/`exec` stays possible without fighting a running service.
#
# Exit 75 (EX_TEMPFAIL) is the holder's refusal, the same code `backup.sh` uses for "another run owns
# this"; the container is then in a restart loop that says why on every line.
set -eu

role="${BOOK_ROLE:-}"
if [ -z "$role" ]; then
  exec "$@"
fi

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
