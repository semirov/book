#!/bin/bash
# watchdog.sh — the resource guard on the Mac mini (BOOK-74). launchd runs it every 5 minutes
# as `dev.book-watchdog`; it is not a service anyone restarts by hand.
#
# Why it exists: eight orphaned `yes` processes ran for twelve days at 96% CPU each and were
# found by a person who noticed the fan. Nothing watched. This watches.
#
# Every run appends one line to ~/Library/Logs/book-watchdog.log (load, free memory, disk free,
# RSS of dev.book-site and dev.book-engine, orphans) and writes the same line to
# ~/.local/state/book-watchdog/status. `launchctl list | grep dev.book-watchdog` shows the last
# exit status, and that status is the alarm: 0 = fine, 1 = warning, 2 = critical (something was
# killed, a service is down, or the disk is nearly full).
#
# It kills a process tree only when all of these hold — the exact class that was missed:
#   * parent is 1 (orphaned: whatever started it is gone),
#   * it is not a launchd job (launchd-managed work, this script included, is never touched),
#   * it runs as our uid (never another user's or root's process),
#   * it burns >= BOOK_WD_CPU_HARD (90%) of a core, or holds >= BOOK_WD_RSS_HARD_MB (3072 MiB),
#   * for BOOK_WD_SUSTAIN consecutive runs (3 x 5 min) and at least BOOK_WD_MIN_AGE (600 s) of
#     life — a build that spikes for a minute is not a runaway.
# TERM to the tree, 5 s, then KILL. Thresholds are env-overridable (the log line records the ones
# in force), so tuning is a plist edit, not a script edit.
#
# Install: cp site/deploy/watchdog.sh ~/.local/share/book-watchdog/watchdog.sh
#          cp site/deploy/dev.book-watchdog.plist ~/Library/LaunchAgents/
#          launchctl bootout gui/$(id -u)/dev.book-watchdog 2>/dev/null
#          launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.book-watchdog.plist
# The installed copy is deliberate: the guard must not disappear, or change mid-run, under a
# half-finished checkout of the repo. The repo file is the source; installing it is a cp.
set -u
export LC_ALL=C
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin

LOG="${HOME}/Library/Logs/book-watchdog.log"
STATE="${HOME}/.local/state/book-watchdog"
LOCK="${STATE}/run.lock"
STATUS="${STATE}/status"
STRIKES="${STATE}/strikes"
COUNTERS="${STATE}/counters"
WEEKLY_AT="${STATE}/weekly-at"
TMP="${STATE}/.tmp"
LOG_MAX_BYTES="${BOOK_WD_LOG_MAX_BYTES:-5000000}"

CPU_HARD="${BOOK_WD_CPU_HARD:-90}"          # % of one core, sustained
SUSTAIN="${BOOK_WD_SUSTAIN:-3}"             # consecutive 5-min samples
MIN_AGE="${BOOK_WD_MIN_AGE:-600}"           # seconds a process must have lived before a kill
RSS_WARN_MB="${BOOK_WD_RSS_WARN_MB:-1200}"  # our own service: warning only
RSS_HARD_MB="${BOOK_WD_RSS_HARD_MB:-3072}"  # orphan: kill threshold
LOAD_PER_CORE="${BOOK_WD_LOAD_PER_CORE:-1.5}"
MEM_WARN_PCT="${BOOK_WD_MEM_WARN_PCT:-10}"
DISK_WARN_GB="${BOOK_WD_DISK_WARN_GB:-20}"
DISK_CRIT_GB="${BOOK_WD_DISK_CRIT_GB:-5}"
WEEK="${BOOK_WD_WEEK_SECONDS:-604800}"
DENY="${BOOK_WD_DENY:-book-watchdog}"
ME="$(id -u)"
NOW="$(date +%s)"
ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$STATE" "$(dirname "$LOG")" || exit 0
rm -rf "$TMP"; mkdir -p "$TMP" || exit 0

# One run at a time; a wedged run must not block the guard forever.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rm -rf "$LOCK" "$TMP"' EXIT

if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" | tr -d ' ')" -gt "$LOG_MAX_BYTES" ]; then
  mv -f "$LOG" "${LOG}.1"
