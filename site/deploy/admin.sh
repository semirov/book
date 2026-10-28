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
#            carries DATA_DIR=/data, BOOK_ROOT=/book and the token paths, so nothing is restated here;
#   launchd  the tree serves prod from the host data dir: `node bin/<tool>.mjs …` from `site/`, with
#            DATA_DIR defaulting to the prod host path when the shell does not set it.
#
# Exit codes pass through untouched (the CLIs define their own: 0 ok, 1 refused, 2 usage, …). Nothing
# is printed here; the CLIs print paths, never secret values.
set -euo pipefail

# `/usr/local/bin` is where OrbStack installs `docker` on this box (measured): a launchd job
# and this shell do not inherit a login PATH, and without it the nightly backup fails with exit 127.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE_DIR="${BOOK_STATE_DIR:-${HOME}/.local/state/book-deploy}"
PROJECT="${BOOK_PROJECT:-book}"
COMPOSE_FILE="${BOOK_COMPOSE_FILE:-${ROOT}/site/docker-compose.yml}"
DOCKER="${BOOK_DOCKER:-docker}"
# The prod host data dir the launchd jobs serve from; the same one `flip.sh --to launchd` exports to.
HOST_DATA_DIR="${BOOK_HOST_DATA_DIR:-${HOME}/book-site-data}"

usage() {
  cat <<'EOF'
usage: site/deploy/admin.sh <tool> [args…]
  tools: admin · restore · feedback   (each one's own --help lists its flags)
  e.g.:  site/deploy/admin.sh admin reset book
         site/deploy/admin.sh restore --chapter 9 --rev 3 --dry-run
EOF
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

runtime="$(cat "$STATE_DIR/runtime" 2>/dev/null || true)"
runtime="${runtime:-launchd}"

case "$runtime" in
  compose)
    exec "$DOCKER" compose --env-file /dev/null -f "$COMPOSE_FILE" -p "$PROJECT" exec -T site \
      node "/app/bin/${tool}.mjs" "$@"
    ;;
  launchd)
    export DATA_DIR="${DATA_DIR:-$HOST_DATA_DIR}"
    cd "$ROOT/site"
    exec node "bin/${tool}.mjs" "$@"
    ;;
  *)
    printf 'admin.sh: %s/runtime says "%s", expected compose|launchd — refusing (exit 1)\n' "$STATE_DIR" "$runtime" >&2
    exit 1
    ;;
esac
