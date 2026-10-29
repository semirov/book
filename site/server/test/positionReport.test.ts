/**
 * BOOK-209 — the position harness's verdict, from synthetic numbers.
 *
 * The CDP script measures a browser; this test measures the arithmetic that decides pass/fail and
 * the record the owner reads. The cases are the ones the harness can actually produce: a row on
 * the reading line, a row eight pixels high, a row that lost ten thousand pixels to a collapsed
 * placeholder, a row that could not be measured at all, a back case that returned to the wrong
 * place, and the resume's three answers — not measured (no evidence, no miss), measured and
 * restored, measured and missed (exit 1).
 */

import { describe, expect, it } from 'vitest';

import type { PositionReport, PositionResume, PositionRow } from '../../scripts/lib/position.mjs';
import {
  POSITION_TARGET_PX,
  POSITION_TOLERANCE_PX,
  backMisses,
  markdownReport,
  median,
  positionVerdict,
  resumeMisses,
  round2,
  rowHolds,
  summariseRows,
} from '../../scripts/lib/position.mjs';

function row(n: number, width: number, actual: number | null, head: PositionRow['head'] = 'ch-h'): PositionRow {
  return {
    row: n,
    width,
    head,
    expected: POSITION_TARGET_PX,
    actual,
    delta: actual === null ? null : round2(actual - POSITION_TARGET_PX),
    at150: actual,
    at800: actual,
    stable: actual !== null,
  };
}

function report(rows: PositionRow[], overrides: Partial<PositionReport> = {}): PositionReport {
  return {
    commit: '13e4267',
    branch: 'task/position',
    at: '2026-10-29T07:00:00.000Z',
    target: POSITION_TARGET_PX,
    tolerance: POSITION_TOLERANCE_PX,
    widths: [1440, 390],
    dirty: [],
    browser: '/Chromium',
    freshPerRow: true,
    budget: { readPerMinute: 100_000 },
    rows,
    back: [],
    resume: {
      server: { outcome: 'guarded', anonymous: 401, signed: 404 },
      anchor: null,
      put: null,
      sameDevice: null,
      secondDevice: null,
    },
    ...overrides,
  };
}

describe('round2 and median', () => {
  it('keeps two decimals and refuses a non-number', () => {
    expect(round2(8.0575)).toBe(8.06);
    expect(round2(Number.NaN)).toBeNull();
  });

  it('takes the middle of an odd list and the mean of the two middles of an even one', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([Number.NaN, 4])).toBe(4);
  });
});

describe('a row holds when the measured delta is inside the tolerance', () => {
  it('counts exactly ±2 as a hold and 2.01 as a miss', () => {
    expect(rowHolds(row(1, 1440, 18))).toBe(true);
    expect(rowHolds(row(1, 1440, 14))).toBe(true);
    expect(rowHolds(row(1, 1440, 18.01))).toBe(false);
    expect(rowHolds(row(1, 1440, 13.99))).toBe(false);
  });

  it('never holds an unmeasured row: a missing number is not a landing', () => {
    expect(rowHolds(row(1, 1440, null, 'missing'))).toBe(false);
  });
});

describe('summariseRows', () => {
  const rows = [
    row(1, 1440, 8.06),
    row(2, 1440, 7.42),
    row(16, 1440, -11838.91, 'article'),
    row(1, 390, 64.73),
    row(2, 390, 7.9),
  ];

  it('reports a bucket per width in first-seen order, with the count outside', () => {
    const summary = summariseRows(rows);
    expect(summary.map((bucket) => bucket.width)).toEqual([1440, 390]);
    expect(summary[0]).toMatchObject({ count: 3, outside: 3 });
    expect(summary[1]).toMatchObject({ count: 2, outside: 2 });
  });

  it('names the worst row by |delta|, not by sign', () => {
    const summary = summariseRows(rows);
    expect(summary[0]?.worst).toMatchObject({ row: 16, delta: -11854.91, head: 'article' });
    expect(summary[1]?.worst).toMatchObject({ row: 1, delta: 48.73 });
  });

  it('prefers an unmeasured row over a measured one in the worst slot', () => {
    const summary = summariseRows([row(1, 1440, 8), row(2, 1440, null, 'missing')]);
    expect(summary[0]?.worst?.row).toBe(2);
    expect(summary[0]?.outside).toBe(2);
  });
});