fi

log() { printf '%s %s\n' "$ISO" "$*" >>"$LOG"; }

warn=0; crit=0; notes=""
note() { notes="${notes}${notes:+,}$1"; }
flag() { if [ "$1" = crit ]; then crit=1; else warn=1; fi; }

# --- machine ---------------------------------------------------------------------------------
read -r LOAD1 LOAD5 LOAD15 <<EOF
$(sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1, $2, $3}')
EOF
CORES="$(sysctl -n hw.ncpu)"
PAGESIZE="$(sysctl -n hw.pagesize)"
MEM_TOTAL_MB=$(( $(sysctl -n hw.memsize) / 1048576 ))
MEM_FREE_MB="$(vm_stat | awk -v ps="$PAGESIZE" '
  /^Pages free:/        {v = $3; gsub(/[^0-9]/, "", v); f = v}
  /^Pages inactive:/    {v = $3; gsub(/[^0-9]/, "", v); i = v}
  /^Pages speculative:/ {v = $3; gsub(/[^0-9]/, "", v); s = v}
  END { printf "%d", (f + i + s) * ps / 1048576 }')"
[ -n "$MEM_FREE_MB" ] || MEM_FREE_MB=0
MEM_FREE_PCT=$(( MEM_TOTAL_MB > 0 ? MEM_FREE_MB * 100 / MEM_TOTAL_MB : 0 ))
DISK_FREE_GB=$(( $(df -k / | awk 'NR==2{print $4}') / 1048576 ))

# --- our services ----------------------------------------------------------------------------
service_pid() { launchctl list 2>/dev/null | awk -v l="$1" '$3 == l && $1 != "-" {print $1; exit}'; }
service_loaded() { launchctl list 2>/dev/null | awk -v l="$1" '$3 == l {found = 1} END {exit !found}'; }
rss_mb() { if [ -n "${1:-}" ]; then ps -o rss= -p "$1" 2>/dev/null | awk '{printf "%d", $1 / 1024}'; else echo 0; fi; }

SITE_PID="$(service_pid dev.book-site)"; SITE_RSS_MB="$(rss_mb "$SITE_PID")"; SITE_RSS_MB="${SITE_RSS_MB:-0}"
ENGINE_PID="$(service_pid dev.book-engine)"; ENGINE_RSS_MB="$(rss_mb "$ENGINE_PID")"; ENGINE_RSS_MB="${ENGINE_RSS_MB:-0}"

if service_loaded dev.book-site; then
  [ -n "$SITE_PID" ] || { note site_down; flag warn; }
else
  note site_unloaded
fi
[ "$SITE_RSS_MB" -ge "$RSS_WARN_MB" ] && { note "site_rss=${SITE_RSS_MB}MB"; flag warn; }
[ "$ENGINE_RSS_MB" -ge "$RSS_WARN_MB" ] && { note "engine_rss=${ENGINE_RSS_MB}MB"; flag warn; }
if awk -v l="$LOAD1" -v c="$CORES" -v k="$LOAD_PER_CORE" 'BEGIN{exit !(l > c * k)}'; then
  note "load=$LOAD1"; flag warn
fi
[ "$MEM_FREE_PCT" -lt "$MEM_WARN_PCT" ] && { note "mem_free=${MEM_FREE_PCT}%"; flag warn; }
[ "$DISK_FREE_GB" -lt "$DISK_WARN_GB" ] && { note "disk=${DISK_FREE_GB}GB"; flag warn; }
[ "$DISK_FREE_GB" -lt "$DISK_CRIT_GB" ] && { note "disk_critical=${DISK_FREE_GB}GB"; flag crit; }

# --- orphans: parent 1, not a launchd job, burning a core or the memory ----------------------
# CPU time is sampled twice and differenced: the wall gap is 2 s, so an old process that was
# once busy is not condemned for its past — only for what it is doing now, over and over.
ps -Ao pid=,ppid=,uid=,rss=,time=,comm= >"$TMP/snap1" 2>/dev/null
sleep 2
ps -Ao pid=,ppid=,uid=,rss=,time=,comm= >"$TMP/snap2" 2>/dev/null
launchctl list 2>/dev/null | awk '$1 != "-" {print $1}' | sort >"$TMP/launchd-pids"

