#!/usr/bin/env node
/**
 * scripts/restart-probe.mjs — BOOK-119: the restart window, measured instead of guessed.
 *
 * `deploy.sh` used to poll `/healthz` once every two seconds with a hard 60 s budget, and on a
 * box at load 40 that turned a healthy slow boot into a red deploy — which then rebuilt the
 * *same* commit and restarted a second time. The owner's log (`BOOK-119` #3711) is the defect:
 * the control flow invented a window it existed to remove.
 *
 * So the measurement lives here, where it is testable without a shell:
 *
 *   baseline  one probe, `probe=up|down status=N ms=N at=<epoch ms>` — "was the site up the
 *             moment before the restart, and when did it last answer?" (`at=0` when down).
 *   wait      poll `/healthz` every 200 ms from `--since` (the instant before `kickstart`)
 *             within `--budget-ms`; on timeout re-check for `--grace-ms`. `health=fast` when a
 *             200 carrying the expected `commit` arrives inside the budget, `late` when it
 *             arrives inside the grace, `stale` when the answer names the **previous** build
 *             (the new code never served — a real failure), `fail` otherwise. `first_at` is
 *             that answer's own moment, so the caller can subtract the baseline and print the
 *             **visible downtime** instead of a copy of its own polling window.
 *   load      `sysctl -n vm.loadavg` + `hw.ncpu` as `load=<l1> cores=<n> per_core=<x.xx>
 *             above=<0|1>`; the caller decides what to say and how long to wait.
 *
 * Exit codes: 0 healthy (baseline up, fast or late with matching identity, load always),
 * 1 not healthy or identity mismatch, 2 usage. Every line on stdout is a single `key=value`
 * token, so bash can read it with `sed -n 's/^health=//p'` and nothing else.
 *
 * Resolution is one poll (200 ms) plus the request's own latency, and the log says so.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const POLL_MS = 200;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_GRACE_MS = 60_000;
export const DEFAULT_MAX_PER_CORE = 2;
/** One attempt's own ceiling: a hung socket is not a slow boot. */
export const ATTEMPT_TIMEOUT_MS = 1_000;

/**
 * One `/healthz` attempt. Never throws: "the process is not answering" is an answer, and the
 * caller's loop is the policy. `at` is taken before reading the body, so the timestamp is the
 * 200's own moment, not the parse's.
 */
export async function probe(url, { timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* a 200 with a body that is not JSON is not a healthz answer */
    }
    return { status: response.status, body, at: Date.now(), ms: Date.now() - started };
  } catch {
    return { status: 0, body: null, at: Date.now(), ms: Date.now() - started };
  }
}

/** `/healthz` healthy = 200 and `ok:true`; the route writes `ok` first on purpose. */
export function healthy(result) {
  return result.status === 200 && result.body !== null && result.body.ok === true;
}

/** The identity the process reports, or `null`. */
export function commitOf(result) {
  const commit = result.body?.commit;
  return typeof commit === 'string' && commit.length > 0 ? commit : null;
}

/**
 * Identity match that tolerates abbreviation: `/healthz` reports the build's short sha, the
 * deploy knows the full one. A prefix in either direction is the same commit.
 */
