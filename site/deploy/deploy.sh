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
#   * the gate runs here too (typecheck, arch, tests, coverage floor, build, manuscript, and the
#     F023 release check on the built bundle) — a red gate deploys nothing;
#   * the prod launchd job must already be pointed at this root, otherwise it refuses: silently
#     updating a clone that prod does not run would report a green deploy of nothing;
#   * BOOK-119: two real-artifact proofs run after the build, and BOOK-157 adds a third over the
#     same bytes (the manifest, its icons and the service worker). A red one publishes nothing and
#     restarts nothing. The build is then published as an immutable release and `current` is
#     swapped *before* the restart, so the shell a browser gets always has its own assets;
#   * before the restart it reads the box's load and says so (a long window is explained, never
#     hidden, and the deploy still proceeds), takes one baseline read, and measures the
#     **visible downtime**: the last 200 before `kickstart` to the first 200 after it — not a
#     copy of its own polling window;
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
#   * and that an install is possible (BOOK-157): `/manifest.webmanifest` is `+json` and parses,
#     `/sw.js` is `text/javascript` with `cache-control: no-cache`. A red smoke takes the frame
#     check's red path and `last-good` is not written;
#   * a checkout that predates the frame check (BOOK-107) deploys without it — the step says so,
#     so an old ref can still be deployed and rolled back to;
#   * a failed health or frame check rolls the clone back to the previously deployed commit,
#     rebuilds, republishes, restarts, and re-checks — then exits 1 either way, so CI stays red.
#
# BOOK-119 hotfix (the deploys of 523f234 and 230a62f that went red while succeeding):
#   * **one probe, one result shape.** `lib.sh:health_read` is a plain `curl --max-time 2` — the
#     same call for the baseline, the restart window and every re-read — so they cannot disagree.
#     The baseline is `up` only on a real 200 with `"ok":true`, `down` only on a real non-200
#     answer, and `unknown` when the read could not be made; the audit carries `err=<curl exit>`
#     and the log carries curl's own line. A measurement that failed is never the site being dead;
#   * the window always has a real elapsed time: it reads once before it looks at any deadline,
#     and a `health=fail` that did not spend its budget is measured again — `fail after 0 ms`
#     cannot happen. After a restart that was issued there is always a window (no "no healthz
#     window was measured" state);
#   * a rollback needs two independent negatives: the window spent its whole budget **and** a plain
#     read says the process is not serving the commit this run built. With one of them missing the
#     deploy does not restart anything — it exits 1 and names what it saw (`rollback-refused`);
#   * `prod is DOWN` is printed only after a plain read found no answer; a 200 naming the commit
#     this run built is a late success — green, `health=late`, `slow=1`, no second restart;
#   * one deploy at a time: `$STATE_DIR/deploy.lock` (a directory holding the holder's pid and
#     start stamp) is taken before the fetch and the checkout, replaced atomically when stale, and
#     released by a trap on every exit path;
#   * a stopped service is deployable: `kickstart` that fails because the job is not loaded
#     bootstraps it from `$PLIST` and tries once more (`kickstart: not loaded — bootstrapped from`,
#     audit `recovered=bootstrap`);
#   * the load guard reads `sysctl -n vm.loadavg` itself (falling back to `uptime`), so a number
#     that is there is never printed as `unknown`; only when both fail does it say
#     `load=unavailable (sysctl: <line>)`.
#
# Exit codes: 0 healthy (fast or late); 1 a real deploy failure (rolled back, rollback failed, or
# refused for lack of evidence); 2 usage; 3 refused — another deploy holds the lock and nothing was
# checked out, built, published or restarted (the driver must not read it as a red product
# deploy). The prod-root guard keeps its own path: a `die`, exit 1, before anything is fetched or
# built.
#
# Overrides for a rehearsal (nothing below is needed for a real deploy): `BOOK_STATE_DIR` moves
# the lock, the audit log and the last-good records; `BOOK_LOCK_STALE_S` moves the 45-minute
# staleness limit; `BOOK_SERVICE_LABEL` and the plist path follow `$HOME`.
#
# Secrets: this script reads no secret and prints no value. `site/.env` is gitignored and is
# never touched by a checkout, `npm ci` or a build — only the service reads it.
set -eEuo pipefail

