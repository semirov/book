#!/bin/bash
# site/deploy/lib.sh — what a deploy measures, and who may run one (BOOK-119 hotfix, second pass).
#
# Sourced by `deploy.sh` (and by its tests); it runs nothing on its own. It ships beside
# `deploy.sh` and is extracted with it by the workflow, so both always come from one commit.
#
# 1. One probe, one result shape. There used to be two: a node helper for the window and a `curl`
#    for the baseline, and they disagreed — a deploy printed `baseline=down` while `/healthz` had
#    answered 200 a second earlier, and `fail after 0 ms` from a helper that returned at once.
#    `health_read` is now the only probe: a plain `curl --max-time 2` filling one struct
#    (R_CODE, R_STATUS, R_OK, R_COMMIT, R_ERR). The baseline, the restart window and every re-read
#    use it, so they cannot contradict each other, and a failed read records *why*
#    (`err=<curl exit>`, and curl's own first line in the log) instead of being called "down".
#
# 2. One deadline, and a real elapsed time. The window polls from `KICKSTART_T0` within the budget
#    and then the grace; the first read happens before any deadline check, so a window entered late
#    still reads once (`fail after 0 ms` was a loop that checked its clock before reading). A
#    `health=fail` that has not spent the budget is measured again, never returned as a verdict.
#
# 3. The rest of the deploy's primitives live here too, so they can be exercised without a deploy:
#    the rollback gate (`rollback_allowed`: two independent negatives), the load reading (parsed
#    from `sysctl`, never `unknown` when a number is there), the service start (including the
#    bootstrap of a job that is not loaded) and the lock (one deploy per root, atomic takeover). A
#    takeover that loses its race is re-read once after `BOOK_LOCK_RETRY_S`: a refusal names the
#    holder that is really there, or says a taker is active — never "pid unknown" on a free lock.

# --- numbers and names the callers share --------------------------------------------------------

BUDGET_MS="${BUDGET_MS:-180000}" # the deploy's own numbers; `deploy.sh` recomputes them from flags
GRACE_MS="${GRACE_MS:-60000}"
# The probe the deploy measures with. One plain curl serves the baseline, the window and the
# re-reads; the field stays in the log and the audit so today's lines stay comparable with the
# ones that named a node helper.
PROBE_USED="curl"
# What the lock did for this run: `none` (never taken), `held`, `taken-over` (a stale one replaced).
LOCK="${LOCK:-none}"
LOCK_OWNED="${LOCK_OWNED:-0}"
LOCK_STALE_S="${BOOK_LOCK_STALE_S:-2700}" # 45 min: a lock that old cannot belong to a live deploy
LOCK_RETRY_S="${BOOK_LOCK_RETRY_S:-1}"     # one settle before a collided takeover is read again
LOCK_HOLDER=""; LOCK_SINCE=""; LOCK_AGE=0 # what the last read of the lock directory found
# The instant before the restart this run issued; every window and re-read is measured from it.
KICKSTART_T0="${KICKSTART_T0:-}"
# `bootstrap` when a job that was not loaded had to be bootstrapped from its plist, else "".
KICKSTART_RECOVERED=""

# Epoch seconds, as a command: `BOOK_NOW` pins it for a test, `date` is the box. A clock that
# cannot answer leaves the value empty — `lock_age` then says 0, so a broken clock can never make a
# live lock look stale.
now_s() {
  if [ -n "${BOOK_NOW:-}" ]; then printf '%s' "$BOOK_NOW"; return 0; fi
  date +%s 2>/dev/null || true
}

# Is pid `$1` alive? `BOOK_KILL` replaces `kill -0` for a test; a liveness check that fails is "no",
# never an exit.
pid_alive() {
  # shellcheck disable=SC2086  # `BOOK_KILL` may be a command with arguments in a test
  ${BOOK_KILL:-kill} -0 "${1:-}" 2>/dev/null
}

# Epoch milliseconds. `node` is the box's clock; when node is unavailable, `perl` (which ships with
# macOS and with every runner) keeps the window honest to the millisecond, and whole seconds are
# the last resort so a loop can still finish.
now_ms() {
  node -p 'Date.now()' 2>/dev/null && return 0
  perl -MTime::HiRes=time -e 'printf "%d\n", time*1000' 2>/dev/null && return 0
  printf '%s000' "$(now_s)"
}

