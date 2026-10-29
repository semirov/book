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
#   * the cutover runs first in the switch (BOOK-187 AC12): the writer lane is unloaded, the old
#     writer's files are folded away by `bin/home-migrate.mjs --apply`, and only then does the home
#     guard read the volume — the old image recreates `writer/state.json` on its next pass, so the
#     order is not cosmetic;
#   * the gate runs here too (typecheck, arch, tests, coverage floor, build, the volume's home
#     guard, the text as stored in the database, and the F023 release check on the built
#     bundle) — a red gate deploys nothing;
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
#     rebuilds, republishes, restarts, and re-checks — then exits 1 either way, so CI stays red;
#   * BOOK-217 — THE RECOVERY IS DECIDED FROM ONE FACT: did the boot of this run write a
#     pre-migration dump? `server/src/db/boot.ts` writes `backups/pre-v<from>-<stamp>.db` BEFORE any
#     DDL, and only when it is about to migrate — so ONE listing of `backups/` before the restart and
#     ONE after it is the whole fact: a name that was not there before and is there after is this
#     run's migration, and no new name means the boot ran no DDL. The volume marker is NOT a second
#     signal: the boot writes `.book-volume` with `flag:'wx'` and rewrites only a LEGACY marker, so
#     `schema=` is never refreshed after the first boot, and comparing it around the restart compares
#     one number with itself (pinned by `server/test/boot.test.ts`). Both listings are
#     STATUS-CHECKED: a listing that failed is not "no migration", it is `unknown`, and an unknown
#     fact is never rounded to either — nothing is checked out, nothing is restored, nothing is
#     restarted, and `recovery: none` says a human must look. (An after-read that failed would put
#     the previous build on a volume that may have migrated — `SCHEMA_FUTURE`, the incident; a
#     before-read that failed would make every pre-existing dump look new, and the restore would
#     write an old copy over the live book.) Migrated and this build answers → roll-forward: the
#     previous build is NOT put back (it would refuse the future schema and crash-loop), nothing is
#     checked out, rebuilt or restarted, `last-good` is not written, exit 1. Migrated and nothing
#     serves → the service is unloaded first (`launchctl bootout`, never a live writer over the file
#     being replaced), then the pre-deploy dump goes back over `book.db` and the ordinary rollback
#     runs on the schema the dump brought back. No migration → the ordinary rollback. Every path that
#     reached the restart prints exactly one `recovery:` line (`lib.sh:recovery_line`, four fixed
#     sentences: roll-forward, dump-restore, image-rollback, none) and audits `recovery=`; a failure
#     before the restart never booted and prints none;
#   * BOOK-217 — A MIGRATION IS RECORDED, so `--rollback` cannot walk into it: a run that migrated
#     (red or green) writes `$STATE_DIR/volume-migrated` with the `SCHEMA_VERSION` of the deployed
#     build, read from `git show <sha>:site/server/src/db/schema.ts` (`schema=unknown` when it cannot
#     be read; absent when nothing migrated). `--rollback` reads the record, reads the TARGET's
#     constant the same way, and refuses (exit 1, nothing fetched, checked out or built) when the
#     target understands an older schema — putting an older build on a migrated volume is the
#     incident. A successful dump-restore removes the record (the volume is back on the old schema);
#     an unknown or absent record keeps today's behaviour and says so in one line;
#   * BOOK-217 — A CRASH LOOP IS THE RUN'S TO REPORT: `launchctl print` is read before the restart and
#     after a failed window. A job that respawned more than the deploy's own kickstart
#     (`runs > runs_before + 1`) prints `CRASH LOOP: <label> resumed <n> time(s), last exit code <m>
#     — the service cannot boot; prod is not serving` (also as `::error::` under GitHub Actions; the
#     audit says `crashloop=1`). A non-zero `last exit code` is evidence only when the job respawned
#     under this run AND the code is not the one snapshotted before it: a code a previous deploy left
#     behind would otherwise turn a slow-but-green run red and roll prod back. A `print` that does
#     not answer is `unknown`, never `fine`, and a respawning job is never a 0;
#   * the order is the safety on this driver too: the volume's home gate and `home-migrate --apply`
#     run before the build and before `kickstart` (the boot is what runs the DDL), so a refusal stops
#     a deploy whose boot never ran a migration — the same order the compose driver keeps before `up`.
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

