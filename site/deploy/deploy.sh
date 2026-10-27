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
#   * BOOK-119: two real-artifact proofs run after the build. A red one publishes nothing and
#     restarts nothing. The build is then published as an immutable release and `current` is
#     swapped *before* the restart, so the shell a browser gets always has its own assets;
#   * before the restart it reads the box's load and says so (a long window is explained, never
#     hidden, and the deploy still proceeds), takes one baseline probe, and measures the
#     **visible downtime**: the last 200 before `kickstart` to the first 200 after it — not a
#     copy of its own polling window. A site that was already down (`baseline=down`) or never
#     answered reports `restart_ms=unknown`;
#   * `/healthz` is polled every 200 ms with a budget from the box (`BOOK_HEALTH_TIMEOUT`,
#     default 180 s). A timeout is not a verdict: the grace window (`BOOK_HEALTH_GRACE`, 60 s)
#     re-checks, and a 200 naming the commit just built is a **late success** — no rebuild, no
#     second restart;
#   * the same commit is never restarted twice, and only in deploy mode — the one exception is a
#     store that no longer holds the release behind it, and then the log says exactly that. If the
#     running process already serves the previous commit, the deploy checks the frozen frame, points `current`
#     back at `.state/last-good-release` (so disk and process agree) and only then records
#     `last-good`; a rollback whose own result is stale or failed is `rollback-failed` — it never
#     writes `last-good` and never reinstalls the commit it was rolling back from;
#   * a failed `launchctl kickstart` is an audit line and a red deploy, not a silent exit after
#     the publish;
#   * it then checks that the running site serves the frozen frame (BOOK-107): a site that
#     answers /healthz but serves other text is unhealthy, and rolls back the same way;
#   * a checkout that predates the frame check (BOOK-107) deploys without it — the step says so,
#     so an old ref can still be deployed and rolled back to;
#   * a failed health or frame check rolls the clone back to the previously deployed commit,
#     rebuilds, republishes, restarts, and re-checks — then exits 1 either way, so CI stays red.
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
HEALTH_TIMEOUT="${BOOK_HEALTH_TIMEOUT:-180}"       # seconds, the long budget the box actually needs
HEALTH_GRACE="${BOOK_HEALTH_GRACE:-60}"            # seconds re-checked before a rollback is even considered
LOAD_PER_CORE_MAX="${BOOK_LOAD_PER_CORE_MAX:-2.0}" # only decides whether to say so and pause
LOAD_PAUSE="${BOOK_LOAD_PAUSE_S:-60}"              # seconds paused above the threshold, then proceed
PHASE="prepare"
REF="main"
MODE="deploy"
DRY_RUN=0

# Everything the run phase records. Initialised here, before the phase split, because `set -u`
# kills a re-exec'd child that meets an unset variable (BOOK-79 was exactly that).
HEALTH="none"
HEALTH_MS="0"
RESTART_MS="unknown"
RELEASE=""
BUILT_COMMIT=""
LOAD_PER_CORE="unknown"
LOAD_PAUSE_USED=0
SLOW=0
BASELINE="unknown"
BASELINE_AT=0
PERCENT=0
FRAME="n/a"
KICKSTART_T0=""

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

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

BUDGET_MS=$((HEALTH_TIMEOUT * 1000))
GRACE_MS=$((HEALTH_GRACE * 1000))

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '%s deploy: %s\n' "$(now)" "$*"; }
die() { printf '%s deploy: FAILED: %s\n' "$(now)" "$*" >&2; exit 1; }
audit() {
  mkdir -p "$STATE_DIR"
  printf '%s %s\n' "$(now)" "$*" >> "$AUDIT_LOG"
}

# One `key=value` field of a probe's output. Values never contain a space, and some modes print
# their tokens on one line (`baseline`, `load`), so the text is split on spaces too — an anchored
# `^key=` would silently return "" for everything but the first token.
field() { printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1; }

# Is `$1` the commit `$2` names? Args order: (long, reported) — the report may be abbreviated.
starts_with() { case "$1" in "$2"*) return 0 ;; *) return 1 ;; esac; }

# Digits only: an audit field must never be handed to `$(( ))` as a word.
is_number() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# The visible downtime (#3711): the last 200 before the restart to the first 200 after it.
# `unknown` when the site was already down (nothing to lose), when the new build never answered,
# or when the two stamps do not make a window — never a copy of the deploy's polling time.
downtime() { # (baseline_at, first_at, health)
  case "$3" in fast|late) ;; *) printf 'unknown'; return 0 ;; esac
  if is_number "$1" && is_number "$2" && [ "$1" -gt 0 ] && [ "$2" -ge "$1" ]; then
    printf '%s' "$(( $2 - $1 ))"
    return 0
  fi
  printf 'unknown'
}

