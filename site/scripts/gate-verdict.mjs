#!/usr/bin/env node
/**
 * scripts/gate-verdict.mjs — the single check `main` is protected by (BOOK-198).
 *
 * The job used to be one `gate`; it is now six (`changes`, `static`, `tests`, `coverage`,
 * `affected`, `build`) and branch protection still requires exactly one name: `gate`. This script
 * is what turns the other six into that one verdict, so a failed, cancelled or timed-out job can
 * never be mistaken for a pass. GitHub's `needs` object already resolves matrix shards: `tests` is
 * `failure` when any shard failed, `skipped` when the `if:` said so.
 *
 * The rule, per mode:
 *   full      (push to `main`, or a gate-infrastructure PR) — `tests` and `coverage` must be
 *             `success`; `affected` is skipped by design and that is fine.
 *   affected  (a PR that touches only product code) — `affected` must be `success`; `tests` and
 *             `coverage` are skipped by design and that is fine.
 * In both modes `changes`, `static` and `build` must succeed, and nothing may be cancelled.
 * A required job that is `skipped` is a failure: skipping is how a job disappears, not a pass.
 *
 *   NEEDS='{"changes":{"result":"success","outputs":{"mode":"full"}},…}' EVENT=push \
 *     node scripts/gate-verdict.mjs
 *
 * Exit code 0 is the verdict `gate` shows green on; anything else is red.
 */

import { resolve } from 'node:path';

/** Fixed order, so the printed table reads the same on every run. */
const JOBS = ['changes', 'static', 'tests', 'coverage', 'affected', 'build'];

/** What each mode has to prove. Everything else is allowed to be skipped, never to fail. */
const REQUIRED = {
  full: ['changes', 'static', 'tests', 'coverage', 'build'],
  affected: ['changes', 'static', 'affected', 'build'],
};

/** The only results that do not already mean "this run is red". */
const TOLERATED = new Set(['success', 'skipped']);

/**
 * Decide the gate from GitHub's `needs` object and the event name.
 *
 * @param {Record<string, { result?: string, outputs?: Record<string, string> }>} needs
 * @param {string} event `github.event_name`
 * @returns {{ ok: boolean, mode: 'full' | 'affected', rows: Array<{ job: string, result: string, required: boolean, ok: boolean }>, reasons: string[] }}
 */
export function verdict(needs, event) {
  const bundle = needs !== null && typeof needs === 'object' ? needs : {};
  const isPullRequest = event === 'pull_request';
  const declared = bundle.changes?.outputs?.mode;
  const reasons = [];

  // On a push the mode is fixed: `main` gets the whole suite. On a PR the `changes` job decides.
  // Anything other than an explicit `affected` from a PR means the full set — the safe direction.
  const mode = isPullRequest && declared === 'affected' ? 'affected' : 'full';
  if (isPullRequest && declared !== 'full' && declared !== 'affected') {
    reasons.push(`changes reported mode ${JSON.stringify(declared ?? null)}; expected "full" or "affected"`);
  }

  const required = new Set(REQUIRED[mode]);
  const rows = JOBS.map((job) => {
    const result = typeof bundle[job]?.result === 'string' ? bundle[job].result : 'missing';
    const isRequired = required.has(job);
    let ok = TOLERATED.has(result);
    if (ok && result === 'skipped' && isRequired) ok = false;
    if (!ok) {
      reasons.push(
        result === 'skipped'
          ? `${job} was skipped, but ${mode} mode requires it`
          : `${job} is ${result}${isRequired ? ' (required)' : ''}`,
      );
    }
    return { job, result, required: isRequired, ok };
  });

  return { ok: reasons.length === 0, mode, rows, reasons };
}

function print(decision, event) {
  process.stdout.write(`gate verdict — event: ${event || 'unknown'}, mode: ${decision.mode}\n`);
  for (const row of decision.rows) {
    process.stdout.write(`  ${row.job.padEnd(9)} ${row.result.padEnd(9)} ${row.required ? 'required' : 'optional'}\n`);
  }
}

function main() {
  const event = process.env.EVENT ?? '';
  let needs;
  try {
    needs = JSON.parse(process.env.NEEDS ?? '');
  } catch {
    process.stderr.write('gate: NEEDS is not the JSON of `toJSON(needs)` — cannot decide\n');
    return 1;
  }
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    process.stderr.write('gate: NEEDS must be an object keyed by job id\n');
    return 1;
  }

  const decision = verdict(needs, event);
  print(decision, event);
  if (decision.ok) {
    process.stdout.write('verdict: PASS — every job this mode requires succeeded\n');
    return 0;
  }
  for (const reason of decision.reasons) process.stdout.write(`verdict: FAIL — ${reason}\n`);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename);
if (invokedDirectly) process.exit(main());