# Digits only: a value from a file or a probe must never be handed to `$(( ))` as a word.
is_number() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# Is `$1` the commit `$2` names? Args order: (long, reported) — the report may be abbreviated.
starts_with() { case "$1" in "$2"*) return 0 ;; *) return 1 ;; esac; }

# Does the commit the site reports (`$1`) name `$2`? Abbreviated in either direction, and never a
# match on an empty report — `/healthz` prints the build's short sha, the deploy knows the full one.
names_commit() {
  [ -n "${1:-}" ] && [ -n "${2:-}" ] || return 1
  starts_with "$1" "$2" || starts_with "$2" "$1"
}

# The lib is sourced by `deploy.sh`, which has `say`, and by tests, which may not.
window_stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
window_say() {
  if declare -F say >/dev/null 2>&1; then say "$*"; else printf '%s deploy: %s\n' "$(window_stamp)" "$*"; fi
}

# --- one probe, one result shape ----------------------------------------------------------------

# One plain read of `/healthz`. Fills:
#   R_CODE   curl's exit code: 0 when the server answered, anything else when it could not
#   R_STATUS the HTTP status (`000` when there is none)
#   R_OK     1 when the answer is 200 and `"ok":true`
#   R_COMMIT the commit the process reports ("" when it names none)
#   R_ERR    curl's first stderr line ("" when the read itself succeeded)
# Always returns 0: "the site did not answer" is the answer (`R_OK=0`), and a probe that returned
# non-zero would let `set -e` kill a deploy inside its health window — the 00:36 run died exactly
# there, with `lock: released` as its last line and no reason.
health_read() { # (url)
  local url="$1" raw code=0 status body
  R_CODE=0; R_STATUS=0; R_OK=0; R_COMMIT=""; R_ERR=""
  if ! command -v curl >/dev/null 2>&1; then
    R_CODE=127; R_ERR="curl: not on PATH"
    return 0
  fi
  # `%{http_code}` is written even when the transfer fails (`000`), so one call carries the status,
  # the body and curl's own error text. The marker is plain text on purpose: `-w @file` means
  # "read the format from a file" in curl, so it cannot start with `@`. The `||` keeps a failed
  # read an answer of this function instead of an exit under `set -e`.
  raw="$(curl -sS --max-time 2 -w 'PROBE_HTTP=%{http_code}' "$url" 2>&1)" || code=$?
  R_CODE="$code"
  status="${raw##*PROBE_HTTP=}"
  body="${raw%%PROBE_HTTP=*}"
  case "$status" in [0-9][0-9][0-9]) R_STATUS="$status" ;; *) R_STATUS=0 ;; esac
  if [ "$R_STATUS" = "000" ]; then R_STATUS=0; fi # curl's "no HTTP status at all"
  if [ "$code" -ne 0 ]; then
    R_ERR="$(printf '%s\n' "$body" | head -n 1 2>/dev/null || true)"
    return 0
  fi
  if [ "$R_STATUS" = "200" ] && printf '%s' "$body" | grep -q '"ok":true' 2>/dev/null; then
    R_OK=1
    R_COMMIT="$(printf '%s' "$body" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' 2>/dev/null || true)"
  fi
  return 0
}

# --- the baseline -------------------------------------------------------------------------------

# The last 200 before the restart, measured by the same probe as the window. `up` needs a real 200
# with `ok:true`; `down` is a real answer that is not one; `unknown` is a read that could not be
# made, and then `BASELINE_ERR` carries curl's exit code — the site is never called "down" because
# a measurement failed.
baseline_read() { # (url) -> BASELINE, BASELINE_STATUS, BASELINE_AT, BASELINE_COMMIT, BASELINE_ERR, BASELINE_MSG
  BASELINE="unknown"; BASELINE_STATUS=0; BASELINE_AT=0; BASELINE_COMMIT=""; BASELINE_ERR=""; BASELINE_MSG=""
  health_read "$1"
  BASELINE_STATUS="$R_STATUS"
  if [ "$R_OK" = "1" ]; then
    BASELINE="up"
    BASELINE_AT="$(now_ms)"
    BASELINE_COMMIT="$R_COMMIT"
    return 0
  fi
  if [ "$R_CODE" -ne 0 ]; then
    BASELINE="unknown"
    BASELINE_ERR="$R_CODE"
    BASELINE_MSG="$R_ERR"
    return 1
  fi
  BASELINE="down"
  BASELINE_ERR="none"
  return 0
}