# The probe, the window, the load, the service start and the lock live beside this script (lib.sh,
# extracted with it by the workflow), so they can be exercised — and tested — without a deploy.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

ROOT="${BOOK_DEPLOY_ROOT:-$HOME/book-deploy}"
REPO_URL="${BOOK_REPO_URL:-https://github.com/semirov/book.git}"
STATE_DIR="${BOOK_STATE_DIR:-${HOME}/.local/state/book-deploy}"
AUDIT_LOG="${STATE_DIR}/deploy-audit.log"
LOCK_DIR="${STATE_DIR}/deploy.lock"
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
FIRST_AT=0
REPORTED_COMMIT=""
WINDOW_READS=0
RESTART_MS="unknown"
RELEASE=""
BUILT_COMMIT=""
LOAD_L1=""
LOAD_CORES="unknown"
LOAD_PER_CORE="unavailable"
LOAD_ABOVE=0
LOAD_SOURCE=""
LOAD_MSG=""
LOAD_PAUSE_USED=0
SLOW=0
BASELINE="unknown"
BASELINE_AT=0
BASELINE_STATUS=0
BASELINE_COMMIT=""
BASELINE_ERR=""
BASELINE_MSG=""
PLAIN_COMMIT=""
ROLLBACK_WHY=""
PERCENT=0
FRAME="n/a"
PWA="n/a"
KICKSTART_T0=""

# Where the run is, so a death names it. `REASON_PRINTED` keeps two reporters from both speaking,
# `AUDIT_WRITTEN` keeps a red run from writing a second audit line.
STEP="start"
REASON_PRINTED=0
AUDIT_WRITTEN=0
FAILED_CAUSE=""

usage() { sed -n '2,/^set -eEuo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

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
die() {
  printf '%s deploy: FAILED: %s\n' "$(now)" "$*" >&2
  REASON_PRINTED=1
  exit 1
}
audit() {
  mkdir -p "$STATE_DIR"
  printf '%s %s\n' "$(now)" "$*" >> "$AUDIT_LOG"
  AUDIT_WRITTEN=1
}

# Every exit path says why (BOOK-119 hotfix, pass 3): `fail_on_err` for a command that died under
# `set -e`, `fail_on_exit` for a status nobody explained, and the lock released after both so a red
# run can never end with `lock: released` alone. A usage error (before this point) takes no lock and
# writes no audit; a refusal (exit 3) is a notice, not a failure.
trap 'fail_on_err "$LINENO" "$BASH_COMMAND"' ERR
trap 'fail_on_exit; lock_release' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The visible downtime (#3711): the last 200 before the restart to the first 200 after it.
# `unknown` when the site was already down or could not be read (no baseline stamp), when the new
# build never answered, or when the two stamps do not make a window — never a copy of the deploy's
# polling time.
downtime() { # (baseline_at, first_at, health)
  case "$3" in fast|late) ;; *) printf 'unknown'; return 0 ;; esac
  if is_number "$1" && is_number "$2" && [ "$1" -gt 0 ] && [ "$2" -ge "$1" ]; then
    printf '%s' "$(( $2 - $1 ))"
    return 0
  fi
  printf 'unknown'
}

# B2: every upgrade of a verdict stamps its own moment, so the numbers are recomputed from the
# final verdict — an audit can never print `health=late restart_ms=unknown`.
recompute_window() {
  RESTART_MS="$(downtime "$BASELINE_AT" "$FIRST_AT" "$HEALTH")"
  PERCENT=0
  if is_number "$HEALTH_MS" && [ "$BUDGET_MS" -gt 0 ]; then PERCENT=$(( HEALTH_MS * 100 / BUDGET_MS )); fi
}

