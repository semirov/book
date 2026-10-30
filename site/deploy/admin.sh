#!/usr/bin/env bash
#
# site/deploy/admin.sh — the operator wrapper for the stateful CLIs (BOOK-183).
#
# The book's database belongs to the containers: since BOOK-183 it lives in the `book-data` volume,
# and no host process may open it (a bind-mounted SQLite in WAL mode across the macOS/OrbStack
# boundary is two kernels — the `SQLITE_IOERR_SHORT_READ` incident). So the operator's commands run
# INSIDE the `site` container and this script is the only shape they are typed in:
#
#   site/deploy/admin.sh admin reset book            # -> node /app/bin/admin.mjs reset book (in site)
#   site/deploy/admin.sh admin --help
#   site/deploy/admin.sh restore --chapter 9 --rev 3 --dry-run
#   site/deploy/admin.sh feedback --list
#
# It dispatches on `$STATE_DIR/runtime` (written by `flip.sh`), the same way `backup.sh` does:
#   compose  `docker compose exec -T site node /app/bin/<tool>.mjs …` — the container's env already
#            carries DATA_DIR=/data and the token paths, so nothing is restated here (BOOK-187: no
#            BOOK_ROOT — the image's root is the canon's home);
#   launchd  the tree serves prod from the host data dir: `node bin/<tool>.mjs …` from `site/`, with
#            DATA_DIR defaulting to the prod host path when the shell does not set it.
#
# **The doctor is the one exception** (BOOK-236): `doctor` is a HOST CLI by design — half of its
# rows are host facts (docker, mountinfo, the host backups, the drill log), and `GET
# /api/admin/doctor` carries only the DB half. Exec'd into the container it answered `spawn docker
# ENOENT` for seven of eight rows, so under `compose` the wrapper reads the published site port,
# copies the container's `/data/admin.token` into a `0600` temp file (never into an argument, never
# onto the screen), runs the host CLI against that address, and deletes the file on every exit
# path. Exit codes pass through untouched (the CLIs define their own: 0 ok, 1 refused, 2 usage,
# 3 no admin token, 4 non-local target, …).
#
# `BOOK_ADMIN_SH_DRY_RUN=1` (or `--print-command` among a tool's arguments, e.g. `admin doctor
# --print-command`) prints the command SHAPE this run would use — paths, flags, and `<token file>`
# in place of the token — and exits 0 without running anything (no docker, no node). It is how the
# dispatch itself is tested.
#
# Nothing else is printed here; the CLIs print paths, never secret values.
set -euo pipefail

# `/usr/local/bin` is where OrbStack installs `docker` on this box (measured): a launchd job
# and this shell do not inherit a login PATH, and without it the nightly backup fails with exit 127.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
STATE_DIR="${BOOK_STATE_DIR:-${HOME}/.local/state/book-deploy}"
PROJECT="${BOOK_PROJECT:-book}"
COMPOSE_FILE="${BOOK_COMPOSE_FILE:-${ROOT}/site/docker-compose.yml}"
DOCKER="${BOOK_DOCKER:-docker}"
# The prod host data dir the launchd jobs serve from; the same one `flip.sh --to launchd` exports to.
HOST_DATA_DIR="${BOOK_HOST_DATA_DIR:-${HOME}/book-site-data}"
# The host CLI, by its REAL path (BOOK-236): the deploy root `~/book-deploy` is a symlink
# (BOOK-DOC-46) and Node resolves `import.meta.url` to the real file, so a CLI started through the
# symlinked path failed its own entry test — no output, exit 0. Running it at the real path means
# the wrapper does not depend on that guard at all.
HOST_CLI="$(cd "$ROOT/site" && pwd -P)/bin/admin.mjs"

# The doctor's temp token file, removed by the one trap below on every exit path. Global on
# purpose: the trap outlives the function that made it.
TOKEN_FILE=""
cleanup_token() {
  if [ -n "$TOKEN_FILE" ]; then rm -f "$TOKEN_FILE"; fi
}
# EXIT covers every normal return and every `exit`; the signals a terminal or a launchd kill sends
# get their own trap, because a bare EXIT trap does not run for a default-terminated `HUP` — and a
# `0600` token file left on the box is exactly what this item exists to prevent.
trap cleanup_token EXIT
trap 'cleanup_token; exit 130' INT TERM HUP QUIT

