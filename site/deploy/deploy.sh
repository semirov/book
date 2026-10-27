#!/bin/bash
# deploy.sh — the only way code reaches prod (BOOK-74).
#
# Prod on the Mac mini: launchd job `dev.book-site` runs `node server/dist/index.js` from
# DEPLOY_ROOT/site with `--env-file=site/.env`; Caddy fronts it. This script is what the
# `Deploy` workflow runs on the self-hosted runner (`mac-mini`); a person runs the same script
# by hand for a rollback. Nothing here talks to GitHub with a stored key: the clone is public
# and fetched over https.
#
#   site/deploy/deploy.sh --ref main              # deploy a branch, tag or sha
#   site/deploy/deploy.sh --ref <sha> --dry-run   # print the plan, touch nothing
#   site/deploy/deploy.sh --rollback              # one command back to the last known good
#
# What it guarantees:
#   * the gate runs here too (typecheck, arch, tests, coverage floor, build, manuscript) — a red
#     gate deploys nothing;
#   * the prod launchd job must already be pointed at this root, otherwise it refuses: silently
#     updating a clone that prod does not run would report a green deploy of nothing;
#   * after `launchctl kickstart -k` it waits for `/healthz` to answer 200 with ok:true;
#   * a failed health check rolls the clone back to the previously deployed commit, rebuilds,
#     restarts, and re-checks — then exits 1 either way, so CI stays red.
#
# Secrets: this script reads no secret and prints no value. `site/.env` is gitignored and is
# never touched by a checkout, `npm ci` or a build — only the service reads it.
set -euo pipefail

ROOT="${BOOK_DEPLOY_ROOT:-$HOME/book-deploy}"
REPO_URL="${BOOK_REPO_URL:-https://github.com/semirov/book.git}"
STATE_DIR="${HOME}/.local/state/book-deploy"
AUDIT_LOG="${STATE_DIR}/deploy-audit.log"
SERVICE_LABEL="${BOOK_SERVICE_LABEL:-dev.book-site}"
PLIST="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
HEALTH_TIMEOUT="${BOOK_HEALTH_TIMEOUT:-60}"
PHASE="prepare"
REF="main"
MODE="deploy"
DRY_RUN=0

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --root) ROOT="${2:?--root needs a value}"; shift 2 ;;
    --rollback) MODE="rollback"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --phase) PHASE="${2:?--phase needs a value}"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT="${2:?--health-timeout needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy: unknown argument: $1" >&2; exit 2 ;;
  esac
done

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '%s deploy: %s\n' "$(now)" "$*"; }
die() { printf '%s deploy: FAILED: %s\n' "$(now)" "$*" >&2; exit 1; }
audit() {
  mkdir -p "$STATE_DIR"
  printf '%s %s\n' "$(now)" "$*" >> "$AUDIT_LOG"
}

# --- the service's own view of the world ------------------------------------------------------
plist_field() {
  [ -f "$PLIST" ] || return 1
  plutil -extract "$1" raw "$PLIST" 2>/dev/null
}

health_url() {
  local host port
  host="$(plist_field EnvironmentVariables.HOST || echo 127.0.0.1)"
  port="$(plist_field EnvironmentVariables.PORT || echo 8091)"
  case "$host" in ''|0.0.0.0|'::'|'*') host=127.0.0.1 ;; esac
  printf 'http://%s:%s/healthz' "$host" "$port"
}

wait_for_health() {
  local url="$1" deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) body
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if body="$(curl -fsS --max-time 3 "$url" 2>/dev/null)" && printf '%s' "$body" | grep -q '"ok":true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

service_root_guard() {
  # Prod must be running *this* checkout. Until the one-time cutover is done (runbook in Lific,
  # BOOK-74) the launchd job still points at the dev tree — deploying here would report success
  # while the site serves something else.
  local workdir
  if ! workdir="$(plist_field WorkingDirectory)"; then
    die "no launchd plist at $PLIST — cannot verify what prod runs; nothing was changed"
  fi
  if [ "$workdir" != "$ROOT/site" ]; then
    die "prod service $SERVICE_LABEL runs from '$workdir', not '$ROOT/site'.
  Refusing to report a deploy of a tree that is not serving. One-time cutover (BOOK-74):
    1. cp $ROOT/site/deploy/dev.book-site.plist.example ~/Library/LaunchAgents/$SERVICE_LABEL.plist
    2. edit BOOK_ROOT=$ROOT and WorkingDirectory=$ROOT/site (keep HOST/PORT/DATA_DIR as they are)
    3. launchctl bootout gui/$(id -u)/$SERVICE_LABEL; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$SERVICE_LABEL.plist
  Do that only after the parallel work is merged into main, then re-run this deploy."
  fi
}

resolve_ref() {
  local want="$1" sha cand
  for cand in "origin/${want}" "${want}" "refs/tags/${want}"; do
    if sha="$(git -C "$ROOT" rev-parse --verify --quiet "${cand}^{commit}")"; then
      printf '%s' "$sha"; return 0
    fi
  done
  return 1
}