# The numbers every audit line carries, whatever the outcome (a comparable record of the box), and
# the facts about *this* run: which probe measured, what the lock did, whether the service had to
# be bootstrapped, and why a failed baseline read failed.
audit_tail() { # (restart_ms, health_ms, budget_pct, baseline)
  printf 'restart_ms=%s health_ms=%s budget_ms=%s budget_pct=%s load=%s cores=%s load_pause=%s slow=%s baseline=%s err=%s probe=%s lock=%s recovered=%s' \
    "$1" "$2" "$BUDGET_MS" "$3" "$LOAD_PER_CORE" "$LOAD_CORES" "$LOAD_PAUSE_USED" "$SLOW" "$4" "${BASELINE_ERR:-none}" "$PROBE_USED" "$LOCK" "${KICKSTART_RECOVERED:-none}"
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

# BOOK-157: the two files an install reads must be served as what they are — the manifest as
# `application/manifest+json`, the worker as `text/javascript` with `cache-control: no-cache` (a
# `no-store` worker cannot be registered, and a worker a cache may keep outlives its release).
# Both defects are invisible in a browser, so the deploy refuses to call the site healthy on
# `/healthz` alone. Absent in a checkout older than BOOK-157: skip loudly, as the frame check does.
pwa_check() {
  [ -f "$ROOT/site/scripts/pwa-smoke.mjs" ] || { say "this checkout predates the PWA smoke (BOOK-157) — skipping"; return 0; }
  node "$ROOT/site/scripts/pwa-smoke.mjs" --server "$(site_url)"
}

# The green end of any path: the site serves the build of this run, so check the canon, record it
# and exit 0. `keep` leaves `last-good` alone — the release `current` names is then not this
# build's (a late answer after a rollback had already published the previous release).
finish_green() { # (optional: keep)
  STEP="frame"
  say "checking the frozen frame"
  # Exit 0 is the only success. A mismatch (1) means the running site serves text that is not
  # the canon; a usage error (2) means this checkout cannot even run its own script. Both are
  # this deploy being unhealthy, so both take the red path below — never `exit 0`.
  if frame_check; then
    FRAME="ok"
    STEP="pwa"
    say "checking the installable shell: manifest and service worker"
    # Exit 0 is the only success here too. A manifest answered as a page, or a worker a cache may
    # keep past its release, is an install that silently does not happen — the same red path the
    # frame check takes, never `exit 0`.
    if pwa_check; then
      PWA="ok"
      if [ "${1:-}" != "keep" ]; then
        mkdir -p "$STATE_DIR"
        echo "$GOOD" > "$STATE_DIR/last-good"
        if [ -n "$RELEASE" ] && [ "$RELEASE" != "unknown" ]; then echo "$RELEASE" > "$STATE_DIR/last-good-release"; fi
      fi
      audit "ok mode=$MODE ref=$REF sha=$GOOD prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=ok pwa=$PWA restart=$(restart_field) $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
      say "healthy: $SHORT at $URL; time-to-first-200 ${HEALTH_MS} ms = ${PERCENT}% of ${BUDGET_MS} ms, visible downtime ${RESTART_MS} ms, load ${LOAD_PER_CORE}/core, probe=$PROBE_USED, lock=$LOCK"
      exit 0
    fi
    PWA="fail"
    say "the running site does not serve the installable shell (manifest, service worker)"
    return 1
  fi
  FRAME="fail"
  say "the running site does not serve the frozen frame"
  return 1
}

# --- prepare: get the wanted commit into the clone --------------------------------------------
if [ "$PHASE" = "prepare" ]; then
  mkdir -p "$STATE_DIR"
  # A dry run reads nothing and writes nothing, so it takes no lock — but it says what a real run
  # would meet, which is how a rehearsal can show the refusal without touching prod.
  if [ "$DRY_RUN" = "1" ]; then
    say "dry run: lock $(lock_report) — this run takes nothing"
  fi
  [ -d "$ROOT/.git" ] || die "no deploy clone at $ROOT (the workflow bootstraps it; by hand: git clone $REPO_URL $ROOT)"

  # One deploy at a time, and *before* the fetch and the checkout: the incident's second restart
  # came from two runs flipping one tree between `npm ci` and the build. The lock is taken here,
  # survives the `exec` below (the pid does not change) and is released by the run phase's trap —
  # this trap covers a die between the two.
  if [ "$DRY_RUN" != "1" ]; then
    STEP="prepare: lock"
    lock_acquire
  fi

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

  # If this deploy replaced this very script, finish with the new copy — no stale half-run. The
  # lock belongs to the pid, and `exec` keeps it: the child inherits it and says which one it got.
  SELF="$ROOT/site/deploy/deploy.sh"
  if [ "${BOOK_DEPLOY_REEXEC:-0}" != "1" ]; then
    set -- --phase run --root "$ROOT" --ref "$TARGET" --health-timeout "$HEALTH_TIMEOUT"
    if [ "$MODE" = "rollback" ]; then set -- "$@" --rollback; fi
    exec env BOOK_DEPLOY_REEXEC=1 BOOK_LOCK_FROM_PREPARE="$LOCK" "$SELF" "$@"
  fi
  PHASE="run"
fi

# --- run: gate, proof, load, publish, restart, health ------------------------------------------
# The lock was taken in prepare and survives the `exec`: re-assert it here, and own it until this
# process ends — a refusal, a die and a green exit all leave through the traps installed above.
STEP="run: lock"
lock_resume
PREV="${PREV:-$(cat "$STATE_DIR/previous" 2>/dev/null || true)}"
STEP="run: preflight"
# The prepare phase re-execs this script for the run phase, and the re-exec carries no SHORT from
# that process: recompute it here, or `set -u` kills a deploy that is already healthy (BOOK-79).
SHORT="$(git -C "$ROOT" rev-parse --short HEAD)"
command -v npm >/dev/null || die "npm is not on PATH (the deploy workflow sets PATH=/opt/homebrew/bin:…; by hand: export PATH=/opt/homebrew/bin:\$PATH)"
command -v node >/dev/null || die "node is not on PATH (see npm above)"
# The probe is a plain curl, so it is preflighted like the other two: a deploy that cannot read
# /healthz must say so before it publishes anything, not after the restart.
command -v curl >/dev/null || die "curl is not on PATH — the deploy reads /healthz with it; nothing was deployed or restarted"
cd "$ROOT/site"
STEP="gate: npm ci"
say "gate: npm ci"
npm ci --no-audit --no-fund >/dev/null 2>&1 || die "npm ci failed at $(git -C "$ROOT" rev-parse --short HEAD)"
STEP="gate: verify"
say "gate: verify (typecheck, arch, tests)"
npm run verify || die "gate (verify) is red — nothing was deployed or restarted"
STEP="gate: coverage"
say "gate: coverage"
npm run test:coverage || die "coverage floor not met — nothing was deployed or restarted"
STEP="gate: build"
say "gate: build"
npm run build || die "build failed — nothing was deployed or restarted"
STEP="gate: manuscript"
say "gate: manuscript"
node "$ROOT/site/bin/validate.mjs" --strict || die "manuscript validation is red — nothing was deployed or restarted"

# BOOK-119: the two proofs run on the build that just landed in `dist/staging`. They read real
# bytes: a red proof means an asset URL would not survive the next publish or the guard would
# not speak — and then nothing is published and nothing is restarted.
STEP="gate: proof"
say "gate: proof (old asset survives a publish; the guard speaks without a bundle; the manifest and the worker describe this build)"
npm run proof || die "proof is red — nothing was published or restarted"

# BOOK-46: the F023 release check on the bytes this deploy is about to publish. `verify` above ran
# arch in dev mode, before any build existed; `web/dist` is a release store whose `current` still
# names the previous release, so the guard has to be pointed at the fresh build itself.
STEP="gate: arch release"
say "gate: arch --require-dist (F023 on web/dist/staging)"
BOOK_DIST_DIR="$ROOT/site/web/dist/staging" npm run arch -- --require-dist || die "F023 release check is red — the built bundle carries a support line; nothing was published or restarted"

GOOD="$(git -C "$ROOT" rev-parse HEAD)"
BUILT_COMMIT="$(built_commit)"
[ -n "$BUILT_COMMIT" ] || die "build-info.json carries no commit — the deploy cannot name the build it made"
STEP="guard: prod root"
service_root_guard

# The box, not an ideal machine (BOOK-119 #3711): at load ~40 on 10 cores a healthy boot took
# longer than 60 s. Say what the box is doing; pause once above the threshold; never refuse.
STEP="load"
load_read "$LOAD_PER_CORE_MAX"
if [ "$LOAD_L1" = "unavailable" ]; then
  say "load guard: load=unavailable (sysctl: ${LOAD_MSG}) — no number for this box; the deploy proceeds"
else
  say "load guard: load=${LOAD_L1} on ${LOAD_CORES} cores = ${LOAD_PER_CORE}/core (via ${LOAD_SOURCE})"
fi
if [ "${LOAD_ABOVE:-0}" = "1" ]; then
  say "load guard: ${LOAD_PER_CORE}/core is above ${LOAD_PER_CORE_MAX} — pausing ${LOAD_PAUSE}s before the restart; the deploy window is longer on purpose, the deploy still happens"
  sleep "$LOAD_PAUSE"
  LOAD_PAUSE_USED="$LOAD_PAUSE"
fi

# Publish after a green proof, before the restart: for seconds the old process serves the new
# shell's API — compatible by construction, and it is what makes the restart asset-safe.
STEP="publish"
say "publish: release"
npm run release:publish -- --state "$STATE_DIR" || die "publish failed — current is untouched, nothing was restarted"
RELEASE="$(readlink "$ROOT/site/web/dist/current" 2>/dev/null | sed 's|.*/||')"
[ -n "$RELEASE" ] || RELEASE="unknown"
say "publish: current -> release $RELEASE"

URL="$(health_url)"
STEP="baseline"
# A1: the baseline is the same probe as the window (`health_read`), and its failure is recorded,
# not interpreted: `down` is a real non-200 answer, `unknown` a read that could not be made.
baseline_read "$URL" || true
case "$BASELINE" in
  up) say "restart baseline: up at $URL — last 200 before the restart at ${BASELINE_AT} (served ${BASELINE_COMMIT:-unknown})" ;;
  down) say "restart baseline: down at $URL — the site answered status=${BASELINE_STATUS} and was not 200; nothing to attribute to this deploy (err=none)" ;;
  *) say "restart baseline: unknown at $URL — could not be measured (err=${BASELINE_ERR} ${BASELINE_MSG}); the downtime will be unknown, and this is not evidence about the site" ;;