usage() {
  cat <<'EOF'
usage: site/deploy/admin.sh <tool> [args…]
  tools: admin · restore · feedback   (each one's own --help lists its flags)
  e.g.:  site/deploy/admin.sh admin reset book
         site/deploy/admin.sh restore --chapter 9 --rev 3 --dry-run
         site/deploy/admin.sh admin doctor            # runs on THIS host, against the published port
  --print-command   print the command shape and run nothing (also BOOK_ADMIN_SH_DRY_RUN=1)
EOF
}

# `docker compose` with the flags every call in this tree uses; `/dev/null` as the env file so the
# checkout's `.env` can never change what a project name means (compose-release.sh, BOOK-119).
dc() {
  "$DOCKER" compose --env-file /dev/null -f "$COMPOSE_FILE" -p "$PROJECT" "$@"
}

# The address the site is published on, as the host sees it: `docker compose port` answers
# `192.168.1.76:8091`, or `0.0.0.0:8091` / `[::]:8091` when the publish names every interface.
# A wildcard publish includes loopback — the only kind of address the admin token may travel to —
# so the wildcard is read as `127.0.0.1` rather than guessed as one LAN interface. One line and
# exit 1 when the port is not published: an address nobody can reach is not a target.
published_address() {
  local published
  published="$(dc port site 8080 2>/dev/null || true)"
  published="${published##*$'\n'}"
  if [ -z "$published" ]; then
    printf 'admin.sh: the site container publishes no port 8080 (%s / %s) — the doctor has no target (exit 1)\n' \
      "$PROJECT" "$COMPOSE_FILE" >&2
    return 1
  fi
  local host="${published%:*}"
  local port="${published##*:}"
  case "$host" in
    0.0.0.0|'[::]'|'::'|'') host=127.0.0.1 ;;
  esac
  printf '%s:%s' "$host" "$port"
}

# Does the operator name a target already? `--url`/`--url=` reach the CLI untouched, and
# `BOOK_ADMIN_URL` is read by the CLI itself — the wrapper only supplies a default.
operator_target() {
  if [ -n "${BOOK_ADMIN_URL:-}" ]; then return 0; fi
  for arg in "$@"; do
    case "$arg" in
      --url|--url=*) return 0 ;;
    esac
  done
  return 1
}

# The doctor under `compose`: the host CLI, the container's token, a temp file. Nothing secret is
# echoed, and the file leaves with `cleanup_token` whichever way this process ends.
run_doctor_on_host() {
  local status=0
  # `--help` never needs the stack: no port to resolve, no token to read, nothing to leak.
  for arg in "$@"; do
    case "$arg" in
      -h|--help) exec node "$HOST_CLI" "$@" ;;
    esac
  done
  # The shape next: a dry run must resolve nothing, so the address stays a placeholder there.
  if [ "$DRY_RUN" = 1 ]; then
    printf 'admin.sh: doctor runs on the host — the preflight reads host facts; the token crosses as a 0600 temp file, never as an argument\n'
    printf '  %s compose --env-file /dev/null -f %s -p %s port site 8080\n' "$DOCKER" "$COMPOSE_FILE" "$PROJECT"
    printf '  ADMIN_TOKEN_FILE=<token file> node %s' "$HOST_CLI"
    for arg in "$@"; do
      if [ "$arg" = "--print-command" ]; then continue; fi
      printf ' %s' "$arg"
    done
    if ! operator_target "$@"; then printf ' --url http://<published address>'; fi
    printf '\n'
    return 0
  fi

  # The operator's own target (`--url`, or `BOOK_ADMIN_URL` which the CLI reads itself) wins; the
  # wrapper only supplies the default: the address the site is published on.
  local url=""
  if ! operator_target "$@"; then
    url="http://$(published_address)"
  fi

  # Belt and braces: `mktemp` already creates the file 0600, and anything written on this path
  # later inherits this mask.
  umask 077
  TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/book-admin-token.XXXXXX")"
  # The container's token, straight into the file: not through this shell, not through argv.
  if ! dc exec -T site sh -c 'cat /data/admin.token' >"$TOKEN_FILE" 2>/dev/null; then
    printf 'admin.sh: cannot read the admin token from the site container (path /data/admin.token) — is the stack up? (exit 3)\n' >&2
    exit 3
  fi
  # A token file holding only whitespace is a token that is not there: the CLI would read it as
  # empty and refuse, so the wrapper refuses first — with the path, and with the same exit 3.
  if ! grep -q '[^[:space:]]' "$TOKEN_FILE" 2>/dev/null; then
    printf 'admin.sh: the site container answered with an empty token (path /data/admin.token) (exit 3)\n' >&2
    exit 3
  fi

  if [ -n "$url" ]; then
    ADMIN_TOKEN_FILE="$TOKEN_FILE" node "$HOST_CLI" "$@" --url "$url" || status=$?
  else
    ADMIN_TOKEN_FILE="$TOKEN_FILE" node "$HOST_CLI" "$@" || status=$?
  fi
  exit "$status"
}

