// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { layoutOf, linePxOf, measureRun, type RunMeasure } from './passMeasure.ts';

/**
 * BOOK-121 — the block's own box, read once.
 *
 * jsdom lays nothing out, so the boxes are injected: the arithmetic that turns them into the
 * engine's layout is what these tests pin. The browser proves the boxes themselves.
 */

const LINE = 30.24;

const box = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** A run of `count` graphemes over `lines` lines, `per` graphemes on each, from `origin` down. */
function measure(count: number, options: { origin?: number; lines?: number; per?: number } = {}): RunMeasure {
  const origin = options.origin ?? 0;
  const per = options.per ?? count;
  const lines = options.lines ?? 1;
  return {
    tops: Array.from({ length: count }, (_, index) => origin + Math.min(lines - 1, Math.floor(index / per)) * LINE),
    lefts: Array.from({ length: count }, (_, index) => 8 + (index % per) * 12),
    widths: Array.from({ length: count }, () => 12),
    blockHeight: 6 * LINE,
    linePx: LINE,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('linePxOf', () => {
  it('takes the declared line box when it is a length', () => {
    expect(linePxOf('30.24px', [0, 0, 999])).toBeCloseTo(LINE, 5);
    expect(linePxOf(' 28.56px ', [])).toBeCloseTo(28.56, 5);
  });

  it('falls back to the smallest gap between distinct line tops — `normal` proves nothing', () => {
    expect(linePxOf('normal', [60.48, 60.48, 90.72])).toBeCloseTo(LINE, 2);
    expect(linePxOf('', [0, 28.56, 57.12, 85.68])).toBeCloseTo(28.56, 2);
    // Unequal gaps (a strut, a taller inline): the tightest one is the line box.
    expect(linePxOf('normal', [0, 50, 70])).toBe(20);
  });

  it('answers 0 when neither the sheet nor the boxes can prove a line', () => {
    expect(linePxOf('normal', [])).toBe(0);
    expect(linePxOf('auto', [12, 12])).toBe(0);
    expect(linePxOf('0px', [])).toBe(0);
    expect(linePxOf('-4px', [])).toBe(0);
  });
});

describe('layoutOf', () => {
  it('maps the run of the replacement fixture onto its two lines', () => {
    const geometry = layoutOf(measure(23, { lines: 2, per: 21 }), 'replacement');
    expect(geometry).not.toBeNull();
    expect(geometry?.linePx).toBeCloseTo(LINE, 5);
    expect(geometry?.blockLines).toBe(6);
    expect(geometry?.spanStartLine).toBe(0);
    expect(geometry?.spanLines).toBe(2);
    expect(geometry?.runLines).toHaveLength(23);
    expect(geometry?.runLines.slice(0, 21).every((line) => line === 0)).toBe(true);
    expect(geometry?.runLines.slice(21)).toEqual([1, 1]);
    expect(geometry?.lefts).toHaveLength(23);
  });

  it('counts the line from the block’s own top, not from the run’s', () => {
    // The run starts on the block's third line and ends on its fourth.
    const geometry = layoutOf(measure(23, { origin: 2 * LINE, lines: 2, per: 21 }), 'replacement');
    expect(geometry?.spanStartLine).toBe(2);
    expect(geometry?.spanLines).toBe(2);
    expect(geometry?.runLines.slice(21)).toEqual([3, 3]);
  });

  it('gives a deletion no run map, only the span the ghost occupies', () => {
    const geometry = layoutOf(measure(14, { origin: LINE, lines: 2, per: 9 }), 'deletion');
    expect(geometry?.runLines).toEqual([]);
    expect(geometry?.spanStartLine).toBe(1);
    expect(geometry?.spanLines).toBe(2);
  });

  it('is at least as tall as the last line it inks, whatever the height rounds to', () => {
    const short = { ...measure(3), blockHeight: 1 };
    expect(layoutOf(short, 'replacement')?.blockLines).toBe(1);
    // A run that ends on the block's sixth line needs a seventh line box to hold it.
    const deeper = layoutOf(measure(23, { origin: 5 * LINE, lines: 2, per: 21 }), 'replacement');
    expect(deeper?.spanStartLine).toBe(5);
    expect(deeper?.blockLines).toBe(7);
  });

  it('refuses boxes the engine would have to guess from', () => {
    const boxes = measure(3);
    expect(layoutOf({ ...boxes, tops: [] }, 'replacement')).toBeNull();
    expect(layoutOf({ ...boxes, lefts: [0] }, 'replacement')).toBeNull();
    expect(layoutOf({ ...boxes, widths: [1, 2] }, 'replacement')).toBeNull();
    expect(layoutOf({ ...boxes, linePx: 0 }, 'replacement')).toBeNull();
    expect(layoutOf({ ...boxes, linePx: Number.NaN }, 'replacement')).toBeNull();
    expect(layoutOf({ ...boxes, blockHeight: 0 }, 'replacement')).toBeNull();
    // A run whose tops climb back up the page cannot be a line map.
    expect(layoutOf({ ...boxes, tops: [LINE * 3, LINE, LINE * 2] }, 'replacement')).toBeNull();
  });
});

describe('measureRun', () => {
  it('reads every grapheme once, relative to the block, and takes the declared line height', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: `${LINE}px` } as CSSStyleDeclaration);
    const block = document.createElement('p');
    const nodes = Array.from({ length: 3 }, (_, index) => {
      const node = document.createElement('span');
      node.setAttribute('data-i', String(index));
      return node;
    });
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === block) return box(100, 20, 342, 6 * LINE);
      const index = Number(this.getAttribute('data-i') ?? 0);
      return box(100 + Math.floor(index / 2) * LINE, 20 + (index % 2) * 12, 12, LINE);
    });

    const read = measureRun(block, nodes);
    expect(read?.linePx).toBeCloseTo(LINE, 5);
    expect(read?.blockHeight).toBeCloseTo(6 * LINE, 5);
    expect(read?.tops.map((top) => Number(top.toFixed(2)))).toEqual([0, 0, LINE]);
    expect(read?.lefts).toEqual([0, 12, 0]);
    expect(read?.widths).toEqual([12, 12, 12]);
    expect(rects).toHaveBeenCalledTimes(4); // the block and its three graphemes, once each
  });

  it('falls back to the gaps between line tops when the sheet proves no line box', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: 'normal' } as CSSStyleDeclaration);
    const block = document.createElement('p');
    const nodes = [0, 1].map((index) => {
      const node = document.createElement('span');
      node.setAttribute('data-i', String(index));
      return node;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === block) return box(0, 0, 342, 2 * LINE);
      const index = Number(this.getAttribute('data-i') ?? 0);
      return box(index * LINE, index * 12, 12, LINE);
    });
    expect(measureRun(block, nodes)?.linePx).toBeCloseTo(LINE, 2);
  });

  it('answers null when there is no run to read or no line to prove', () => {
    const block = document.createElement('p');
    expect(measureRun(block, [])).toBeNull();
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: 'normal' } as CSSStyleDeclaration);
    const node = document.createElement('span');
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => box(0, 0, 0, 0));
    expect(measureRun(block, [node])).toBeNull();
  });
});