# BOOK-217: the fact a recovery is decided from, and what the job's own record says. `REACHED_RESTART`
# is 0 until `kickstart` is issued: a failure before it never booted, so it has no migration, no crash
# loop and owes no `recovery:` line. `RECOVERY_CHOICE` names the recovery that actually ran (`none`
# on a path that refused the rollback), and `RECOVERY_PICK` is the rule's answer before it acts.
REACHED_RESTART=0
# Tri-state, like the rule in lib.sh: `1` the boot dumped before migrating, `0` no new dump,
# `unknown` a listing failed — which is neither, and refuses both an image swap and a restore.
MIGRATED="unknown"
MIGRATION_DUMP=""
MIGRATION_WHY=""
DUMPS_BEFORE=""
# 1 once the listing of `backups/` before the restart was read successfully: the fact needs both.
DUMPS_KNOWN=0
# 1 once the fact was read for this run: the green record, the audit and the recovery all name ONE
# listing, never a second one taken after the first (the volume could have moved in between).
MIGRATION_READ=0
RECOVERY_PICK=""
RECOVERY_CHOICE=""
CRASHLOOP=0
RUNS_BEFORE=""
EXIT_BEFORE=""
RUNS_AFTER=""
EXIT_AFTER=""
# BOOK-217: what a migrating run leaves for `--rollback` — `schema=<n>` or `schema=unknown`.
VOLUME_MIGRATED_FILE="${STATE_DIR}/volume-migrated"

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
WRITER_LABEL="${BOOK_WRITER_LABEL:-dev.book-writer}"
WRITER_PLIST="${HOME}/Library/LaunchAgents/${WRITER_LABEL}.plist"

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
trap 'fail_on_exit; writer_restore; lock_release' EXIT
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

# BOOK-187: the volume the site reads. A deploy without it is an incident, not an empty book —
# the text gate and the home guard both need it, and neither may pass by absence.
data_dir_of_service() {
  plist_field EnvironmentVariables.DATA_DIR 2>/dev/null || true
}

# --- the volume cutover (BOOK-187 AC12) ---------------------------------------------------------
#
# A volume that served the pre-BOOK-187 image still holds the old writer's files, and the gate
# below refuses to pass while they are there. The order of the cutover is **not cosmetic**: the
# old writer recreates `writer/state.json` on its very next pass, so a migration that ran while
# the lane was up would be undone seconds later and the gate after it would read a volume that
# was already dirty again. So: stop the lane, migrate, *then* read the volume.
#
# `launchctl bootout`, not `stop`: the job carries KeepAlive, so a signal is answered by a
# respawn within the throttle — the lane has to be unloaded, and `writer_restore` puts it back on
# every exit path (a green deploy, a die, a Ctrl-C), because a lane left down is a book left
# unwritten. A job that was not loaded is not ours to start: the flag stays 0 and nothing is
# bootstrapped at the end.
WRITER_STOPPED=0
# The sentence both runtimes say when the volume holds something it may not (BOOK-187 AC12): the
# same words in `deploy.sh` and `compose-release.sh`, and the remedy is in it — the operator reads
# one line and knows the command.
HOME_FAILED="the volume holds something it may not (every path above is named) — run bin/home-migrate.mjs --apply once"

writer_stop() {
  local status=0 out=""
  out="$(launchctl bootout "gui/$(id -u)/$WRITER_LABEL" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    WRITER_STOPPED=1
    say "cutover: the writer lane ($WRITER_LABEL) is stopped — the old image must not recreate writer/state.json behind the migration"
    return 0
  fi
  say "cutover: $WRITER_LABEL was not loaded (${out:-no output}) — nothing to stop"
}