describe('backMisses', () => {
  it('flags a missing sentence and a delta past the tolerance, and nothing else', () => {
    const back = [
      { case: 'discussion', sentence: 'a', before: 450, after: 450, delta: 0, found: true },
      { case: 'ch-2', sentence: 'b', before: 450, after: -12696, delta: -13146, found: true },
      { case: 'ch-3', sentence: 'c', before: 450, after: null, delta: null, found: false },
    ];
    expect(backMisses(back).map((item) => item.case)).toEqual(['ch-2', 'ch-3']);
  });
});

describe('resumeMisses', () => {
  const place = (restored: boolean | null, before: number | null = 41.5, after: number | null = 41.5) => ({
    measured: true,
    top: 0,
    sentence: null,
    before,
    after,
    restored,
  });
  const resume = (overrides: Partial<PositionResume> = {}): PositionResume => ({
    server: { outcome: 'answered', anonymous: 401, signed: 200 },
    anchor: { chapter: 7, sentenceId: 'ch7#abc/s12', deltaPx: 41.5, at: '2026-10-29T07:00:00.000Z' },
    put: 204,
    sameDevice: null,
    secondDevice: null,
    ...overrides,
  });

  it('says nothing when neither device was measured — no evidence is not a miss', () => {
    expect(resumeMisses(resume())).toEqual([]);
    expect(resumeMisses(resume({ sameDevice: null, secondDevice: null }))).toEqual([]);
  });

  it('counts nothing when both devices came back to the anchor', () => {
    expect(resumeMisses(resume({ sameDevice: place(true), secondDevice: place(true) }))).toEqual([]);
  });

  it('counts the device that was measured and landed elsewhere, and only that one', () => {
    const misses = resumeMisses(resume({ sameDevice: place(true), secondDevice: place(false, 41.5, -130) }));
    expect(misses.map((miss) => miss.device)).toEqual(['second-device']);
  });

  it('counts a same-device miss too — the guard can fail', () => {
    expect(resumeMisses(resume({ sameDevice: place(false, 41.5, null) })).map((m) => m.device)).toEqual([
      'same-device',
    ]);
  });

  it('treats an explicit null inside a measured row as unmeasured, not as a miss', () => {
    expect(resumeMisses(resume({ sameDevice: place(null) }))).toEqual([]);
  });

  it('counts a place layer whose server never answered — there, unmeasured is not a pass', () => {
    const misses = resumeMisses(
      resume({ server: { outcome: 'guarded', anonymous: 429, signed: 429 }, sameDevice: place(true) }),
    );
    expect(misses.map((miss) => miss.device)).toEqual(['server']);
  });

  it('says nothing when the layer is absent and the route is absent too (untouched main)', () => {
    expect(resumeMisses(resume({ server: { outcome: 'absent', anonymous: 401, signed: 404 } }))).toEqual([]);
  });

  it('leaves a refused PUT as an unmeasured device, never as a miss', () => {
    // The PUT is a separate fact: a refused PUT leaves `secondDevice: null`, which is not a miss.
    expect(resumeMisses(resume({ put: 404, secondDevice: null }))).toEqual([]);
  });
});

describe('positionVerdict', () => {
  it('is 0 when every row and every back case holds', () => {
    const verdict = positionVerdict(
      report([row(1, 1440, 16), row(1, 390, 15)], {
        back: [{ case: 'discussion', sentence: 'a', before: 450, after: 450, delta: 0, found: true }],
      }),
    );
    expect(verdict).toEqual({ code: 0, reasons: [] });
  });

  it('is 1 and names the numbers when a row misses', () => {
    const verdict = positionVerdict(report([row(1, 1440, 8.06)], { widths: [1440] }));
    expect(verdict.code).toBe(1);
    expect(verdict.reasons[0]).toContain('1/1 row(s) outside ±2 px at 1440');
  });

  it('is 1 when a back case lost the place', () => {
    const verdict = positionVerdict(
      report([row(1, 1440, 16)], {
        back: [{ case: 'ch-2', sentence: 'b', before: 450, after: -12696, delta: -13146, found: true }],
      }),
    );
    expect(verdict.code).toBe(1);
    expect(verdict.reasons.join(' ')).toContain('back case ch-2');
  });
});