# What the dry run prints for a command that stays in its usual place.
print_shape() {
  local tool_name="$1"
  shift
  printf '  '
  if [ "$runtime" = compose ]; then
    printf '%s compose --env-file /dev/null -f %s -p %s exec -T site node /app/bin/%s.mjs' \
      "$DOCKER" "$COMPOSE_FILE" "$PROJECT" "$tool_name"
  else
    printf 'DATA_DIR=%s node %s/site/bin/%s.mjs' "${DATA_DIR:-$HOST_DATA_DIR}" "$ROOT" "$tool_name"
  fi
  for arg in "$@"; do
    if [ "$arg" = "--print-command" ]; then continue; fi
    printf ' %s' "$arg"
  done
  printf '\n'
}

tool="${1:-}"
case "$tool" in
  admin|restore|feedback) shift ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  "")
    usage >&2
    exit 2
    ;;
  *)
    printf 'admin.sh: unknown tool "%s" (admin|restore|feedback)\n' "$tool" >&2
    usage >&2
    exit 2
    ;;
esac

# The shape switch: an operator's look-before-you-run, and the seam the dispatch test reads.
DRY_RUN="${BOOK_ADMIN_SH_DRY_RUN:-0}"
for arg in "$@"; do
  if [ "$arg" = "--print-command" ]; then DRY_RUN=1; fi
done

# The sub-command, read past the shape flag: `admin --print-command doctor` is still the doctor.
SUB=""
for arg in "$@"; do
  if [ "$arg" = "--print-command" ]; then continue; fi
  SUB="$arg"
  break
done

runtime="$(cat "$STATE_DIR/runtime" 2>/dev/null || true)"
runtime="${runtime:-launchd}"

case "$runtime" in
  compose)
    if [ "$tool" = admin ] && [ "$SUB" = doctor ]; then
      run_doctor_on_host "$@"
      exit $?
    fi
    if [ "$DRY_RUN" = 1 ]; then
      print_shape "$tool" "$@"
      exit 0
    fi
    exec "$DOCKER" compose --env-file /dev/null -f "$COMPOSE_FILE" -p "$PROJECT" exec -T site \
      node "/app/bin/${tool}.mjs" "$@"
    ;;
  launchd)
    export DATA_DIR="${DATA_DIR:-$HOST_DATA_DIR}"
    if [ "$DRY_RUN" = 1 ]; then
      print_shape "$tool" "$@"
      exit 0
    fi
    cd "$ROOT/site"
    exec node "bin/${tool}.mjs" "$@"
    ;;
  *)
    printf 'admin.sh: %s/runtime says "%s", expected compose|launchd — refusing (exit 1)\n' "$STATE_DIR" "$runtime" >&2
    exit 1
    ;;
esac