esac

# BOOK-119 review: `set -e` used to end the run here on a failed `launchctl kickstart` — after
# the publish, with `current` already on the new release and no audit line at all. A failed
# signal is a health outcome, and the red path below asks whether the previous commit serves.
STEP="restart"
KICKSTART_T0="$(now_ms)"
if service_kickstart "$SERVICE_LABEL" "$PLIST"; then
  # A2: a restart was issued, so a window is measured around it — always, with a real elapsed time.
  STEP="health window"
  window_settle "$URL" "$BUILT_COMMIT" "$PREV" "$KICKSTART_T0"
else
  HEALTH="none"
  say "kickstart: no restart was issued (see above) — nothing to measure; the red path reads what answers instead"
fi
recompute_window

case "$HEALTH" in
  fast) say "healthz ok after ${HEALTH_MS} ms = ${PERCENT}% of the ${BUDGET_MS} ms budget (poll 200 ms, ${WINDOW_READS:-0} reads)" ;;
  late) SLOW=1
        say "healthz ok LATE after ${HEALTH_MS} ms = ${PERCENT}% of the ${BUDGET_MS} ms budget; the budget ran out but the process now serves ${BUILT_COMMIT}: late success, no rebuild, no second restart" ;;
  stale) say "healthz answers ${REPORTED_COMMIT:-unknown}, the previous build — the new code (${BUILT_COMMIT}) never served after ${HEALTH_MS} ms (${WINDOW_READS:-0} reads); not restarting the same commit twice" ;;
  fail) say "healthz did not answer ${BUILT_COMMIT} after ${HEALTH_MS} ms (budget ${BUDGET_MS} ms + grace ${GRACE_MS} ms, ${WINDOW_READS:-0} reads); probe=$PROBE_USED" ;;
  *) say "no restart was issued, so there is no window: health=$HEALTH" ;;
