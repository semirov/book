import { describe, expect, it } from 'vitest';

import { compareLines, graphemes, spanOf } from '../../scripts/lib/passProbe.mjs';

/**
 * `scripts/pass-frames.mjs` measures the live pass with two rules borrowed from the renderer:
 * the grapheme diff of `lib/passDiff.ts` and "one line per distinct top, to a hundredth of a
 * pixel". Both are copied into `scripts/lib/passProbe.mjs` because the harness runs outside the
 * bundle; these tests keep the copy honest, and pin the comparison that decides the claim.
 */

describe('the harness’s grapheme diff is the renderer’s', () => {
  it('finds the minimal replacement, its offset and its kind', () => {
    const span = spanOf('В сводке появились новые позиции.', 'В сводке появились свежие строки.');
    expect(span.kind).toBe('replacement');
    expect(span.offset).toBe(graphemes('В сводке появились ').length);
    // Minimal: the shared `и.` at the tail belongs to neither side of the change.
    expect(span.before).toBe('новые позици');
    expect(span.after).toBe('свежие строк');
  });

  it('names an insertion and a deletion by the empty side', () => {
    expect(spanOf('Опоздание — это запись.', 'Опоздание — это уже запись.').kind).toBe('insertion');
    expect(spanOf('Опоздание — это уже запись.', 'Опоздание — это запись.').kind).toBe('deletion');
  });

  it('counts grapheme clusters, never code units', () => {
    // A combining mark rides with its base letter; splitting it would name a character that
    // exists in neither text.
    expect(graphemes('е\u0301')).toEqual(['е\u0301']);
    expect(spanOf('е\u0301', 'ё')).toMatchObject({ kind: 'replacement', before: 'е\u0301', after: 'ё' });
  });
});

describe('the line-grid comparison decides the no-reflow claim', () => {
  const grid = (tops: number[]) => ({ count: tops.length, tops });

  it('accepts an identical grid and a hundredth of a pixel of jitter', () => {
    expect(compareLines(grid([3, 33.23, 63.47]), grid([3, 33.23, 63.47])).same).toBe(true);
    expect(compareLines(grid([3, 33.23]), grid([3.01, 33.23])).same).toBe(true);
  });

  it('refuses a line that moved by two hundredths — or by an inch', () => {
    const moved = compareLines(grid([3, 33.23, 63.47]), grid([3, 33.23, 63.49]));
    expect(moved.same).toBe(false);
    expect(moved.maxDeltaPx).toBe(0.02);
    expect(moved.deltaPx).toEqual([0, 0, 0.02]);

    const lifted = compareLines(grid([3, 33.23]), grid([3, 34.23]));
    expect(lifted.same).toBe(false);
    expect(lifted.maxDeltaPx).toBe(1);
  });

  it('refuses a grid of a different line count, and names the missing line', () => {
    const shorter = compareLines(grid([3, 33.23, 63.47]), grid([3, 33.23]));
    expect(shorter.same).toBe(false);
    expect(shorter.count).toEqual({ left: 3, right: 2 });
    expect(shorter.deltaPx.at(-1)).toBeNull();
  });
});