awk -v me="$ME" -v cpu_hard="$CPU_HARD" -v rss_hard="$RSS_HARD_MB" -v deny="$DENY" \
    -v launchdpids="$TMP/launchd-pids" '
  function secs(t,   n, p) {                     # macOS ps time: [[hh:]mm:]ss
    n = split(t, p, ":")
    if (n == 1) return p[1] + 0
    if (n == 2) return p[1] * 60 + p[2]
    return p[1] * 3600 + p[2] * 60 + p[3]
  }
  BEGIN {
    while ((getline p < launchdpids) > 0) managed[p] = 1
    close(launchdpids)
  }
  NR == FNR {
    if ($2 == 1 && $3 == me && !($1 in managed)) {
      cmd = $6; for (i = 7; i <= NF; i++) cmd = cmd " " $i
      if (cmd ~ deny) next
      # macOS reparents its own XPC services, widgets and loginwindow to launchd; they are not
      # launchd *jobs*, so they are not in `launchctl list`, and they are not ours to kill.
      if ($6 ~ /^\/(System|Applications|usr\/libexec|sbin|usr\/sbin)\//) next
      pid[$1] = 1; t1[$1] = secs($5); rss[$1] = $4; comm[$1] = $6
    }
    next
  }
  FNR == 1 && NR != 1 { second = 1 }
  second && ($1 in pid) { t2[$1] = secs($5) }
  END {
    for (p in pid) {
      if (!(p in t2)) continue
      d = t2[p] - t1[p]; if (d < 0) d = 0
      cpu = d * 100 / 2
      hot = (cpu >= cpu_hard || rss[p] / 1024 >= rss_hard)
      # Every orphan of ours is reported (`mine`), hot or not: leaky test workers and stray
      # helpers are how the machine gets slow long before anything is over a kill threshold.
      printf "%s|%s|%s|%d|%.0f|%s\n", p, (hot ? "hot" : "cold"), (cpu >= cpu_hard ? "cpu" : "rss"), rss[p] / 1024, cpu, comm[p]
    }
  }' "$TMP/snap1" "$TMP/snap2" >"$TMP/orphans"

: >"$TMP/strikes"
KILLED=0
MINE="$(awk 'END{print NR+0}' "$TMP/orphans")"
ORPHAN_WARN="${BOOK_WD_ORPHAN_WARN:-25}"
[ "$MINE" -gt "$ORPHAN_WARN" ] && { note "orphans_mine=$MINE"; flag warn; }
while IFS='|' read -r pid heat kind rssv cpuv cmd; do
  [ -n "$pid" ] || continue
  [ "$heat" = "hot" ] || continue
  [ "$pid" = "$$" ] && continue
  first=""; strikes=0
  if [ -f "$STRIKES" ]; then
    first="$(awk -v p="$pid" '$1 == p {print $2; exit}' "$STRIKES")"
    strikes="$(awk -v p="$pid" '$1 == p {print $3; exit}' "$STRIKES")"
  fi
  strikes="${strikes:-0}"
  [ -n "$first" ] || first="$NOW"
  strikes=$(( strikes + 1 ))
  age=$(( NOW - first ))
  printf '%s %s %s %s\n' "$pid" "$first" "$strikes" "$cmd" >>"$TMP/strikes"

  if [ "$strikes" -lt "$SUSTAIN" ] || [ "$age" -lt "$MIN_AGE" ]; then
    note "orphan=$pid($kind,${strikes}/${SUSTAIN})"
    flag warn
    continue
  fi

  tree="$pid"; frontier="$pid"
  while [ -n "$frontier" ]; do
    next=""
    for p in $frontier; do
      next="$next $(awk -v pp="$p" '$2 == pp {printf "%s ", $1}' "$TMP/snap2")"
    done
    tree="$tree $next"; frontier="$next"
  done
  order="$(printf '%s\n' $tree | tail -r)"
  log "watchdog: kill orphan kind=$kind pid=$pid cpu=${cpuv}% rss=${rssv}MB age=${age}s tree=$(printf '%s\n' $tree | wc -l | tr -d ' ') comm=$cmd"
  for p in $order; do kill -TERM "$p" 2>/dev/null; done
  sleep 5
  for p in $order; do kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null; done
  KILLED=$(( KILLED + 1 ))
  note "killed=$pid($kind)"
  flag crit
done <"$TMP/orphans"
mv -f "$TMP/strikes" "$STRIKES" 2>/dev/null || : >"$STRIKES"
ORPHANS="$MINE"

# --- one line per run, one summary per week ---------------------------------------------------
STATUS_WORD=ok
[ "$warn" = 1 ] && STATUS_WORD=warn
[ "$crit" = 1 ] && STATUS_WORD=crit
LINE="run load=${LOAD1}/${LOAD5}/${LOAD15} cores=${CORES} mem_free_mb=${MEM_FREE_MB}(${MEM_FREE_PCT}%) disk_free_gb=${DISK_FREE_GB} site_pid=${SITE_PID:--} site_rss_mb=${SITE_RSS_MB} engine_pid=${ENGINE_PID:--} engine_rss_mb=${ENGINE_RSS_MB} orphans=${ORPHANS} thresholds=cpu>=${CPU_HARD}%x${SUSTAIN},rss>=${RSS_HARD_MB}MB status=${STATUS_WORD}${notes:+ notes=$notes}"
log "watchdog: $LINE"
printf '%s %s\n' "$ISO" "$LINE" >"$STATUS"

load_max=0; free_min=100; disk_min=999999; site_max=0; engine_max=0
runs=0; warns=0; kills=0; down=0
if [ -f "$COUNTERS" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      load_max) load_max="${v:-0}" ;;
      free_min) free_min="${v:-100}" ;;
      disk_min) disk_min="${v:-999999}" ;;
      site_max) site_max="${v:-0}" ;;
      engine_max) engine_max="${v:-0}" ;;
      runs) runs="${v:-0}" ;;
      warns) warns="${v:-0}" ;;
      kills) kills="${v:-0}" ;;
      down) down="${v:-0}" ;;
    esac
  done <"$COUNTERS"