esac
if [ "$HEALTH" = "fast" ] || [ "$HEALTH" = "late" ]; then
  say "time-to-first-200 ${HEALTH_MS} ms = ${PERCENT}% of the ${BUDGET_MS} ms budget; visible downtime ${RESTART_MS} ms (baseline ${BASELINE} at ${BASELINE_AT}, first 200 at ${FIRST_AT})"
  finish_green || true
fi

STEP="health window"
# --- red path ----------------------------------------------------------------------------------
# One plain read (three when the window saw nothing usable) is the last evidence before anything is
# rebuilt or restarted. It upgrades a verdict the window missed and stamps its own moment (B2), so
# `health=late` never reaches an audit with `restart_ms=unknown`.
plain_verdict "$URL" "$BUILT_COMMIT" "$PREV" 3 || true
recompute_window
if [ "$HEALTH" = "fast" ] || [ "$HEALTH" = "late" ]; then
  say "late success: prod serves ${PLAIN_COMMIT:-$BUILT_COMMIT} — the deploy went through and the measurement lost it; no rebuild, no second restart"
  finish_green || true
fi

# The process already serves the previous commit: nothing was rebuilt, and nothing will be. In
# `--rollback` mode `PREV` is re-read from `$STATE_DIR/previous`: it is the commit being rolled
# back *from*, so the skip is deploy-only, and a rollback that did not reach its own commit is
# `rollback-failed` and never touches `last-good`.
if [ "$MODE" = "deploy" ] && [ -n "$PREV" ] && names_commit "$PLAIN_COMMIT" "$PREV"; then
  STEP="frame"
  say "the running process already serves ${PREV:0:7} — checking the frame and the release on disk before anything is written"
  if frame_check; then
    FRAME="ok"
    # `current` still names the release that just failed. Publish and prune never remove the
    # release `.state/last-good-release` records, so pointing `current` back at it makes disk and
    # process agree — otherwise the next restart serves the red shell this deploy just refused.
    LAST_GOOD_RELEASE="$(cat "$STATE_DIR/last-good-release" 2>/dev/null || true)"
    if [ -n "$LAST_GOOD_RELEASE" ] && node "$ROOT/site/scripts/release.mjs" swap --id "$LAST_GOOD_RELEASE" >/dev/null 2>&1; then
      RELEASE="$LAST_GOOD_RELEASE"
      say "current -> release $RELEASE (a moment ago it named the failed publish)"
    else
      say "the release behind ${PREV:0:7} is not in the store (last-good-release='${LAST_GOOD_RELEASE:-none}') — rebuilding it so disk and process agree"
    fi
    say "the running process already serves ${PREV:0:7} and is healthy — no npm ci, no rebuild, no publish, no second restart"
    mkdir -p "$STATE_DIR"
    echo "$PREV" > "$STATE_DIR/last-good" # `last-good-release` already names $RELEASE
    audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$BUILT_COMMIT release=$RELEASE health=$HEALTH frame=ok restart=skipped $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
    say "deploy of $SHORT is red; prod still serves ${PREV:0:7}, current is back on release $RELEASE — the process was not restarted"
    exit 1
  fi
  # The process answers, but not with the canon: `last-good` must not record it, and a restart
  # of the same commit would not change what the data says.
  FRAME="fail"
  say "the running process answers ${PREV:0:7} but does not serve the frozen frame; last-good was NOT written — a human must look at the canon"
  audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$BUILT_COMMIT release=$RELEASE health=$HEALTH frame=fail restart=skipped $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  exit 1