export function sameCommit(reported, expected) {
  if (reported === null || expected === null || expected.length === 0) return false;
  return reported === expected || expected.startsWith(reported) || reported.startsWith(expected);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll from `since` (the instant before the restart) until a 200 with the expected commit, the
 * budget ends, the grace ends, or the previous build answers instead. The grace is only entered
 * after the budget: it is the second look that turns "slow" into a fact instead of a rollback.
 */
export async function waitForHealth({
  url,
  since = Date.now(),
  budgetMs = DEFAULT_TIMEOUT_MS,
  graceMs = DEFAULT_GRACE_MS,
  expectCommit = null,
  prevCommit = null,
  pollMs = POLL_MS,
  sleep = defaultSleep,
  now = Date.now,
}) {
  let polls = 0;
  let last = null;
  const settle = (health, result) => ({
    health,
    ms: Math.max(0, (result === null ? now() : result.at) - since),
    polls,
    commit: result === null ? null : commitOf(result),
    // The answer's own moment: `restart_ms` is this minus the baseline, never `ms` above.
    at: result === null ? 0 : result.at,
  });

  const budgetEnd = since + budgetMs;
  while (now() < budgetEnd) {
    last = await probe(url);
    polls += 1;
    if (healthy(last) && sameCommit(commitOf(last), expectCommit)) return settle('fast', last);
    await sleep(pollMs);
  }

  const graceEnd = budgetEnd + graceMs;
  while (now() < graceEnd) {
    last = await probe(url);
    polls += 1;
    if (healthy(last) && sameCommit(commitOf(last), expectCommit)) return settle('late', last);
    if (healthy(last) && sameCommit(commitOf(last), prevCommit)) return settle('stale', last);
    await sleep(pollMs);
  }

  if (healthy(last) && sameCommit(commitOf(last), prevCommit)) return settle('stale', last);
  // `fail` reports the time the deploy actually spent looking, not the last answer's stamp:
  // the log line "did not answer after X ms" is a statement about the window. No 200 arrived,
  // so there is no `first_at`: the caller prints `restart_ms=unknown`.
  return {
    health: 'fail',
    ms: Math.max(0, now() - since),
    polls,
    commit: last === null ? null : commitOf(last),
    at: 0,
  };
}

/** `{ 1.84 2.05 2.10 }` → `1.84`; `null` when the text is not a load average. */
export function parseLoadavg(text) {
  const match = /\{?\s*(\d+(?:\.\d+)?)/u.exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * The box's own load, as the guard needs it: one-minute average, core count, and their ratio.
 * A platform without `sysctl` (the Docker image, Linux CI) reports `null` — no numbers is not
 * a failure, and the caller says `load=unknown` rather than pretending.
 */
export function readLoad({ exec = execFileSync } = {}) {
  try {
    const text = String(exec('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }));
    const cores = Number(String(exec('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8' })).trim());
    const load = parseLoadavg(text);
    if (load === null || !Number.isFinite(cores) || cores <= 0) return { load: null, cores: null, perCore: null };
    return { load, cores, perCore: load / cores };
  } catch {
    return { load: null, cores: null, perCore: null };
  }
}

/** The one printed line of `load`: `key=value` tokens, `above` already decided for bash. */
export function loadReport(load, maxPerCore = DEFAULT_MAX_PER_CORE) {
  if (load.load === null || load.cores === null || load.perCore === null) {
    return 'load=unknown cores=unknown per_core=unknown above=0';
  }
  return `load=${load.load.toFixed(2)} cores=${load.cores} per_core=${load.perCore.toFixed(2)} above=${load.perCore > maxPerCore ? 1 : 0}`;
}

// --- CLI ---------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/restart-probe.mjs <baseline|wait|load> [options]

  baseline --url URL
  wait     --url URL [--since EPOCH_MS] [--budget-ms N] [--grace-ms N]
           [--expect-commit SHA] [--prev-commit SHA]
  load     [--max-per-core X]`;

class UsageError extends Error {}

function flags(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith('--')) throw new UsageError(`unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    parsed[flag.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function number(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${name} must be a non-negative number, got ${value}`);
  return parsed;
}

export async function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'baseline') {
    const options = flags(rest);
    if (options.url === undefined) throw new UsageError('baseline needs --url');
    const result = await probe(options.url);
    console.log(`probe=${healthy(result) ? 'up' : 'down'} status=${result.status} ms=${result.ms} at=${healthy(result) ? result.at : 0}`);
    return healthy(result) ? 0 : 1;
  }

  if (mode === 'wait') {
    const options = flags(rest);
    if (options.url === undefined) throw new UsageError('wait needs --url');
    const since = number(options.since, Date.now(), 'since') || Date.now();
    const result = await waitForHealth({
      url: options.url,
      since,
      budgetMs: number(options['budget-ms'], DEFAULT_TIMEOUT_MS, 'budget-ms'),
      graceMs: number(options['grace-ms'], DEFAULT_GRACE_MS, 'grace-ms'),
      expectCommit: options['expect-commit'] ?? null,
      prevCommit: options['prev-commit'] ?? null,
    });
    console.log(`health=${result.health}`);
    console.log(`health_ms=${result.ms}`);
    console.log(`polls=${result.polls}`);
    console.log(`commit=${result.commit ?? 'unknown'}`);
    console.log(`first_at=${result.at}`);
    return result.health === 'fast' || result.health === 'late' ? 0 : 1;
  }

  if (mode === 'load') {
    const options = flags(rest);
    console.log(loadReport(readLoad(), number(options['max-per-core'], DEFAULT_MAX_PER_CORE, 'max-per-core')));
    return 0;
  }

  throw new UsageError(mode === undefined ? 'no mode' : `unknown mode: ${mode}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`restart-probe: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof UsageError) console.error(USAGE);
      process.exitCode = 2;
    },
  );
}