# The numbers every audit line carries, whatever the outcome (a comparable record of the box).
audit_tail() { # (restart_ms, health_ms, budget_pct, baseline)
  printf 'restart_ms=%s health_ms=%s budget_ms=%s budget_pct=%s load=%s/core load_pause=%s slow=%s baseline=%s' \
    "$1" "$2" "$BUDGET_MS" "$3" "$LOAD_PER_CORE" "$LOAD_PAUSE_USED" "$SLOW" "$4"
}

# `build-info.json` is what the running process reports as `/healthz.commit` (BOOK-109). The
# full sha in git is the audit's id; the build's own short sha is the identity to compare, and
# `BOOK_BUILD_COMMIT` may have overridden it — read the file the build wrote, never guess.
built_commit() {
  node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync("build-info.json","utf8")).commit||"")}catch{}' 2>/dev/null
}

# --- the service's own view of the world ------------------------------------------------------
plist_field() {
  [ -f "$PLIST" ] || return 1
  plutil -extract "$1" raw "$PLIST" 2>/dev/null
}

health_url() {
  printf '%s/healthz' "$(site_url)"
}

site_url() {
  local host port
  host="$(plist_field EnvironmentVariables.HOST || echo 127.0.0.1)"
  port="$(plist_field EnvironmentVariables.PORT || echo 8091)"
  case "$host" in ''|0.0.0.0|'::'|'*') host=127.0.0.1 ;; esac
  printf 'http://%s:%s' "$host" "$port"
}

# The commit the process answers with, or a failed command when it is not healthy. Used for the
# one question the rollback must ask before doing anything: "does this process already serve
# the old code?" — a second restart of the same commit is the defect this pass removes.
running_commit() {
  local body
  body="$(curl -fsS --max-time 2 "$1" 2>/dev/null)" || return 1
  printf '%s' "$body" | grep -q '"ok":true' || return 1
  printf '%s' "$body" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p'
}