writer_restore() {
  [ "${WRITER_STOPPED:-0}" = "1" ] || return 0
  WRITER_STOPPED=0
  if [ ! -f "$WRITER_PLIST" ]; then
    say "cutover: no plist at $WRITER_PLIST — the writer lane stays stopped; bootstrap it by hand"
    return 0
  fi
  if launchctl bootstrap "gui/$(id -u)" "$WRITER_PLIST" >/dev/null 2>&1; then
    say "cutover: the writer lane is loaded again ($WRITER_LABEL)"
  else
    say "cutover: the writer lane could not be bootstrapped — run: launchctl bootstrap gui/$(id -u) $WRITER_PLIST"
  fi
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
  # read-only, makes one attempt per chapter inside one 25 s budget, and writes nothing. Since
  # BOOK-187 it reads the frame from the volume (`book_frame`), never from the manuscript, so the
  # data dir is what it needs; the script's own default is $DATA_DIR, then ~/book-site-data.
  [ -f "$ROOT/site/scripts/frame-check.mjs" ] || { say "this checkout predates the frame check (BOOK-107) — skipping"; return 0; }
  local args=(--server "$(site_url)") data_dir
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

# --- the migration fact, and the recovery it decides (BOOK-217) ---------------------------------
#
# The boot writes `backups/pre-v<from>-<stamp>.db` BEFORE any DDL (`server/src/db/boot.ts`), so a
# dump that was not in the volume before the restart and is there after it is the fact: this run
# moved the volume's schema, and no new name means it ran no DDL. That is why ONE listing each side
# is enough, and why the marker is not a second signal: `boot.ts` writes `.book-volume` with
# `flag:'wx'` and rewrites only a LEGACY marker, so `schema=` is never refreshed after the first boot
# (`server/test/boot.test.ts` pins it) and comparing it around the restart compares one number with
# itself.
#
# The volume is a host path here (`$DATA_DIR_SITE`), so both reads are plain file reads — and their
# STATUS is part of the answer. A listing that failed is `unknown`: an after-read that failed would
# call a migrated volume unmigrated and put the previous build on a future schema (`SCHEMA_FUTURE`,
# the crash loop), and a before-read that failed would make every pre-existing dump look new, so the
# restore would write an old copy over the live book — data loss reported as success. The sentence a
# human reads is the shared one (`lib.sh:recovery_line`), never a copy per driver.

# The pre-migration dumps in the volume, bare names, sorted. The names are filtered here, and an
# empty list is a real answer — but the exit status is the caller's: an EXISTING `backups/` that
# cannot be listed says nothing at all about the volume, so it is a failure, never "none". An
# ABSENT `backups/` is an empty listing: the boot creates it only when it takes a dump.
volume_dumps() {
  local dir="${DATA_DIR_SITE%/}/backups" out=""
  if [ -d "$dir" ]; then
    out="$(ls -1 "$dir" 2>/dev/null)" || return 1
  fi
  printf '%s\n' "$out" | grep -E '^pre-v.*[.]db$' | sort || true
  return 0
}

dump_count() { # (newline-separated names) -> how many
  local n=0 line=""
  while IFS= read -r line; do [ -n "$line" ] && n=$(( n + 1 )); done <<EOF
${1:-}
EOF
  printf '%s' "$n"
}

# The `v<from>` in a boot dump's name (`pre-v29-20261029T085300Z.db`), empty when the name is not one
# the boot writes.
dump_from_version() {
  printf '%s\n' "$1" | sed -n 's/^pre-v\([0-9][0-9]*\)-.*$/\1/p' | head -n 1 || true
}

# Before the restart: the volume while it is still the previous build's.
migration_before() {
  STEP="migration: before"
  if DUMPS_BEFORE="$(volume_dumps)"; then
    DUMPS_KNOWN=1
    say "migration: before the restart — $(dump_count "$DUMPS_BEFORE") dump(s) in backups/"
  else
    DUMPS_BEFORE=""
    DUMPS_KNOWN=0
    say "migration: before the restart — backups/ could not be listed; whether the boot migrates will be unknown"
  fi
}

# After the boot: did the volume move? A dump that was not in the successfully-read before-list and is
# there now is the whole fact; a listing that failed on either side is `unknown`, the state that
# refuses both an image swap and a restore. `MIGRATION_DUMP` is the newest such name (sorted).
migration_after() {
  local now_dumps="" name="" new="" from=""
  MIGRATED="unknown"; MIGRATION_DUMP=""; MIGRATION_WHY=""
  if [ "$DUMPS_KNOWN" != "1" ]; then
    MIGRATION_WHY="the listing of backups/ before the restart failed, so whether the boot migrated the volume cannot be known"
    say "migration: unknown — ${MIGRATION_WHY}"
    return 0
  fi
  if ! now_dumps="$(volume_dumps)"; then
    MIGRATION_WHY="the listing of backups/ after the restart failed, so whether the boot migrated the volume cannot be known"
    say "migration: unknown — ${MIGRATION_WHY}"
    return 0
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if printf '%s\n' "$DUMPS_BEFORE" | grep -Fxq -- "$name"; then continue; fi
    new="$name"
  done <<EOF
$now_dumps
EOF
  if [ -n "$new" ]; then
    MIGRATED=1
    MIGRATION_DUMP="$new"
    from="$(dump_from_version "$new")"
    if [ -n "$from" ]; then
      MIGRATION_WHY="the boot dumped v${from} before migrating (backups/${new})"
    else
      MIGRATION_WHY="the boot dumped the volume before migrating (backups/${new})"
    fi
    say "migration: the volume moved under this run — ${MIGRATION_WHY}"
    return 0
  fi
  MIGRATED=0
  MIGRATION_WHY="no new dump in backups/, so the boot ran no DDL"
  say "migration: none — ${MIGRATION_WHY}"
}

# Put the pre-deploy dump back over `book.db` (BOOK-217). WAL and SHM go first (a stale WAL beside a
# restored db is how a copy reads back as something else), the copy lands under a temp name inside the
# allow-listed `backups/` (a `.restoring` file beside `book.db` would be a stray the home gate
# refuses) and is `mv`ed over it; the dump stays where it was.
#
# Only a name that was absent from the SUCCESSFULLY-read before-list may be restored: one that was
# already there is somebody's older dump, not this run's, and overwriting the live book with it is the
# silent data loss this check exists for. A dump that is not there, or a copy that fails, is a hard
# failure: the ordinary rollback over a migrated schema is the incident.
restore_dump() {
  local dir="${DATA_DIR_SITE%/}"
  local dump="${dir}/backups/${MIGRATION_DUMP}"
  local dest="${dir}/book.db"
  local tmp="${dir}/backups/.book.db.restoring"
  if [ -z "$MIGRATION_DUMP" ]; then
    say "restore: the migration named no dump — nothing can be put back over book.db"
    return 1
  fi
  if printf '%s\n' "$DUMPS_BEFORE" | grep -Fxq -- "$MIGRATION_DUMP"; then
    say "restore: backups/${MIGRATION_DUMP} was already in the volume before this run, so it is not this run's pre-migration dump; refusing to overwrite book.db with an old copy"
    return 1
  fi
  if [ ! -f "$dump" ]; then
    say "restore: backups/${MIGRATION_DUMP} is not there — refusing to put the previous build on a migrated volume"
    return 1
  fi
  say "restore: backups/${MIGRATION_DUMP} over book.db (WAL and SHM first, a temp name in backups/, then mv)"
  if ! rm -f "${dest}-wal" "${dest}-shm"; then
    say "restore: cannot remove the WAL/SHM beside ${dest} — book.db was NOT replaced"
    return 1
  fi
  if ! cp "$dump" "$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    say "restore: cp of backups/${MIGRATION_DUMP} failed — book.db was NOT replaced"
    return 1
  fi
  if ! mv "$tmp" "$dest"; then
    rm -f "$tmp" 2>/dev/null || true
    say "restore: mv of ${tmp} over ${dest} failed — the old book.db is still in place"
    return 1
  fi
  # The volume is back on the pre-deploy schema: the record a `--rollback` reads no longer applies.
  rm -f "$VOLUME_MIGRATED_FILE"
  say "restore: restored backups/${MIGRATION_DUMP} over book.db — the volume is back on the pre-deploy schema and volume-migrated is cleared"
  return 0
}

# --- the migration record a `--rollback` reads (BOOK-217) ---------------------------------------
#
# A run that migrated leaves the fact on the host, with the schema the deployed build understands. An
# older build put on that volume would refuse the boot (`SCHEMA_FUTURE`) and crash-loop — the
# incident — so `--rollback` asks before it fetches, checks out or builds anything. The number comes
# from the build's own constant in the repo at its commit; a read that fails is never a 0.

# The schema version a commit understands, from `site/server/src/db/schema.ts` at that commit. The
# deployed build and an old last-good sha are both commits in `$ROOT`, so the question is answered
# without starting anything; a read that fails is an empty answer, never a 0.
schema_of_commit() { # (sha) -> the SCHEMA_VERSION that commit carries, or nothing
  local sha="$1" source=""
  [ -n "$sha" ] || return 0
  source="$(git -C "$ROOT" show "${sha}:site/server/src/db/schema.ts" 2>/dev/null)" || return 0
  printf '%s\n' "$source" | sed -n 's/^export const SCHEMA_VERSION = \([0-9][0-9]*\);.*$/\1/p' | head -n 1 || true
  return 0
}

# The record a migrating run leaves: `schema=<n>`, or `schema=unknown` when the constant cannot be
# read (the record then says "migrated, schema unknown" and `--rollback` keeps today's behaviour
# rather than inventing a number). Written on the green path too: a green deploy that migrated is
# still a migrated volume.
record_volume_migrated() {
  local sha="" schema=""
  [ "$MIGRATED" = "1" ] || return 0
  sha="${GOOD:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
  schema="$(schema_of_commit "$sha")"
  mkdir -p "$STATE_DIR"
  printf 'schema=%s\n' "${schema:-unknown}" >"$VOLUME_MIGRATED_FILE"
  say "volume-migrated: recorded schema=${schema:-unknown} in $VOLUME_MIGRATED_FILE — --rollback will refuse a build that predates it"
}

# The guard `--rollback` runs before anything is fetched, checked out or built. A build that
# understands an older schema than the record names is refused with nothing started; an absent or
# unreadable record keeps today's behaviour and says so in one line.
volume_migrated_guard() { # (target sha or tag)
  local target="$1" recorded="" target_schema=""
  if [ ! -f "$VOLUME_MIGRATED_FILE" ]; then
    say "volume-migrated: no record at $VOLUME_MIGRATED_FILE — nothing says a deploy moved the volume, so the rollback proceeds as usual (a migration this host did not record cannot be ruled out)"
    return 0
  fi
  recorded="$(sed -n 's/^schema=//p' "$VOLUME_MIGRATED_FILE" | head -n 1 || true)"
  if ! is_number "$recorded"; then
    say "volume-migrated: the record says schema=${recorded:-nothing}, not a number — the volume was migrated but its schema is unknown, so the rollback proceeds as usual"
    return 0
  fi
  target_schema="$(schema_of_commit "${target##*:}")"
  if ! is_number "$target_schema"; then
    say "volume-migrated: the volume is at schema v${recorded}; the target build carries no readable SCHEMA_VERSION, so the rollback proceeds as usual"
    return 0
  fi
  if [ "$target_schema" -lt "$recorded" ]; then
    die "the volume is at schema v${recorded} (a deploy migrated it) and the build being rolled back to understands v${target_schema} — putting it on that volume would refuse the schema and crash-loop; restore a dump instead: the volume dump restore is the deploy's own path (or an explicit operator restore of a dump into the service's DATA_DIR; site/deploy/restore-drill.sh restores into a scratch copy and never touches the volume), and $VOLUME_MIGRATED_FILE is the record that must be deleted to override this refusal deliberately; nothing was fetched, checked out or built"
  fi
  say "volume-migrated: the volume is at schema v${recorded} and the target build understands v${target_schema} — the rollback is safe on this volume"
}

# Read the fact ONCE per run (the green record, the audit and the recovery must all name the same
# listing), and only after this run reached the restart: a failure before it never booted, has no
# migration and writes no record. A run that migrated records it whatever it decides next.
migration_read() {
  if [ "$MIGRATION_READ" = "1" ] || [ "$REACHED_RESTART" != "1" ]; then return 0; fi
  STEP="migration: after"
  MIGRATION_READ=1
  migration_after
  record_volume_migrated
  return 0
}

# A green deploy whose fact could not be read says so: it is still green, but no record was written,
# so a later `--rollback` cannot rule a migration out — never a silent no-op.
note_unknown_migration() {
  [ "$MIGRATED" = "unknown" ] || return 0
  say "volume-migrated: the fact is unknown (${MIGRATION_WHY}) — no record was written, so --rollback keeps its usual behaviour and cannot rule a migration out"
  return 0
}

# The service is unloaded before a dump goes over its database: a job in a crash loop is still a
# writer between attempts, and a live process would keep a WAL over the file being replaced.
recovery_bootout() {
  local status=0 out=""
  out="$(launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    say "restore: $SERVICE_LABEL is stopped (launchctl bootout) before the dump goes over book.db"
    return 0
  fi
  say "restore: $SERVICE_LABEL was not loaded (${out:-no output}) — nothing to stop before the restore"
}

# --- the launchd job's own record (BOOK-217) -----------------------------------------------------
#
# `launchctl print` is the only place a respawn is visible: `runs = N` counts the spawns and
# `last exit code = M` the last one that exited. `kickstart -k` is itself one run and leaves no exit
# code for the process it killed (measured: the line is absent, not a signal number), so an extra run
# is the job dying on its own — and a code only speaks when it appeared under this run. A `print`
# that does not answer is `unknown` — it is never read as health.

service_runs() { # (label) -> RUNS, EXIT_CODE
  local out=""
  RUNS="unknown"; EXIT_CODE="unknown"
  out="$(launchctl print "gui/$(id -u)/$1" 2>/dev/null)" || return 0
  RUNS="$(printf '%s\n' "$out" | sed -n 's/.*runs = \([0-9][0-9]*\).*/\1/p' | head -n 1)"
  EXIT_CODE="$(printf '%s\n' "$out" | sed -n 's/.*last exit code = \(-\{0,1\}[0-9][0-9]*\).*/\1/p' | head -n 1)"
  [ -n "$RUNS" ] || RUNS="unknown"
  [ -n "$EXIT_CODE" ] || EXIT_CODE="unknown"
  return 0
}

# A code that is not a clean 0: a negative number is a signal, a positive one an ordinary failure.
exit_nonzero() {
  case "${1:-}" in
    ''|unknown|0) return 1 ;;
    -[0-9]*|[0-9]*) return 0 ;;
  esac
  return 1
}