# --- the restart window -------------------------------------------------------------------------

# Poll `/healthz` from `since` (the instant before `kickstart`) every 200 ms inside the budget and
# then the grace. `health=fast` when a 200 naming `expect` arrives inside the budget, `late` when it
# arrives later, `stale` when the answer names `prev` (the new code never served), `fail` otherwise.
# The first read happens before any deadline check — a window entered late still reads once — and a
# `fail` always carries the time the loop really spent (`health_ms`), never `0` at its start.
window_read() { # (url expect prev since_ms)
  local url="$1" expect="$2" prev="${3:-}" since="$4"
  local budget_end=$(( since + BUDGET_MS )) grace_end_ms=$(( since + BUDGET_MS + GRACE_MS ))
  local grace_end_s=$(( grace_end_ms / 1000 ))
  local at=0 last_commit="" last_at=0 reads=0 now=0
  # A clock that cannot answer must not make the loop endless: the poll count is the second bound.
  local max_reads=$(( (BUDGET_MS + GRACE_MS) / 200 + 2 ))
  HEALTH="fail"; HEALTH_MS=0; FIRST_AT=0; REPORTED_COMMIT=""; WINDOW_READS=0
  while :; do
    health_read "$url"
    reads=$(( reads + 1 ))
    if [ "$R_OK" = "1" ]; then
      at="$(now_ms)"
      last_commit="$R_COMMIT"
      last_at="$at"
      if names_commit "$R_COMMIT" "$expect"; then
        FIRST_AT="$at"
        if [ "$at" -le "$budget_end" ]; then HEALTH="fast"; else HEALTH="late"; fi
        break
      fi
      if [ "$at" -gt "$budget_end" ] && names_commit "$R_COMMIT" "$prev"; then
        FIRST_AT="$at"; REPORTED_COMMIT="$R_COMMIT"; HEALTH="stale"
        break
      fi
    fi
    # One deadline for every poll. `now_s` is the cheap clock and only the last second is checked
    # to the millisecond, so a sub-second budget is still spent and the poll stays 200 ms. A clock
    # that fails leaves the deadline to `max_reads`; a `sleep` that fails is one fast poll.
    if [ "$reads" -ge "$max_reads" ]; then break; fi
    now="$(now_s)"
    if is_number "$now" && [ "$now" -ge "$grace_end_s" ] && [ "$(now_ms)" -ge "$grace_end_ms" ]; then break; fi
    sleep 0.2 || true
  done
  if [ "$HEALTH" = "fail" ] && [ -n "$last_commit" ] && names_commit "$last_commit" "$prev"; then
    HEALTH="stale"; FIRST_AT="$last_at"; REPORTED_COMMIT="$last_commit"
  fi
  if [ "$HEALTH" = "fail" ]; then
    REPORTED_COMMIT="$last_commit" # what answered, if anything — the verdict is still `fail`
    HEALTH_MS=$(( $(now_ms) - since ))
  else
    HEALTH_MS=$(( FIRST_AT - since ))
  fi
  [ "$HEALTH_MS" -ge 0 ] || HEALTH_MS=0
  WINDOW_READS="$reads"
}

# The window with the budget invariant enforced: a `fail` that did not spend the budget is not a
# verdict (it was measured before the window began), so it is measured again — never returned as
# `fail after 0 ms`.
window_settle() { # (url expect prev since_ms)
  local attempt=1
  window_read "$1" "$2" "$3" "$4"
  while [ "$HEALTH" = "fail" ] && [ "$HEALTH_MS" -lt "$BUDGET_MS" ] && [ "$attempt" -lt 3 ]; do
    attempt=$(( attempt + 1 ))
    window_say "window: health=fail after ${HEALTH_MS} ms is less than the ${BUDGET_MS} ms budget — not a verdict, measuring again (#${attempt})"
    window_read "$1" "$2" "$3" "$4"
  done
}

