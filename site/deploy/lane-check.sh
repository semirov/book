#!/bin/bash
# lane-check.sh — "is the writing lane healthy right now?" without a port, a token on argv or a
# host node (BOOK-172).
#
#   site/deploy/lane-check.sh            # engine state, writer container, last writer lines
#   site/deploy/lane-check.sh --state    # only the engine's state (lane holder, leases, counts)
#
# It runs ON THE HOST (`bash site/deploy/lane-check.sh`) and `docker compose exec`s into the engine
# container — the script itself is not in the image (only `entrypoint.sh` and `healthcheck.mjs` are).
# The bearer token is then read from the 0600 file by the process inside the container, so the value
# never reaches this script's argv, the host's `ps`, or a terminal. The same command works for a container left holding a lease — the answer names the
# lease and the step, which is what the runbook needs before a `docker compose restart writer`.
#
# Reads only: no restart, no write, no secret printed.
set -euo pipefail

ROOT="${BOOK_DEPLOY_ROOT:-$HOME/book-deploy}"
COMPOSE_FILE="${BOOK_COMPOSE_FILE:-${ROOT}/site/docker-compose.yml}"
PROJECT="${BOOK_PROJECT:-book}"
DOCKER="${BOOK_DOCKER:-docker}"

dc() { "$DOCKER" compose --env-file /dev/null -f "$COMPOSE_FILE" -p "$PROJECT" "$@"; }

mode="${1:-}"

echo "--- engine state (inside the engine container) ---"
dc exec -T engine node /app/deploy/healthcheck.mjs engine --print
if [ "$mode" = "--state" ]; then exit 0; fi

echo "--- containers ---"
dc ps

echo "--- writer: last lines that name the lane ---"
dc logs --tail 40 writer 2>&1 | grep -F '[writer]' | tail -n 8 || echo "(no [writer] line yet — the lane may still be booting)"