crash_loop_before() {
  STEP="crash loop: before"
  service_runs "$SERVICE_LABEL"
  RUNS_BEFORE="$RUNS"; EXIT_BEFORE="$EXIT_CODE"
  say "crash loop: before the restart — runs=${RUNS_BEFORE}, last exit code=${EXIT_BEFORE}"
}

crash_loop_line() { # (resumed, last exit code)
  local line="CRASH LOOP: ${SERVICE_LABEL} resumed ${1:-unknown} time(s), last exit code ${2:-unknown} — the service cannot boot; prod is not serving"
  CRASHLOOP=1
  say "$line"
  # The workflow reads `::error::` as a failed step annotation: the alarm is the run, not a human
  # noticing a 502 two minutes later.
  if [ -n "${GITHUB_ACTIONS:-}" ]; then printf '::error::%s\n' "$line"; fi
}

# After a failed window: the job's runs and its last exit are the evidence. `runs_after > runs_before
# + 1` is a respawn the deploy did not ask for. A non-zero last exit is evidence only when it is a
# DEATH UNDER THIS RUN: the code is compared with the snapshot taken before the kickstart (a job that
# exited non-zero weeks ago carries that code into a failed window that never killed it), and the job
# must have respawned at least once under this run (the deploy's own `kickstart -k` is one run) — an
# unchanged record says nothing, and it is never a 0 either. An unreadable `print` says `unknown` and
# claims nothing.
crash_loop_check() {
  local resumed=""
  STEP="crash loop"
  service_runs "$SERVICE_LABEL"
  RUNS_AFTER="$RUNS"; EXIT_AFTER="$EXIT_CODE"
  say "crash loop: after the failed window — runs=${RUNS_AFTER}, last exit code=${EXIT_AFTER}"
  if [ "$RUNS_AFTER" = "unknown" ]; then
    say "crash loop: unknown — launchctl print did not answer; a job that cannot be read is not evidence of health"
    return 0
  fi
  if is_number "$RUNS_BEFORE" && [ "$RUNS_AFTER" -gt "$RUNS_BEFORE" ]; then
    resumed=$(( RUNS_AFTER - RUNS_BEFORE ))
  fi
  if [ -n "$resumed" ] && [ "$resumed" -gt 1 ]; then
    crash_loop_line "$resumed" "$EXIT_AFTER"
    return 0
  fi
  if [ -n "$resumed" ] && [ "$resumed" -ge 1 ] && [ "$EXIT_AFTER" != "$EXIT_BEFORE" ] && exit_nonzero "$EXIT_AFTER"; then
    crash_loop_line "$resumed" "$EXIT_AFTER"
  fi
  return 0
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

  # BOOK-217: `--rollback` must not put a build on a volume a deploy migrated. The record is read
  # BEFORE the fetch and the checkout, so a refusal changes nothing at all — and a target that
  # understands an older schema is refused here, which is the incident this exists to prevent. The
  # record and the target's constant are both plain reads (a file and `git show`), so no network,
  # no build and no restart is needed to know.
  if [ "$MODE" = "rollback" ]; then
    TARGET="$(cat "$STATE_DIR/last-good" 2>/dev/null || true)"
    [ -n "$TARGET" ] || TARGET="$(git -C "$ROOT" rev-parse --verify HEAD^ 2>/dev/null || true)"
    [ -n "$TARGET" ] || die "nothing to roll back to (no last-good record and no previous commit)"
    STEP="prepare: volume guard"
    volume_migrated_guard "$TARGET"
  fi

  say "fetching $REPO_URL"
  git -C "$ROOT" fetch --quiet --tags --prune origin || die "git fetch failed"

  if [ "$MODE" != "rollback" ]; then
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
say "gate: verify (typecheck, arch, frame-check)"
npm run verify || die "gate (verify) is red — nothing was deployed or restarted"
STEP="gate: home"
DATA_DIR_SITE="$(data_dir_of_service)"
[ -n "$DATA_DIR_SITE" ] || die "the service names no DATA_DIR — a deploy without the volume cannot check the book; nothing was deployed or restarted"
# The switch opens here, with the cutover (BOOK-187 AC12) — not after the gate: the reader of the
# volume must meet a volume that no longer has a writer in it, and the old image writes one.
writer_stop
say "cutover: home-migrate --apply on $DATA_DIR_SITE (dry run first, then the one-way fold)"
node "$ROOT/site/bin/home-migrate.mjs" --data-dir "$DATA_DIR_SITE" || die "the volume cutover dry run refused (its reason is above) — nothing was deployed or restarted"
node "$ROOT/site/bin/home-migrate.mjs" --data-dir "$DATA_DIR_SITE" --apply || die "the volume cutover refused (its reason is above; nothing in the volume was changed) — nothing was deployed or restarted"
say "gate: home (the volume and manuscript/ hold only what they may)"
node "$ROOT/site/bin/home-check.mjs" --data-dir "$DATA_DIR_SITE" || die "$HOME_FAILED — nothing was deployed or restarted"
STEP="gate: coverage"
say "gate: coverage"
npm run test:coverage || die "coverage floor not met — nothing was deployed or restarted"
STEP="gate: build"
say "gate: build"
npm run build || die "build failed — nothing was deployed or restarted"
STEP="gate: text (DB)"
say "gate: text (DB)"
node "$ROOT/site/bin/validate.mjs" --from-db "$DATA_DIR_SITE" --strict || die "the text as stored is invalid — nothing was deployed or restarted"

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
# BOOK-217: both reads happen before the boot can move anything — the job's own run record, and the
# volume as the previous build left it.
crash_loop_before
migration_before
STEP="restart"
REACHED_RESTART=1
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
  # BOOK-217: a green deploy that migrated is still a migrated volume — the fact is read and
  # recorded here, before `last-good` is written, so a later `--rollback` cannot put an older build
  # on it. A fact that could not be read is said, not silently dropped.
  migration_read
  note_unknown_migration
  finish_green || true
fi

# BOOK-217: a failed window is where a job that cannot boot hides. The job's own record is read once
# here, before anything below can restart it.
case "$HEALTH" in fail|stale)
  STEP="crash loop"
  crash_loop_check
  ;;