# What one 200 means for the restart this run issued: the commit it built (`late` — the window
# missed it), the previous build (`stale` — the new one never served), or neither (verdict stands).
# An upgrade stamps its own moment, so an audit can never print `health=late restart_ms=unknown`.
window_classify() { # (commit expect prev)
  local at
  if names_commit "${1:-}" "$2"; then
    HEALTH="late"; SLOW=1
  elif [ -n "${3:-}" ] && names_commit "$1" "$3"; then
    HEALTH="stale"; REPORTED_COMMIT="$1"
  else
    return 1
  fi
  at="$(now_ms)"
  FIRST_AT="$at"
  HEALTH_MS=$(( at - ${KICKSTART_T0:-$at} ))
  [ "$HEALTH_MS" -ge 0 ] || HEALTH_MS=0
  return 0
}

# The evidence before a red verdict: plain reads of what prod answers right now (`tries` of them,
# 400 ms apart). A 200 naming this run's build upgrades the verdict to `late`, the previous build
# to `stale`; silence keeps the verdict. Sets PLAIN_COMMIT and returns 1 when nothing answered.
plain_verdict() { # (url expect prev [tries])
  local url="$1" expect="$2" prev="${3:-}" tries="${4:-1}" attempt=0 commit="" answered=0
  PLAIN_COMMIT=""
  while [ "$attempt" -lt "$tries" ]; do
    attempt=$(( attempt + 1 ))
    health_read "$url"
    if [ "$R_OK" = "1" ]; then
      answered=1
      commit="$R_COMMIT"
      break
    fi
    if [ "$attempt" -lt "$tries" ]; then sleep 0.4 || true; fi
  done
  if [ "$answered" != "1" ]; then
    window_say "plain read: no answer on $url after ${attempt} read(s) (err=${R_CODE}${R_ERR:+ ${R_ERR}}) — the $HEALTH verdict stands"
    return 1
  fi
  PLAIN_COMMIT="$commit"
  window_say "plain read: prod reports ${commit:-no commit} (200 on $url)"
  window_classify "$commit" "$expect" "$prev" || true
  return 0
}

# The audit's `restart=`, derived from the verdict printed beside it — a late success can never be
# audited as `restart=failed`, because it is the same variable that says `late`.
restart_field() { case "$HEALTH" in fast|late) printf 'ran' ;; *) printf 'failed' ;; esac; }

# A rollback restarts prod, so it needs two independent negatives: the window spent its whole
# budget, and a plain read says the process is *not* serving the commit this run built. Either one
# alone is not a reason to restart.
rollback_allowed() { # (health_ms budget_ms plain_commit target_commit) -> sets ROLLBACK_WHY on no
  ROLLBACK_WHY=""
  if ! is_number "${1:-}" || ! is_number "${2:-}" || [ "$1" -lt "$2" ]; then
    ROLLBACK_WHY="the window spent ${1:-0} ms of its ${2:-0} ms budget (health=${HEALTH:-unknown}) — it has not finished looking"
    return 1
  fi
  if [ -n "${3:-}" ] && names_commit "$3" "${4:-}"; then
    ROLLBACK_WHY="prod answers $3, the build of this run — there is nothing to roll back to"
    return 1
  fi
  return 0
}

# --- the recovery a failed release takes (BOOK-217) ---------------------------------------------
#
# A release that fails after its new image booted may have already migrated the volume: the boot
# writes `backups/pre-v<from>-<stamp>.db` BEFORE any DDL (`server/src/db/boot.ts`), and a
# `user_version` the build does not understand is `SCHEMA_FUTURE` — the older image refuses to boot.
# Putting the previous image back on a migrated volume is therefore how a deploy turns a degraded
# site into a crash loop (BOOK-217: a v30 volume left behind, two v29 containers looping, prod 502).
#
# One rule, four outcomes, and every failed run that reached `up` says which one it is in exactly one
# line. Both runtimes call these two functions, so the sentence a human reads cannot depend on which
# driver ran the release.
#
# The fact is TRI-state: `1` the volume moved, `0` it did not, and `unknown` — a read that failed —
# which is neither. `unknown` must not fall through to `image-rollback`: an image swap on a volume
# that may have migrated is the crash loop, and a dump restore on a volume that may not have is an
# old copy written over the live book. It is its own outcome (`none`): nothing is swapped, nothing is
# restored, and a human looks.

