/**
 * scripts/lib/orphans.mjs — BOOK-81: which test processes have no live parent.
 *
 * `vitest run` under the default forks pool leaves `node (vitest N)` workers behind when its
 * own process is killed (an agent timeout does `kill -9`): 18 were counted, 36–760 MB each.
 * `pool: 'threads'` (vitest.config.ts) removed that failure mode, and this module answers the
 * question left to the machine: after a run, does anything still hold a suite?
 *
 * The judgement is the parent link and nothing else — no CPU or age threshold, so a busy
 * worker of somebody's live suite is never a candidate. `ps` prints the title vitest sets, and
 * `readTable` is a plain parse of that text, so a test can hand it a table instead of a host.
 *
 * What the titles are is assumed, so the shapes are named: a worker is `node (vitest 3)`, a
 * main is `node (vitest)` (or the same process started by path, `node …/vitest.mjs run`). A
 * process wearing a `node (…)` title that names vitest in any other shape is `unrecognised` —
 * a host that retitles its workers must not be reported as clean just because no known title
 * matched.
 */

/** The pool's worker title; the main process keeps the bare `node (vitest)`. */
const WORKER = /^node \(vitest \d+\)$/u;
const MAIN = /^node \(vitest\)$/u;
/** A live parent of a worker: `node (vitest)` or `node …/vitest.mjs run`. */
const VITEST_PARENT = /(?:^node \(vitest\)$|vitest\.mjs)/u;
/** One `ps -eo pid=,ppid=,rss=,etime=,command=` row: numbers, then a title that may hold spaces. */
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u;
/** A title (`node (…)`) that names vitest — the shape a pool worker wears, known or not. */
const TITLED = /^node \([^)]*vitest/u;

/** pid → process, from the text `ps` prints. Rows of another shape are skipped, not guessed. */
export function readTable(text) {
  const processes = new Map();
  for (const line of text.split('\n')) {
    const match = ROW.exec(line);
    if (match === null) continue;
    processes.set(Number(match[1]), {
      ppid: Number(match[2]),
      rss: Number(match[3]),
      etime: match[4],
      command: match[5].trim(),
    });
  }
  return processes;
}

/**
 * The vitest processes in the table, each marked `live` or not. A worker is live only while its
 * parent is a vitest process (a subreaper reparents a dead main's children somewhere other than
 * 1, so the parent's *identity* is asked, not just the number); the bare main is live while its
 * parent is anything but 1.
 */
export function testProcesses(text) {
  const processes = readTable(text);
  const found = [];
  for (const [pid, entry] of processes) {
    const worker = WORKER.test(entry.command);
    if (!worker && !MAIN.test(entry.command)) continue;
    const parent = processes.get(entry.ppid);
    const live = worker ? parent !== undefined && VITEST_PARENT.test(parent.command) : entry.ppid !== 1;
    found.push({ pid, ppid: entry.ppid, mb: Math.round(entry.rss / 1024), etime: entry.etime, live });
  }
  return found.sort((left, right) => left.pid - right.pid);
}

/**
 * Node processes wearing a vitest title that is none of the shapes above: a retitled worker on
 * another host, a wrapper this check has not seen. Not a judgement — a reason to stop calling the
 * machine clean, because the table can no longer be read as evidence of anything. A title that
 * drops the word "vitest" altogether is invisible here; no check can name what it cannot see.
 */
export function unrecognised(text) {
  const found = [];
  for (const [pid, entry] of readTable(text)) {
    if (!TITLED.test(entry.command)) continue;
    if (WORKER.test(entry.command) || MAIN.test(entry.command)) continue;
    found.push({ pid, command: entry.command });
  }
  return found.sort((left, right) => left.pid - right.pid);
}