esac

STEP="health window"
# --- red path ----------------------------------------------------------------------------------
# One plain read (three when the window saw nothing usable) is the last evidence before anything is
# rebuilt or restarted. It upgrades a verdict the window missed and stamps its own moment (B2), so
# `health=late` never reaches an audit with `restart_ms=unknown`.
plain_verdict "$URL" "$BUILT_COMMIT" "$PREV" 3 || true
recompute_window
if [ "$HEALTH" = "fast" ] || [ "$HEALTH" = "late" ]; then
  if [ "$CRASHLOOP" = "1" ]; then
    # A late 200 does not launder a job that keeps dying: fall through to the red path, where the
    # migration fact and the recovery are named — a respawning job is never a green deploy.
    say "late 200, but the job respawned after the failed window — a respawning job is not a green deploy"
  else
    say "late success: prod serves ${PLAIN_COMMIT:-$BUILT_COMMIT} — the deploy went through and the measurement lost it; no rebuild, no second restart"
    migration_read
    note_unknown_migration
    finish_green || true
  fi
fi

# BOOK-217: the boot had its chance; the volume is read once here (`migration_read` is a no-op if the
# green path already read it), so every red path below names the same fact. A failure that never
# reached the restart never booted, has no migration and owes no `recovery:` line.
migration_read