# (migrated 1|0|unknown, serving 0|1) -> roll-forward | dump-restore | image-rollback | none.
# `serving` is the failed attempt's own verdict (`HEALTH` was fast|late): a new image that answers is
# alive. Anything other than `1`/`0` is an unknown fact, including an empty value.
recovery_choice() {
  case "${1:-unknown}" in
    1)
      if [ "${2:-0}" = "1" ]; then printf 'roll-forward'; else printf 'dump-restore'; fi ;;
    0) printf 'image-rollback' ;;
    *) printf 'none' ;;
  esac
}

# (choice, detail) -> the one `recovery:` line. The sentences are fixed: an operator (and the audit)
# matches on them, and `detail` is the fact they are decided from (the migration, its absence, or the
# reason it could not be read).
recovery_line() {
  case "${1:-}" in
    roll-forward)
      printf 'recovery: roll-forward — a migration ran (%s), so the previous image is NOT put back; the new image keeps serving (degraded, alive)\n' "${2:-unknown}" ;;
    dump-restore)
      printf 'recovery: dump-restore — a migration ran (%s) and the new image does not serve, so the pre-deploy dump was restored over book.db and the previous image runs\n' "${2:-unknown}" ;;
    image-rollback)
      printf 'recovery: image-rollback — no migration ran (%s), so the previous image is restored on the same schema\n' "${2:-unknown}" ;;
    none)
      printf 'recovery: none — %s; nothing was rolled back and nothing was restored, a human must look\n' "${2:-unknown}" ;;
    *) return 1 ;;
  esac
}

# --- the box ------------------------------------------------------------------------------------

# The load the guard needs, parsed here instead of through a helper: `sysctl -n vm.loadavg` prints
# `{ 34.09 47.37 44.40 }`, and a number that is there must not be reported as `unknown`. `uptime`
# is the fallback (Linux has no `sysctl -n vm.loadavg`), and only when both fail is the answer
# `unavailable`, with sysctl's own first line as the reason.
load_read() { # (max_per_core) -> LOAD_L1, LOAD_CORES, LOAD_PER_CORE, LOAD_ABOVE, LOAD_SOURCE, LOAD_MSG
  local raw cores
  LOAD_L1=""; LOAD_CORES=""; LOAD_PER_CORE=""; LOAD_ABOVE=0; LOAD_SOURCE=""; LOAD_MSG=""
  if raw="$(sysctl -n vm.loadavg 2>&1)"; then
    LOAD_L1="$(printf '%s' "$raw" | tr -d '{}' | tr ',' ' ' | awk '{print $1}')"
    if [ -n "$LOAD_L1" ]; then LOAD_SOURCE="sysctl"; fi
  else
    LOAD_MSG="$(printf '%s\n' "$raw" | head -n 1)"
  fi
  if [ -z "$LOAD_L1" ]; then
    if raw="$(uptime 2>&1)"; then
      LOAD_L1="$(printf '%s\n' "$raw" | sed -n 's/.*load average[s]*: *\([0-9][0-9.]*\).*/\1/p')"
      if [ -n "$LOAD_L1" ]; then LOAD_SOURCE="uptime"; fi
    elif [ -z "$LOAD_MSG" ]; then
      LOAD_MSG="$(printf '%s\n' "$raw" | head -n 1)"
    fi
  fi
  if cores="$(sysctl -n hw.ncpu 2>/dev/null)"; then
    LOAD_CORES="$cores"
  elif cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null)"; then
    LOAD_CORES="$cores"
  fi
  [ -n "$LOAD_CORES" ] || LOAD_CORES="unknown"
  if [ -z "$LOAD_L1" ]; then
    LOAD_L1="unavailable"
    LOAD_PER_CORE="unavailable"
    LOAD_MSG="${LOAD_MSG:-sysctl: no answer}"
    return 0
  fi
  if [ "$LOAD_CORES" = "unknown" ]; then
    LOAD_PER_CORE="unknown"
  else
    LOAD_PER_CORE="$(LC_ALL=C awk -v l="$LOAD_L1" -v c="$LOAD_CORES" 'BEGIN { if (c + 0 > 0) printf "%.2f", l / c; else printf "unknown" }')"
  fi
  LOAD_ABOVE="$(LC_ALL=C awk -v p="$LOAD_PER_CORE" -v m="${1:-2}" 'BEGIN { printf "%d", (p == "unknown" ? 0 : (p + 0 > m + 0 ? 1 : 0)) }')"
}