kickstart() {
  say "restarting $SERVICE_LABEL"
  launchctl kickstart -k "gui/$(id -u)/$SERVICE_LABEL"
}

# --- prepare: get the wanted commit into the clone --------------------------------------------
if [ "$PHASE" = "prepare" ]; then
  mkdir -p "$STATE_DIR"
  [ -d "$ROOT/.git" ] || die "no deploy clone at $ROOT (the workflow bootstraps it; by hand: git clone $REPO_URL $ROOT)"

  say "fetching $REPO_URL"
  git -C "$ROOT" fetch --quiet --tags --prune origin || die "git fetch failed"

  if [ "$MODE" = "rollback" ]; then
    TARGET="$(cat "$STATE_DIR/last-good" 2>/dev/null || true)"
    [ -n "$TARGET" ] || TARGET="$(git -C "$ROOT" rev-parse --verify HEAD^ 2>/dev/null || true)"
    [ -n "$TARGET" ] || die "nothing to roll back to (no last-good record and no previous commit)"
  else
    TARGET="$(resolve_ref "$REF")" || die "cannot resolve ref '$REF' after fetch"
  fi

  PREV="$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null || true)"
  SHORT="$(git -C "$ROOT" rev-parse --short "$TARGET")"
  say "$MODE -> $SHORT (was ${PREV:0:7})"

  if [ "$DRY_RUN" = "1" ]; then
    say "dry run: would checkout $TARGET, run the gate, kickstart $SERVICE_LABEL, wait for $(health_url)"
    service_root_guard
    say "dry run: prod root matches $ROOT/site"
    exit 0
  fi

  echo "$PREV" > "$STATE_DIR/previous"
  git -C "$ROOT" checkout --quiet --detach "$TARGET" || die "checkout of $SHORT failed"

  # If this deploy replaced this very script, finish with the new copy — no stale half-run.
  SELF="$ROOT/site/deploy/deploy.sh"
  if [ "${BOOK_DEPLOY_REEXEC:-0}" != "1" ]; then
    set -- --phase run --root "$ROOT" --ref "$TARGET" --health-timeout "$HEALTH_TIMEOUT"
    if [ "$MODE" = "rollback" ]; then set -- "$@" --rollback; fi
    exec env BOOK_DEPLOY_REEXEC=1 "$SELF" "$@"
  fi
  PHASE="run"
fi

# --- run: gate, guard, restart, health --------------------------------------------------------
PREV="${PREV:-$(cat "$STATE_DIR/previous" 2>/dev/null || true)}"
command -v npm >/dev/null || die "npm is not on PATH (the deploy workflow sets PATH=/opt/homebrew/bin:…; by hand: export PATH=/opt/homebrew/bin:\$PATH)"
command -v node >/dev/null || die "node is not on PATH (see npm above)"
cd "$ROOT/site"
say "gate: npm ci"
npm ci --no-audit --no-fund >/dev/null 2>&1 || die "npm ci failed at $(git -C "$ROOT" rev-parse --short HEAD)"
say "gate: verify (typecheck, arch, tests)"
npm run verify || die "gate (verify) is red — nothing was deployed or restarted"
say "gate: coverage"
npm run test:coverage || die "coverage floor not met — nothing was deployed or restarted"
say "gate: build"
npm run build || die "build failed — nothing was deployed or restarted"
say "gate: manuscript"
node "$ROOT/site/bin/validate.mjs" --strict || die "manuscript validation is red — nothing was deployed or restarted"

GOOD="$(git -C "$ROOT" rev-parse HEAD)"
service_root_guard
kickstart
URL="$(health_url)"
if wait_for_health "$URL"; then
  mkdir -p "$STATE_DIR"
  echo "$GOOD" > "$STATE_DIR/last-good"
  audit "ok mode=$MODE ref=$REF sha=$GOOD prev=${PREV:0:7} health=200"
  say "healthy: $SHORT at $URL"
  exit 0
fi

say "health check failed at $URL after ${HEALTH_TIMEOUT}s — rolling back"
audit "unhealthy mode=$MODE ref=$REF sha=$GOOD prev=${PREV:0:7} health=fail"
[ -n "$PREV" ] || die "no previous commit to roll back to; prod is NOT healthy — a human must look"
git -C "$ROOT" checkout --quiet --detach "$PREV" || die "rollback checkout failed"
cd "$ROOT/site"
npm ci --no-audit --no-fund >/dev/null 2>&1 || say "warning: npm ci failed during rollback; rebuilding anyway"
npm run build || die "rollback build failed; prod is NOT healthy — a human must look"
kickstart
if wait_for_health "$URL"; then
  echo "$PREV" > "$STATE_DIR/last-good"
  audit "rolled-back sha=$PREV target=$GOOD health=200"
  say "rolled back to ${PREV:0:7}; prod healthy; the deploy of $SHORT stays red"
  exit 1
fi
audit "rollback-failed sha=$PREV target=$GOOD health=fail"
die "rollback did not come up healthy either — prod is DOWN, run: site/deploy/deploy.sh --rollback, then look at ~/Library/Logs/book-site.log"