fi

# A restart that was never issued says nothing about the build: no rollback, no second attempt to
# signal the same broken job — a human has to look at the service.
if [ "$HEALTH" = "none" ]; then
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=none frame=$FRAME restart=failed $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "the restart could not be issued (kickstart failed even after bootstrapping from $PLIST) — nothing was restarted, nothing was rolled back; prod answers ${PLAIN_COMMIT:-nothing} at $URL; a human must look"
fi

# A frame failure is a canon problem, not a code one: a rollback would restart code that is
# already answering and change nothing about the data — so nothing is restarted, and the message
# names what answered.
if [ "$FRAME" = "fail" ]; then
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=fail restart=skipped $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  if [ -n "$PLAIN_COMMIT" ]; then
    die "prod answers $PLAIN_COMMIT but does not serve the frozen frame (health=$HEALTH after ${HEALTH_MS} ms) — a rollback would restart code that already answers and change nothing about the canon; nothing was restarted. A human must look at the canon"
  fi
  die "prod answers nothing at $URL and the frame cannot be checked (health=$HEALTH after ${HEALTH_MS} ms) — a rollback would restart on a guess; nothing was restarted. A human must look"
fi

# A broken install is neither a canon problem nor a reason to start a second restart: the site
# serves the book, and the manifest or the worker is what does not answer. A rollback here would
# trade one tree's install for another's — the previous release may have no worker at all, a
# version that already had one may have the same defect — so nothing is restarted again, and the
# deploy stays red for a human to look at `/sw.js` and `/manifest.webmanifest`.
if [ "$PWA" = "fail" ]; then
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=$FRAME pwa=fail restart=$(restart_field) $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "prod answers ${PLAIN_COMMIT:-nothing} but does not serve the installable shell (manifest, service worker) — nothing was restarted; a human must look at $URL/sw.js and $URL/manifest.webmanifest"
fi