fi
runs=$(( runs + 1 ))
[ "$STATUS_WORD" = ok ] || warns=$(( warns + 1 ))
kills=$(( kills + KILLED ))
[ -z "$SITE_PID" ] && down=$(( down + 1 ))
if awk -v a="$LOAD1" -v b="$load_max" 'BEGIN{exit !(a > b)}'; then load_max="$LOAD1"; fi
[ "$MEM_FREE_PCT" -lt "$free_min" ] && free_min="$MEM_FREE_PCT"
[ "$DISK_FREE_GB" -lt "$disk_min" ] && disk_min="$DISK_FREE_GB"
[ "$SITE_RSS_MB" -gt "$site_max" ] && site_max="$SITE_RSS_MB"
[ "$ENGINE_RSS_MB" -gt "$engine_max" ] && engine_max="$ENGINE_RSS_MB"
{
  echo "load_max=$load_max"; echo "free_min=$free_min"; echo "disk_min=$disk_min"
  echo "site_max=$site_max"; echo "engine_max=$engine_max"
  echo "runs=$runs"; echo "warns=$warns"; echo "kills=$kills"; echo "down=$down"
} >"$COUNTERS"

LAST_WEEKLY="$(cat "$WEEKLY_AT" 2>/dev/null || echo 0)"
if [ $(( NOW - LAST_WEEKLY )) -ge "$WEEK" ]; then
  log "watchdog: weekly_summary runs=$runs warnings=$warns kills=$kills max_load=$load_max min_mem_free=${free_min}% min_disk_free=${disk_min}GB max_site_rss=${site_max}MB max_engine_rss=${engine_max}MB site_down_samples=$down"
  echo "$NOW" >"$WEEKLY_AT"
  { echo "load_max=0"; echo "free_min=100"; echo "disk_min=999999"; echo "site_max=0"; echo "engine_max=0"
    echo "runs=0"; echo "warns=0"; echo "kills=0"; echo "down=0"; } >"$COUNTERS"
fi

[ "$crit" = 1 ] && exit 2
[ "$warn" = 1 ] && exit 1
exit 0