# --- the service --------------------------------------------------------------------------------

# `launchctl kickstart -k`, and the recovery a stopped service needs: when the job is not loaded
# (`Could not find service`, `Bad request`) the deploy bootstraps it from its own plist and tries
# once more. A service that was stopped is still deployable; `KICKSTART_RECOVERED=bootstrap` says
# which path it took. Returns 0 only when the job was signalled (or bootstrapped and signalled).
service_kickstart() { # (label, plist)
  local label="$1" plist="${2:-}" out status first
  KICKSTART_RECOVERED=""
  window_say "restarting $label"
  status=0
  out="$(launchctl kickstart -k "gui/$(id -u)/$label" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then return 0; fi
  first="$(printf '%s\n' "$out" | head -n 1)"
  window_say "kickstart: exit $status — ${first:-no output}"
  if [ -z "$plist" ] || [ ! -f "$plist" ]; then
    window_say "kickstart: no plist at '${plist}' to bootstrap from — the job was not signalled"
    return 1
  fi
  window_say "kickstart: not loaded — bootstrapped from $plist"
  status=0
  out="$(launchctl bootstrap "gui/$(id -u)" "$plist" 2>&1)" || status=$?
  if [ "$status" -ne 0 ]; then
    window_say "kickstart: bootstrap failed (exit $status) — $(printf '%s\n' "$out" | head -n 1)"
    return 1
  fi
  status=0
  out="$(launchctl kickstart -k "gui/$(id -u)/$label" 2>&1)" || status=$?
  if [ "$status" -ne 0 ]; then
    window_say "kickstart: still failing after the bootstrap (exit $status) — $(printf '%s\n' "$out" | head -n 1)"
    return 1
  fi
  KICKSTART_RECOVERED="bootstrap"
  return 0
}

# --- one deploy at a time -----------------------------------------------------------------------
#
# Everything a test needs to drive this block without a clock or a real pid is injected here:
# `BOOK_NOW` pins the clock, `BOOK_KILL` replaces `kill -0` (liveness), `BOOK_SLEEP` replaces the
# settle. A deploy sets none of them and gets the box.

lock_holder() { cat "$LOCK_DIR/pid" 2>/dev/null || true; }

lock_age() { # (since_epoch_s) -> seconds, 0 when the clock or the stamp cannot be read
  local now since
  now="$(now_s)"
  since="${1:-}"
  if is_number "$now" && is_number "$since" && [ "$now" -ge "$since" ]; then
    printf '%s' "$(( now - since ))"
    return 0
  fi
  printf '0'
}

# The settle a collided takeover takes before it reads the lock again. `BOOK_SLEEP` makes a scenario
# instant; a settle that fails is one fast retry, never an exit.
lock_sleep() { "${BOOK_SLEEP:-sleep}" "${1:-0}" || true; }

# Who holds the lock, in one line, read-only: a dry run says this without taking anything.
lock_report() {
  local holder since
  if [ ! -d "$LOCK_DIR" ]; then
    printf 'free'
    return 0
  fi
  holder="$(lock_holder)"
  since="$(cat "$LOCK_DIR/since" 2>/dev/null || true)"
  printf 'held by pid %s since %s (%ss old, stale after %ss)' "${holder:-unknown}" "${since:-unknown}" "$(lock_age "$since")" "$LOCK_STALE_S"
}

# What the lock directory says right now: the holder's pid, its start stamp and its age. A missing
# directory leaves all three empty (age 0).
lock_read() {
  LOCK_HOLDER="$(lock_holder)"
  LOCK_SINCE="$(cat "$LOCK_DIR/since" 2>/dev/null || true)"
  LOCK_AGE="$(lock_age "$LOCK_SINCE")"
}

# A live holder whose lock is not stale: the only honest reason to say another deploy is running.
lock_held_live() {
  is_number "${LOCK_HOLDER:-}" && pid_alive "$LOCK_HOLDER" && [ "${LOCK_AGE:-0}" -lt "$LOCK_STALE_S" ]
}

