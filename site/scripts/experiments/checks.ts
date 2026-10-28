/**
 * The dry run's own assertions (BOOK-DOC-65 §5–§6): the arithmetic a table would hide.
 *
 * `--dry` makes zero network calls, so it cannot check the model. It can and does check the
 * numbers the table is made of — the two price bases, the peak doubling, the block diff, the
 * untouched-hash claim and the cap — against the design note's own worked examples. A check that
 * fails prints its expectation and exits non-zero: a dry run that proves nothing would be a
 * green light over an unmeasured table.
 *
 * These are assertions rather than a test file because `site/scripts/**` is outside the vitest
 * `include` and the coverage `include` (both live in `vitest.config.ts`, which this lane may not
 * edit); running them from the CLI keeps them executable today.
 */

import { costOf, createMeter, diffBlocks, peakRates, type Rates } from './metrics.ts';

export type CheckResult = { passed: number; failed: string[] };

const RATES: Rates = { per: 1_000_000, input: 0.66, output: 1.98, cacheRead: 0.022 };

function near(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function block(i: number, text: string, hash = `h${String(i)}`) {
  return { id: `ch03#b${String(i)}`, i, text, hash };
}

export function runChecks(): CheckResult {
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  // §5's ledger example: ch03 at 257 625 in / 38 187 out, no cache → $0.2456.
  const noCache = costOf({ in: 257_625, out: 38_187, cachedIn: 0 }, RATES);
  check('cost/no-cache', near(noCache, 0.2456, 0.0001), `got ${String(noCache)}, expected 0.2456`);

  // §5's corrected line: the same call at a 60 % hit → ~$0.1460.
  const hit = costOf({ in: 257_625, out: 38_187, cachedIn: 154_575 }, RATES);
  check('cost/cache-hit', near(hit, 0.146, 0.002), `got ${String(hit)}, expected 0.1460`);

  // Peak doubles all three rates, so the peak basis is exactly twice the book basis.
  const peak = peakRates(RATES);
  check('cost/peak-is-2x', near(costOf({ in: 1_000_000, out: 0, cachedIn: 0 }, peak), 1.32, 1e-9), 'peak input must be 2x');
  check('cost/peak-output', near(costOf({ in: 0, out: 1_000_000, cachedIn: 0 }, peak), 3.96, 1e-9), 'peak output must be 2x');

  // A cached input token is charged the cache rate and never the input rate.
  const cachedOnly = costOf({ in: 1_000_000, out: 0, cachedIn: 1_000_000 }, RATES);
  check('cost/cached-only', near(cachedOnly, 0.022, 1e-9), `got ${String(cachedOnly)}`);

  // One block replaced: Σ max(|old|,|new|) = the changed block, the other two are untouched.
  const pre = [block(0, 'Гуси шли по льду.'), block(1, 'Часы стояли.'), block(2, 'Хлеб был чёрствый.')];
  const post = [
    block(0, 'Гуси шли по льду.'),
    block(1, 'Часы шли по кругу и опаздывали.', 'h1b'),
    block(2, 'Хлеб был чёрствый.'),
  ];
  const replaced = diffBlocks(pre, post, 60, null);
  check(
    'diff/replace',
    replaced.changedChars === post[1]!.text.length && replaced.untouchedBlocks === 2,
    `got ${JSON.stringify({ changed: replaced.changedChars, untouched: replaced.untouchedBlocks })}`,
  );
  check('diff/untouched-equal', replaced.untouchedHashEqual, 'a replaced block must leave the others equal');

  // A deletion is counted at the removed block's own length, and the count drops by one.
  const deleted = diffBlocks(pre, [pre[0]!, pre[2]!], 60, null);
  check(
    'diff/delete',
    deleted.changedChars === pre[1]!.text.length && deleted.untouchedBlocks === 2 && deleted.editedBlocks === 1,
    `got ${JSON.stringify({ changed: deleted.changedChars, untouched: deleted.untouchedBlocks, edited: deleted.editedBlocks })}`,
  );

  // An empty untouched set is never a pass: its hash would equal itself for the wrong reason.
  const everything = diffBlocks(pre, [block(3, 'Иное.'), block(4, 'Ещё иное.')], 60, null);
  check('diff/empty-untouched', everything.untouchedHashEqual === false, 'an empty untouched set must not read as equal');

  // The cap: the projected peak total is what stops a run, not the book total.
  const meter = createMeter(RATES, 1.75);
  meter.add({ in: 1_000_000, out: 0, cachedIn: 0 });
  check('cap/allows', meter.canAfford(0.4), `a projected total under the cap must be allowed (${String(meter.totals().usdPeak)} + 0.4)`);
  check('cap/stops', meter.canAfford(0.5) === false, 'a projected total over the cap must stop the run');
  check('cap/totals', near(meter.totals().usdPeak, 1.32, 1e-9), `got ${String(meter.totals().usdPeak)}`);

  return { passed: 12 - failures.length, failed: failures };
}