# A rollback that did not reach its own commit has nothing better behind it: the generic path
# below would check out `PREV`, which in this mode is the commit the rollback exists to leave.
if [ "$MODE" = "rollback" ]; then
  audit "rollback-failed mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=$FRAME restart=$(restart_field) release=$RELEASE $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  if [ -n "$PLAIN_COMMIT" ]; then
    die "the rollback did not come up healthy (health=$HEALTH after ${HEALTH_MS} ms of ${BUDGET_MS} ms, frame=$FRAME); prod answers $PLAIN_COMMIT, not the commit the rollback built — a human must look"
  fi
  die "the rollback did not come up healthy (health=$HEALTH after ${HEALTH_MS} ms of ${BUDGET_MS} ms, frame=$FRAME); prod answers nothing at $URL — a human must look"
fi

# A4: two independent negatives, or prod is not restarted on a guess.
if ! rollback_allowed "$HEALTH_MS" "$BUDGET_MS" "$PLAIN_COMMIT" "$BUILT_COMMIT"; then
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=$FRAME restart=skipped $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "not rolling back — $ROLLBACK_WHY; a rollback restarts prod, and this verdict has only one negative. Nothing was restarted. A human must look"
fi

[ -n "$PREV" ] || die "no previous commit to roll back to; prod is NOT serving the build of this run — a human must look"
STEP="rollback"
say "rolling back to ${PREV:0:7}: health=$HEALTH after ${HEALTH_MS} ms and prod does not serve ${BUILT_COMMIT}"
git -C "$ROOT" checkout --quiet --detach "$PREV" || die "rollback checkout failed"
cd "$ROOT/site"
npm ci --no-audit --no-fund >/dev/null 2>&1 || say "warning: npm ci failed during rollback; rebuilding anyway"
STEP="rollback: build"
npm run build || die "rollback build failed; prod is NOT healthy — a human must look"
STEP="rollback: publish"
npm run release:publish -- --state "$STATE_DIR" || die "rollback publish failed; prod is NOT healthy — a human must look"
RELEASE="$(readlink "$ROOT/site/web/dist/current" 2>/dev/null | sed 's|.*/||')"
ROLLBACK_COMMIT="$(built_commit)"
# The rollback restarts too, so it takes its own baseline: the line must state what the site lost
# in this restart, not reuse the numbers of the attempt that failed.
baseline_read "$URL" || true
STEP="rollback: restart"
say "rollback baseline: $BASELINE at $URL (err=${BASELINE_ERR:-none}${BASELINE_MSG:+ $BASELINE_MSG})"
KICKSTART_T0="$(now_ms)"
if service_kickstart "$SERVICE_LABEL" "$PLIST"; then
  window_settle "$URL" "$ROLLBACK_COMMIT" "$BUILT_COMMIT" "$KICKSTART_T0"