# May this lock be replaced? A readable pid that is dead, or an age past the stale limit — the age
# is what collects a lock nobody can name (`pid unknown` must not block deploys forever) while a
# fresh lock with no readable pid is still somebody's.
lock_collectable() {
  if is_number "${LOCK_HOLDER:-}" && ! pid_alive "$LOCK_HOLDER"; then return 0; fi
  [ "${LOCK_AGE:-0}" -ge "$LOCK_STALE_S" ]
}

# This run owns a directory it has just created: sign it.
lock_write() {
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  now_s > "$LOCK_DIR/since"
  LOCK_OWNED=1
  window_say "lock: ${LOCK} (pid $$, ${LOCK_DIR})"
}

# One takeover attempt. `mv` of a directory succeeds for exactly one caller, so this is the atomic
# step: the winner verifies that what it moved is the directory it judged collectable — the same
# pid when it had one, still stale by age when it had none — removes it and creates its own. A
# failed move, or a directory that changed hands in between, is a lost race, never a refusal.
lock_take_over() { # (pid_judged_collectable)
  local judged="${1:-}" stale="${LOCK_DIR}.stale.$$" moved_pid moved_age
  if [ -z "$judged" ] && [ "${LOCK_AGE:-0}" -lt "$LOCK_STALE_S" ]; then return 1; fi
  mv "$LOCK_DIR" "$stale" 2>/dev/null || return 1
  moved_pid="$(cat "$stale/pid" 2>/dev/null || true)"
  moved_age="$(lock_age "$(cat "$stale/since" 2>/dev/null || true)")"
  if [ -n "$judged" ]; then
    if [ "$moved_pid" != "$judged" ]; then lock_give_back "$stale" "$moved_pid"; return 1; fi
  elif [ "$moved_age" -lt "$LOCK_STALE_S" ]; then
    lock_give_back "$stale" "$moved_pid"; return 1
  fi
  rm -rf "$stale"
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  return 0
}

# A directory taken over that turned out not to be the one judged stale: put it back when the path
# is free (it may be a live deploy's), and never delete what may be somebody's lock.
lock_give_back() { # (moved_dir, moved_pid)
  if ! mv "$1" "$LOCK_DIR" 2>/dev/null; then
    window_say "lock: a directory taken over at $LOCK_DIR could not be given back (pid ${2:-not readable}); it stays at $1"
  fi
}

lock_refuse() { # (reason)
  printf '%s deploy: FAILED: %s — refused with exit 3; nothing was checked out, built, published or restarted\n' \
    "$(window_stamp)" "$1" >&2
  exit 3
}

lock_refuse_held() {
  lock_refuse "another deploy is running: pid ${LOCK_HOLDER} since ${LOCK_SINCE:-unknown} (age ${LOCK_AGE}s, lock ${LOCK_DIR})"
}

# Take the lock, or refuse with exit 3. Exit 3 is the interface: the driver must not read it as a
# red product deploy — by the time it is printed nothing has been checked out, built, published or
# restarted (the lock is taken before the fetch and before the checkout). A collectable lock is
# replaced by moving it aside first, so two runs cannot both "take over" one directory. A takeover
# that loses its race is re-read once after `BOOK_LOCK_RETRY_S`: a refusal names the holder that is
# really there (or says a taker is starting), never "pid unknown" on a lock nobody holds.
lock_acquire() {
  mkdir -p "$STATE_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK="held"
    lock_write
    return 0
  fi
  lock_read
  if lock_held_live; then lock_refuse_held; fi
  if lock_collectable && lock_take_over "${LOCK_HOLDER}"; then
    LOCK="taken-over"
    window_say "lock: taking over a stale lock — pid ${LOCK_HOLDER:-none}, since ${LOCK_SINCE:-unknown}, age ${LOCK_AGE}s (limit ${LOCK_STALE_S}s)"
    lock_write
    return 0
  fi
  # Undecided: a taker may be writing its pid right now, or the directory changed hands. One
  # settle, one re-read.
  lock_sleep "$LOCK_RETRY_S"
  lock_read
  if lock_held_live; then lock_refuse_held; fi
  if lock_collectable && lock_take_over "${LOCK_HOLDER}"; then
    LOCK="taken-over"
    window_say "lock: taking over a stale lock (after a ${LOCK_RETRY_S}s settle) — pid ${LOCK_HOLDER:-none}, age ${LOCK_AGE}s"
    lock_write
    return 0
  fi
  if [ ! -d "$LOCK_DIR" ] && mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK="held"
    lock_write
    return 0
  fi
  if ! is_number "${LOCK_HOLDER:-}"; then
    lock_refuse "another deploy is starting: the lock at $LOCK_DIR has no readable pid (${LOCK_HOLDER:+found '$LOCK_HOLDER', }since ${LOCK_SINCE:-unknown}, age ${LOCK_AGE}s of the ${LOCK_STALE_S}s stale limit)"
  fi
  lock_refuse "another deploy is taking the lock at $LOCK_DIR over right now (pid $LOCK_HOLDER)"
}