# The three-way rule (`lib.sh:recovery_choice`). `serving` is *this* build answering, not "something
# answers": the previous build answering is the state a dump restore is for.
RECOVERY_SERVING=0
case "$HEALTH" in fast|late) RECOVERY_SERVING=1 ;; esac
if names_commit "$PLAIN_COMMIT" "$BUILT_COMMIT"; then RECOVERY_SERVING=1; fi
if [ "$REACHED_RESTART" = 1 ]; then
  RECOVERY_PICK="$(recovery_choice "$MIGRATED" "$RECOVERY_SERVING")"
fi

# Migrated and this build answers: the previous build would refuse the schema (`SCHEMA_FUTURE`) and
# take prod down with it. Leave this one serving, write no `last-good`, and stay red. This sits in
# front of the frame and install refusals on purpose — both leave the running build in service, and
# the honest name for that on a migrated volume is a roll-forward.
if [ "$RECOVERY_PICK" = "roll-forward" ]; then
  STEP="recovery"
  RECOVERY_CHOICE="roll-forward"
  say "$(recovery_line "$RECOVERY_CHOICE" "$MIGRATION_WHY")"
  audit "roll-forward mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=$FRAME pwa=$PWA restart=$(restart_field) recovery=$RECOVERY_CHOICE crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "the volume was migrated (${MIGRATION_WHY}) and this build answers, so the previous build is NOT put back — $SHORT keeps serving (degraded, alive); last-good was not written, a human must look"