else
  HEALTH="none"
  say "kickstart: the rollback could not restart the service (see above)"
fi
recompute_window
STEP="rollback: health window"
say "rollback healthz: $HEALTH after ${HEALTH_MS} ms = ${PERCENT}% of ${BUDGET_MS} ms; visible downtime ${RESTART_MS} ms; probe=$PROBE_USED"

# The same evidence rule as the deploy's own restart: three plain reads before the rollback is
# called dead. Its own build answering is the success path below; echo of the failed build is a
# late success of the deploy above.
if [ "$HEALTH" != "fast" ] && [ "$HEALTH" != "late" ]; then
  plain_verdict "$URL" "$ROLLBACK_COMMIT" "$BUILT_COMMIT" 3 || true
  recompute_window
fi
if [ "$HEALTH" = "fast" ] || [ "$HEALTH" = "late" ]; then
  STEP="rollback: frame"
  say "checking the frozen frame of the rollback"
  if frame_check; then
    FRAME="ok"
    echo "$PREV" > "$STATE_DIR/last-good"
    if [ -n "$RELEASE" ]; then echo "$RELEASE" > "$STATE_DIR/last-good-release"; fi
    audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=ok restart=$(restart_field) release=$RELEASE $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
    say "rolled back to ${PREV:0:7}; prod healthy; the deploy of $SHORT stays red"
    exit 1
  fi
  FRAME="fail"
  say "the rollback answers but does not serve the frozen frame; last-good was NOT written"
fi

# The process answering with the *deploy's* build after the rollback is the incident's exact
# state: the site was up the whole time. That is a late success — green, and the audit says it.
if [ "$HEALTH" = "stale" ] && names_commit "$PLAIN_COMMIT" "$BUILT_COMMIT"; then
  HEALTH="late"
  SLOW=1
  say "late success: prod serves ${PLAIN_COMMIT} (the build of the deploy that was being rolled back) — nothing is restarted again"
  if [ -n "$RELEASE" ] && [ "$RELEASE" != "unknown" ]; then
    say "note: current names release $RELEASE (the rollback's publish) while the process serves $SHORT — the next deploy makes disk agree"
  fi
  finish_green keep || true
fi

audit "rollback-failed mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=$FRAME restart=$(restart_field) release=$RELEASE $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
if [ -n "$PLAIN_COMMIT" ]; then
  die "rollback did not come up healthy (health=$HEALTH after ${HEALTH_MS} ms, frame=$FRAME); prod answers $PLAIN_COMMIT, not the build of this run — a human must look; the audit names release=${RELEASE:-unknown} (log: ~/Library/Logs/book-site.log)"
fi
die "rollback did not come up healthy either — prod answers nothing at $URL, a human must look; the audit names release=${RELEASE:-unknown}, health=$HEALTH, frame=$FRAME (log: ~/Library/Logs/book-site.log)"