describe('markdownReport', () => {
  const verdictReport = report([row(1, 1440, 8.06), row(16, 1440, -11838.91, 'article'), row(1, 390, 64.73)], {
    back: [{ case: 'ch-2', sentence: 'Это не выдача', before: 450, after: -12696, delta: -13146, found: true }],
  });

  it('writes the summary, the rows, the back cases and the resume answer', () => {
    const text = markdownReport(verdictReport, { stage: 'before' });
    expect(text).toContain('# Position — before');
    expect(text).toContain('| 1440 | 2 | 2 | -5931.42 | 16 | -11838.91 | -11854.91 |');
    expect(text).toContain('| 390 | 1 | 1 | 48.73 | 1 | 64.73 | 48.73 |');
    expect(text).toContain('- read budget: READ_PER_MINUTE=100000');
    expect(text).toContain('«Это не выдача»');
    expect(text).toContain('resume-server: guarded (anonymous=401, signed=404) — the route answers only its reader');
    expect(text).toContain('| same-device | — | — | — | — | — | not measured |');
    expect(text).toContain('exit 1 —');
  });

  it('records the three resume outcomes as the numbers say, and never claims «not implemented» for a 401', () => {
    const text = markdownReport(
      report([row(1, 1440, 16)], {
        resume: {
          server: { outcome: 'answered', anonymous: 401, signed: 200 },
          anchor: { chapter: 7, sentenceId: 'ch7#abc/s12', deltaPx: 41.5, at: '2026-10-29T07:00:00.000Z' },
          put: 204,
          sameDevice: { measured: true, top: 120, sentence: 'Свет', before: 41.5, after: 41.5, restored: true },
          secondDevice: {
            measured: true,
            top: 9840,
            sentence: 'Свет',
            before: 41.5,
            after: -130,
            restored: false,
          },
        },
      }),
      { stage: 'after' },
    );
    expect(text).toContain('resume-server: answered (anonymous=401, signed=200)');
    expect(text).toContain('`ch7#abc/s12`');
    expect(text).toContain('PUT /api/me/place: 204');
    expect(text).toContain('| same-device | 120 | «Свет» | 41.5 | 41.5 | 0 | yes |');
    expect(text).toContain('| second-device | 9840 | «Свет» | 41.5 | -130 | -171.5 | no |');
    expect(text).toContain('resume (second-device) did not restore the place');
    expect(text).toContain('exit 1');

    // A layer whose server never answered is a miss with the limiter named, not a quiet pass.
    const refused = markdownReport(
      report([row(1, 1440, 16)], {
        resume: {
          server: { outcome: 'guarded', anonymous: 429, signed: 429 },
          anchor: { chapter: 7, sentenceId: 'ch7#abc/s12', deltaPx: 41.5, at: '2026-10-29T07:00:00.000Z' },
          put: null,
          sameDevice: { measured: true, top: 0, sentence: null, before: 41.5, after: 41.5, restored: true },
          secondDevice: null,
        },
      }),
      { stage: 'after' },
    );
    expect(refused).toContain('resume-server: guarded (anonymous=429, signed=429)');
    expect(refused).toContain('the signed-in place was not exercised (guarded: anonymous=429, signed=429)');
    expect(refused).toContain('exit 1');
  });

  it('names the book each run measured: the fixture it wrote (with its counts) or the path it was given', () => {
    const fixture = markdownReport(
      report([row(1, 1440, 16)], {
        seed: {
          how: 'fixture',
          source: '/tmp/position-fixture-abc',
          line: 'position-seed: book=/tmp/position-fixture-abc',
          fixture: { files: 43, chapters: 42, blocks: 594, bytes: 239916 },
        },
      }),
      { stage: 'after' },
    );
    expect(fixture).toContain(
      '- seed: fixture — generated `manuscript/` in a temp dir (43 files, 42 chapters, 594 blocks, 239916 bytes), ' +
        'deleted with the run',
    );
    const volume = markdownReport(
      report([row(1, 1440, 16)], { seed: { how: 'volume', source: '/data/volume', line: 'position-seed: volume=…' } }),
      { stage: 'after' },
    );
    expect(volume).toContain('- seed: volume `/data/volume`');
    // A fixture record without its counts is still a named book, never an empty backtick pair.
    const bare = markdownReport(
      report([row(1, 1440, 16)], { seed: { how: 'fixture', source: '/tmp/x', line: 'position-seed: …' } }),
      { stage: 'after' },
    );
    expect(bare).toContain('- seed: fixture `/tmp/x`');
  });

  it('says the tree is dirty when it is, and names the files', () => {
    const text = markdownReport(report([row(1, 1440, 16)], { dirty: ['site/server/src/db/schema.ts'] }), {
      stage: 'before',
    });
    expect(text).toContain('dirty — site/server/src/db/schema.ts');
    expect(text).toContain('exit 0');
  });
});