fi

# The fact is `unknown` (a listing of `backups/` failed): neither rounding is safe. An image swap on a
# volume that may have migrated is the crash loop, and a restore on a volume that may not have is an
# old copy over the live book. So nothing is checked out, nothing is restored and nothing is
# restarted — the one `recovery: none` line says why, and a human looks. This sits before the
# "already serving" shortcut too: that shortcut writes `last-good` for a volume it did not read.
if [ "$RECOVERY_PICK" = "none" ]; then
  STEP="recovery"
  RECOVERY_CHOICE="none"
  say "$(recovery_line none "$MIGRATION_WHY")"
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=$FRAME pwa=$PWA restart=$(restart_field) recovery=none crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "the migration fact is unknown (${MIGRATION_WHY}) — no build was put back and no dump was restored; nothing was checked out, rebuilt or restarted. A human must look"
fi

# The process already serves the previous commit: nothing was rebuilt, and nothing will be. In
# `--rollback` mode `PREV` is re-read from `$STATE_DIR/previous`: it is the commit being rolled
# back *from*, so the skip is deploy-only, and a rollback that did not reach its own commit is
# `rollback-failed` and never touches `last-good`.
#
# BOOK-217: this shortcut is for a volume that did NOT move. A migrated volume with the previous
# build still answering is a recovery, not a skip — that process refuses the schema on its next
# restart, so the dump goes back and the ordinary rollback runs (below).
if [ "$MODE" = "deploy" ] && [ "$MIGRATED" != "1" ] && [ -n "$PREV" ] && names_commit "$PLAIN_COMMIT" "$PREV"; then
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
    audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$BUILT_COMMIT release=$RELEASE health=$HEALTH frame=ok restart=skipped recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
    say "deploy of $SHORT is red; prod still serves ${PREV:0:7}, current is back on release $RELEASE — the process was not restarted"
    exit 1
  fi
  # The process answers, but not with the canon: `last-good` must not record it, and a restart
  # of the same commit would not change what the data says.
  FRAME="fail"
  say "the running process answers ${PREV:0:7} but does not serve the frozen frame; last-good was NOT written — a human must look at the canon"
  audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$BUILT_COMMIT release=$RELEASE health=$HEALTH frame=fail restart=skipped recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  exit 1
fi

# A restart that was never issued says nothing about the build: no rollback, no second attempt to
# signal the same broken job — a human has to look at the service. BOOK-217: the header promises one
# `recovery:` line for every path that reached the restart, and this one did — the signal never
# reached launchd, so no boot ran and nothing was migrated. The line is `none` for exactly that
# reason: there is no migration fact to decide from.
if [ "$HEALTH" = "none" ]; then
  STEP="recovery"
  RECOVERY_CHOICE="none"
  say "$(recovery_line none "the restart was never issued, so no boot ran and nothing was migrated")"
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=none frame=$FRAME restart=failed recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "the restart could not be issued (kickstart failed even after bootstrapping from $PLIST) — nothing was restarted, nothing was rolled back; prod answers ${PLAIN_COMMIT:-nothing} at $URL; a human must look"
fi