# The run phase is a re-exec of the same pid (`exec` keeps it), so the lock taken in `prepare` is
# still this deploy's: re-assert it instead of refusing ourselves. Entered directly
# (`--phase run`), there is no lock to inherit and one is taken.
lock_resume() {
  if [ "$(lock_holder)" = "$$" ]; then
    if [ -n "${BOOK_LOCK_FROM_PREPARE:-}" ]; then LOCK="$BOOK_LOCK_FROM_PREPARE"; fi
    LOCK_OWNED=1
    window_say "lock: kept from the prepare phase — ${LOCK} (pid $$)"
    return 0
  fi
  lock_acquire
}

# Release only what this process owns: a refused run must never delete the holder's lock.
lock_release() {
  if [ "$LOCK_OWNED" != "1" ]; then return 0; fi
  if [ "$(lock_holder)" = "$$" ]; then rm -rf "$LOCK_DIR"; fi
  LOCK_OWNED=0
  window_say "lock: released"
}

# --- the reason a run died ----------------------------------------------------------------------
#
# A deploy that dies must say why in one line and leave an audit line. The 00:36 run of a492d1a
# ended with `lock: released` and nothing else: the window called a probe that returned non-zero
# and `set -e` took the process down before any verdict. `deploy.sh` now sets STEP before every
# stage, sets REASON_PRINTED in `die()`, AUDIT_WRITTEN in `audit()`, and installs these two traps.

# The numbers every failure line and every `failed` audit line carries.
fail_state() {
  printf 'health=%s health_ms=%s budget_ms=%s baseline=%s release=%s' \
    "${HEALTH:-none}" "${HEALTH_MS:-0}" "${BUDGET_MS:-0}" "${BASELINE:-unknown}" "${RELEASE:-none}"
}

# ERR: one line, once, naming the step, the command and the line it died on.
fail_on_err() { # (line, command) — passed by the trap, because `LINENO` inside a function is not it
  local status=$? line="${1:-?}" cause="${2:-unknown}"
  if [ "${REASON_PRINTED:-0}" = "1" ]; then return 0; fi
  REASON_PRINTED=1
  FAILED_CAUSE="$cause"
  window_say "FAILED at ${STEP:-start}: ${cause} (line ${line}) — $(fail_state); nothing further will be restarted"
  return 0
}

# EXIT: a red run never ends with `lock: released` alone. When nothing above explained the status,
# say so, and write the one audit line the run owes.
fail_on_exit() {
  local status=$?
  if [ "${status}" -eq 0 ] || [ "${status}" -eq 3 ]; then return 0; fi
  if [ "${REASON_PRINTED:-0}" != "1" ]; then
    REASON_PRINTED=1
    window_say "FAILED at ${STEP:-start}: no reason recorded — $(fail_state); nothing further will be restarted"
  fi
  if [ "${AUDIT_WRITTEN:-0}" != "1" ] && declare -F audit >/dev/null 2>&1; then
    audit "failed mode=${MODE:-unknown} ref=${REF:-unknown} sha=${GOOD:-unknown} step=${STEP:-start} health=${HEALTH:-none} restart_ms=${RESTART_MS:-unknown} budget_ms=${BUDGET_MS:-0} baseline=${BASELINE:-unknown} release=${RELEASE:-none} cause=${FAILED_CAUSE:-unknown}"
    AUDIT_WRITTEN=1
  fi
  return 0
}