# `restart-probe.mjs wait` from KICKSTART_T0 — one implementation for the deploy and the
# rollback, so "healthy" cannot mean two things.
probe_wait() {
  local args=(--url "$1" --since "$KICKSTART_T0" --budget-ms "$BUDGET_MS" --grace-ms "$GRACE_MS" --expect-commit "$2")
  if [ -n "$3" ]; then args+=(--prev-commit "$3"); fi
  node "$ROOT/site/scripts/restart-probe.mjs" wait "${args[@]}" 2>/dev/null
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

frame_check() {
  # BOOK-107: /healthz says the process is alive, not that it serves the canon. The check is
  # read-only, makes one attempt per chapter inside one 25 s budget, and writes nothing. A
  # checkout that predates the check has no script — skip it loudly, never fail on absence.
  [ -f "$ROOT/site/scripts/frame-check.mjs" ] || { say "this checkout predates the frame check (BOOK-107) — skipping"; return 0; }
  local args=(--repo-root "$ROOT" --server "$(site_url)") data_dir
  if data_dir="$(plist_field EnvironmentVariables.DATA_DIR)" && [ -n "$data_dir" ]; then
    args+=(--data-dir "$data_dir")
  fi
  node "$ROOT/site/scripts/frame-check.mjs" "${args[@]}"
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
    say "dry run: would checkout $TARGET, run the gate, proof and publish, kickstart $SERVICE_LABEL, wait for $(health_url)"
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

# --- run: gate, proof, load, publish, restart, health ------------------------------------------
PREV="${PREV:-$(cat "$STATE_DIR/previous" 2>/dev/null || true)}"
# The prepare phase re-execs this script for the run phase, and the re-exec carries no SHORT from
# that process: recompute it here, or `set -u` kills a deploy that is already healthy (BOOK-79).
SHORT="$(git -C "$ROOT" rev-parse --short HEAD)"
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

# BOOK-119: the two proofs run on the build that just landed in `dist/staging`. They read real
# bytes: a red proof means an asset URL would not survive the next publish or the guard would
# not speak — and then nothing is published and nothing is restarted.
say "gate: proof (old asset survives a publish; the guard speaks without a bundle)"
npm run proof || die "proof is red — nothing was published or restarted"

GOOD="$(git -C "$ROOT" rev-parse HEAD)"
BUILT_COMMIT="$(built_commit)"
[ -n "$BUILT_COMMIT" ] || die "build-info.json carries no commit — the deploy cannot name the build it made"
service_root_guard

# The box, not an ideal machine (BOOK-119 #3711): at load ~40 on 10 cores a healthy boot took
# longer than 60 s. Say what the box is doing; pause once above the threshold; never refuse.
LOAD_OUT="$(node "$ROOT/site/scripts/restart-probe.mjs" load --max-per-core "$LOAD_PER_CORE_MAX" 2>/dev/null || true)"
LOAD_L1="$(field "$LOAD_OUT" load)"
LOAD_CORES="$(field "$LOAD_OUT" cores)"
LOAD_PER_CORE="$(field "$LOAD_OUT" per_core)"
LOAD_ABOVE="$(field "$LOAD_OUT" above)"
[ -n "$LOAD_PER_CORE" ] || LOAD_PER_CORE="unknown"
say "load guard: load=${LOAD_L1:-unknown} on ${LOAD_CORES:-unknown} cores = ${LOAD_PER_CORE}/core"
if [ "${LOAD_ABOVE:-0}" = "1" ]; then
  say "load guard: ${LOAD_PER_CORE}/core is above ${LOAD_PER_CORE_MAX} — pausing ${LOAD_PAUSE}s before the restart; the deploy window is longer on purpose, the deploy still happens"
  sleep "$LOAD_PAUSE"
  LOAD_PAUSE_USED="$LOAD_PAUSE"
fi

# Publish after a green proof, before the restart: for seconds the old process serves the new
# shell's API — compatible by construction, and it is what makes the restart asset-safe.
say "publish: release"
npm run release:publish -- --state "$STATE_DIR" || die "publish failed — current is untouched, nothing was restarted"
RELEASE="$(readlink "$ROOT/site/web/dist/current" 2>/dev/null | sed 's|.*/||')"
[ -n "$RELEASE" ] || RELEASE="unknown"
say "publish: current -> release $RELEASE"

URL="$(health_url)"
BASELINE="down"
BASELINE_AT=0
BASE_OUT="$(node "$ROOT/site/scripts/restart-probe.mjs" baseline --url "$URL" 2>/dev/null || true)"
BASELINE="$(field "$BASE_OUT" probe)"
BASELINE="${BASELINE:-down}"
BASELINE_AT="$(field "$BASE_OUT" at)"
BASELINE_AT="${BASELINE_AT:-0}"
say "restart baseline: $BASELINE at $URL — last 200 before the restart at ${BASELINE_AT} (0 = the site was already down, not attributed to this deploy)"

# BOOK-119 review: `set -e` used to end the run here on a failed `launchctl kickstart` — after
# the publish, with `current` already on the new release and no audit line at all. A failed
# signal is a health outcome, and the red path below asks whether the previous commit serves.
KICKSTART_T0="$(node -p 'Date.now()')"
HEALTH_OUT=""
if kickstart; then
  set +e
  HEALTH_OUT="$(probe_wait "$URL" "$BUILT_COMMIT" "$PREV")"
  set -e
else
  say "kickstart failed: the job was not signalled — the previous process is still serving"
fi
HEALTH="$(field "$HEALTH_OUT" health)"
HEALTH="${HEALTH:-fail}"
HEALTH_MS="$(field "$HEALTH_OUT" health_ms)"
HEALTH_MS="${HEALTH_MS:-0}"
FIRST_AT="$(field "$HEALTH_OUT" first_at)"
REPORTED_COMMIT="$(field "$HEALTH_OUT" commit)"
# Visible downtime (#3711): the last 200 before the restart to the first 200 after it — a fact
# about the site, not `health_ms`, which is the deploy's own polling window (dead time included).
RESTART_MS="$(downtime "$BASELINE_AT" "$FIRST_AT" "$HEALTH")"
PERCENT=0
if is_number "$HEALTH_MS" && [ "$BUDGET_MS" -gt 0 ]; then PERCENT=$((HEALTH_MS * 100 / BUDGET_MS)); fi

if [ -z "$HEALTH_OUT" ]; then
  say "no healthz window was measured: the restart did not happen (see above)"
elif [ "$HEALTH" = "fast" ]; then
  say "healthz ok after ${HEALTH_MS} ms = ${PERCENT}% of the ${BUDGET_MS} ms budget (poll 200 ms, ±200 ms resolution)"
elif [ "$HEALTH" = "late" ]; then
  SLOW=1
  say "healthz ok LATE after ${HEALTH_MS} ms = ${PERCENT}% of the ${BUDGET_MS} ms budget; the budget ran out but the process now serves ${BUILT_COMMIT}: late success, no rebuild, no second restart"
elif [ "$HEALTH" = "stale" ]; then
  say "healthz answers ${REPORTED_COMMIT:-unknown}, the previous build — the new code (${BUILT_COMMIT}) never served after ${HEALTH_MS} ms; not restarting the same commit twice"
else
  say "healthz did not answer ${BUILT_COMMIT} after ${HEALTH_MS} ms (budget ${BUDGET_MS} ms + grace ${GRACE_MS} ms)"
fi
if [ "$HEALTH" = "fast" ] || [ "$HEALTH" = "late" ]; then
  say "time-to-first-200 ${HEALTH_MS} ms = ${PERCENT}% of the ${BUDGET_MS} ms budget; visible downtime ${RESTART_MS} ms (baseline ${BASELINE} at ${BASELINE_AT}, first 200 at ${FIRST_AT})"
fi

if [ "$HEALTH" = "fast" ] || [ "$HEALTH" = "late" ]; then
  say "checking the frozen frame"
  # Exit 0 is the only success. A mismatch (1) means the running site serves text that is not
  # the canon; a usage error (2) means this checkout cannot even run its own script. Both are
  # this deploy being unhealthy, so both take the rollback path below — never `exit 0`.
  if frame_check; then
    FRAME="ok"
    mkdir -p "$STATE_DIR"
    echo "$GOOD" > "$STATE_DIR/last-good"
    if [ -n "$RELEASE" ] && [ "$RELEASE" != "unknown" ]; then echo "$RELEASE" > "$STATE_DIR/last-good-release"; fi
    audit "ok mode=$MODE ref=$REF sha=$GOOD prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=ok restart=ran $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
    say "healthy: $SHORT at $URL; time-to-first-200 ${HEALTH_MS} ms = ${PERCENT}% of ${BUDGET_MS} ms, visible downtime ${RESTART_MS} ms, load ${LOAD_PER_CORE}/core"
    exit 0
  fi
  say "the running site does not serve the frozen frame — rolling back"
  FRAME="fail"
fi

# --- red path ----------------------------------------------------------------------------------
# The defect in BOOK-119 #3711: a timeout rebuilt the same commit and restarted again. Before
# anything is rebuilt, ask two questions — is the process already serving the previous commit,
# and does it serve the canon? Only then may `last-good` record it.
#
# In `--rollback` mode `PREV` is re-read from `$STATE_DIR/previous`: it is the commit being rolled
# back *from*. Skipping there would write the bad commit as last-good and hand the die-message a
# command that reinstalls it — so the skip is deploy-only, and a rollback that did not reach its
# own commit is `rollback-failed` and never touches `last-good`.
ROLLBACK_SKIPPED=0
ALREADY=""
if [ "$MODE" = "deploy" ] && [ -n "$PREV" ]; then
  ALREADY="$(running_commit "$URL" || true)"
fi
if [ -n "$ALREADY" ] && starts_with "$PREV" "$ALREADY"; then
  say "the running process already serves ${PREV:0:7} — checking the frame and the release on disk before anything is written"
  if frame_check; then
    FRAME="ok"
    # `current` still names the release that just failed. Publish and prune never remove the
    # release `.state/last-good-release` records, so pointing `current` back at it makes disk and
    # process agree — otherwise the next restart serves the red shell this deploy just refused.
    LAST_GOOD_RELEASE="$(cat "$STATE_DIR/last-good-release" 2>/dev/null || true)"
    if [ -n "$LAST_GOOD_RELEASE" ] && node "$ROOT/site/scripts/release.mjs" swap --id "$LAST_GOOD_RELEASE" >/dev/null 2>&1; then
      ROLLBACK_SKIPPED=1
      RELEASE="$LAST_GOOD_RELEASE"
      say "current -> release $RELEASE (a moment ago it named the failed publish)"
    else
      say "the release behind ${PREV:0:7} is not in the store (last-good-release='${LAST_GOOD_RELEASE:-none}') — rebuilding it so disk and process agree"
    fi
  else
    # The process answers, but not with the canon: `last-good` must not record it, and a restart
    # of the same commit would not change what the data says.
    FRAME="fail"
    say "the running process answers ${PREV:0:7} but does not serve the frozen frame; last-good was NOT written — a human must look at the canon"
    audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$BUILT_COMMIT release=$RELEASE health=$HEALTH frame=fail restart=skipped $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
    exit 1
  fi
fi

if [ "$ROLLBACK_SKIPPED" = "1" ]; then
  say "the running process already serves ${PREV:0:7} and is healthy — no npm ci, no rebuild, no publish, no second restart"
  mkdir -p "$STATE_DIR"
  echo "$PREV" > "$STATE_DIR/last-good" # `last-good-release` already names $RELEASE
  audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$BUILT_COMMIT release=$RELEASE health=$HEALTH frame=ok restart=skipped $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  say "deploy of $SHORT is red; prod still serves ${PREV:0:7}, current is back on release $RELEASE — the process was not restarted"
  exit 1
fi

# A rollback that did not reach its own commit has nothing better behind it: the generic path
# below would check out `PREV`, which in this mode is the commit the rollback exists to leave.
if [ "$MODE" = "rollback" ]; then
  ROLLBACK_RESTART=failed
  case "$HEALTH" in fast|late) ROLLBACK_RESTART=ran ;; esac
  audit "rollback-failed mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=$FRAME restart=$ROLLBACK_RESTART release=$RELEASE $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "the rollback did not come up healthy (health=$HEALTH frame=$FRAME, prod reports ${REPORTED_COMMIT:-nothing}) — prod is DOWN, a human must look"
fi

[ -n "$PREV" ] || die "no previous commit to roll back to; prod is NOT healthy — a human must look"
say "rolling back to ${PREV:0:7}: the running process does not serve it"
git -C "$ROOT" checkout --quiet --detach "$PREV" || die "rollback checkout failed"
cd "$ROOT/site"
npm ci --no-audit --no-fund >/dev/null 2>&1 || say "warning: npm ci failed during rollback; rebuilding anyway"
npm run build || die "rollback build failed; prod is NOT healthy — a human must look"
npm run release:publish -- --state "$STATE_DIR" || die "rollback publish failed; prod is NOT healthy — a human must look"
RELEASE="$(readlink "$ROOT/site/web/dist/current" 2>/dev/null | sed 's|.*/||')"
ROLLBACK_COMMIT="$(built_commit)"
# The rollback restarts too, so it takes its own baseline: the line must state what the site lost
# in this restart, not reuse the numbers of the attempt that failed.
BASELINE="down"
BASELINE_AT=0
BASE_OUT="$(node "$ROOT/site/scripts/restart-probe.mjs" baseline --url "$URL" 2>/dev/null || true)"
BASELINE="$(field "$BASE_OUT" probe)"
BASELINE="${BASELINE:-down}"
BASELINE_AT="$(field "$BASE_OUT" at)"
BASELINE_AT="${BASELINE_AT:-0}"
KICKSTART_T0="$(node -p 'Date.now()')"
ROLLBACK_OUT=""
if kickstart; then
  set +e
  ROLLBACK_OUT="$(probe_wait "$URL" "$ROLLBACK_COMMIT" "$BUILT_COMMIT")"
  set -e
else
  say "kickstart failed during the rollback: the job was not signalled"
fi
HEALTH="$(field "$ROLLBACK_OUT" health)"
HEALTH="${HEALTH:-fail}"
HEALTH_MS="$(field "$ROLLBACK_OUT" health_ms)"
HEALTH_MS="${HEALTH_MS:-0}"
RESTART_MS="$(downtime "$BASELINE_AT" "$(field "$ROLLBACK_OUT" first_at)" "$HEALTH")"
PERCENT=0
if is_number "$HEALTH_MS" && [ "$BUDGET_MS" -gt 0 ]; then PERCENT=$((HEALTH_MS * 100 / BUDGET_MS)); fi
say "rollback healthz: $HEALTH after ${HEALTH_MS} ms = ${PERCENT}% of ${BUDGET_MS} ms; visible downtime ${RESTART_MS} ms"
if [ "$HEALTH" = "fast" ] || [ "$HEALTH" = "late" ]; then
  say "checking the frozen frame of the rollback"
  if frame_check; then
    FRAME="ok"
    echo "$PREV" > "$STATE_DIR/last-good"
    if [ -n "$RELEASE" ]; then echo "$RELEASE" > "$STATE_DIR/last-good-release"; fi
    audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=ok restart=ran release=$RELEASE $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
    say "rolled back to ${PREV:0:7}; prod healthy; the deploy of $SHORT stays red"
    exit 1
  fi
  FRAME="fail"
  say "the rollback answers but does not serve the frozen frame; last-good was NOT written"
fi
# The audit must not contradict itself: this path did restart once, and a late answer is slow.
ROLLBACK_RESTART=failed
if [ "$HEALTH" = "fast" ] || [ "$HEALTH" = "late" ]; then ROLLBACK_RESTART=ran; fi
if [ "$HEALTH" = "late" ]; then SLOW=1; fi
audit "rollback-failed mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=$FRAME restart=$ROLLBACK_RESTART release=$RELEASE $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
die "rollback did not come up healthy either — prod is DOWN, a human must look; the audit names release=${RELEASE:-unknown}, health=$HEALTH, frame=$FRAME (log: ~/Library/Logs/book-site.log)"