# A frame failure is a canon problem, not a code one: a rollback would restart code that is
# already answering and change nothing about the data — so nothing is restarted, and the message
# names what answered.
if [ "$FRAME" = "fail" ]; then
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=fail restart=skipped recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
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
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=$FRAME pwa=fail restart=$(restart_field) recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "prod answers ${PLAIN_COMMIT:-nothing} but does not serve the installable shell (manifest, service worker) — nothing was restarted; a human must look at $URL/sw.js and $URL/manifest.webmanifest"
fi

# A rollback that did not reach its own commit has nothing better behind it: the generic path
# below would check out `PREV`, which in this mode is the commit the rollback exists to leave.
if [ "$MODE" = "rollback" ]; then
  audit "rollback-failed mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=$FRAME restart=$(restart_field) release=$RELEASE recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  if [ -n "$PLAIN_COMMIT" ]; then
    die "the rollback did not come up healthy (health=$HEALTH after ${HEALTH_MS} ms of ${BUDGET_MS} ms, frame=$FRAME); prod answers $PLAIN_COMMIT, not the commit the rollback built — a human must look"
  fi
  die "the rollback did not come up healthy (health=$HEALTH after ${HEALTH_MS} ms of ${BUDGET_MS} ms, frame=$FRAME); prod answers nothing at $URL — a human must look"
fi

# A4: two independent negatives, or prod is not restarted on a guess.
if ! rollback_allowed "$HEALTH_MS" "$BUDGET_MS" "$PLAIN_COMMIT" "$BUILT_COMMIT"; then
  audit "rollback-refused mode=$MODE ref=$REF sha=$BUILT_COMMIT prev=${PREV:0:7} release=$RELEASE health=$HEALTH frame=$FRAME restart=skipped recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
  die "not rolling back — $ROLLBACK_WHY; a rollback restarts prod, and this verdict has only one negative. Nothing was restarted. A human must look"
fi

[ -n "$PREV" ] || die "no previous commit to roll back to; prod is NOT serving the build of this run — a human must look"

# BOOK-217: the recovery a rollback means on this volume, decided before the checkout. A dump restore
# goes first (the service is stopped for it), then the ordinary rollback below runs on the schema the
# dump brought back. `image-rollback` is the same schema, so nothing is restored. A run that never
# reached the restart has no pick here and prints no `recovery:` line.
case "$RECOVERY_PICK" in
  dump-restore)
    RECOVERY_CHOICE="dump-restore"
    recovery_bootout
    if ! restore_dump; then
      RECOVERY_CHOICE=""
      audit "rollback-failed mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=$FRAME restart=$(restart_field) release=$RELEASE recovery=none crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
      die "the volume was migrated (${MIGRATION_WHY}) and the pre-deploy dump could not be restored; the previous build was NOT put back, so nothing was rolled back — a human must look"
    fi
    say "$(recovery_line "$RECOVERY_CHOICE" "$MIGRATION_WHY")"
    ;;
  image-rollback)
    RECOVERY_CHOICE="image-rollback"
    say "$(recovery_line "$RECOVERY_CHOICE" "$MIGRATION_WHY")"
    ;;
esac

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
    audit "rolled-back mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=ok restart=$(restart_field) release=$RELEASE recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
    say "rolled back to ${PREV:0:7}; prod healthy; the deploy of $SHORT stays red"
    exit 1
  fi
  FRAME="fail"
  say "the rollback answers but does not serve the frozen frame; last-good was NOT written"
fi

# The process answering with the *deploy's* build after the rollback is the incident's exact
# state: the site was up the whole time. That is a late success — green, and the audit says it. A
# job seen respawning after the failed window is not: it falls through to `rollback-failed`.
if [ "$HEALTH" = "stale" ] && [ "$CRASHLOOP" != "1" ] && names_commit "$PLAIN_COMMIT" "$BUILT_COMMIT"; then
  HEALTH="late"
  SLOW=1
  say "late success: prod serves ${PLAIN_COMMIT} (the build of the deploy that was being rolled back) — nothing is restarted again"
  if [ -n "$RELEASE" ] && [ "$RELEASE" != "unknown" ]; then
    say "note: current names release $RELEASE (the rollback's publish) while the process serves $SHORT — the next deploy makes disk agree"
  fi
  finish_green keep || true
fi

audit "rollback-failed mode=$MODE ref=$REF sha=$PREV target=$GOOD health=$HEALTH frame=$FRAME restart=$(restart_field) release=$RELEASE recovery=${RECOVERY_CHOICE:-none} crashloop=$CRASHLOOP $(audit_tail "$RESTART_MS" "$HEALTH_MS" "$PERCENT" "$BASELINE")"
if [ -n "$PLAIN_COMMIT" ]; then
  die "rollback did not come up healthy (health=$HEALTH after ${HEALTH_MS} ms, frame=$FRAME); prod answers $PLAIN_COMMIT, not the build of this run — a human must look; the audit names release=${RELEASE:-unknown} (log: ~/Library/Logs/book-site.log)"
fi
die "rollback did not come up healthy either — prod answers nothing at $URL, a human must look; the audit names release=${RELEASE:-unknown}, health=$HEALTH, frame=$FRAME (log: ~/Library/Logs/book-site.log)"
