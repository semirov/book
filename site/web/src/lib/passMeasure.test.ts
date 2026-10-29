// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { geometryOf, linePxOf, measureGraphemes, type RunMeasure } from './passMeasure.ts';

/**
 * BOOK-220 §11.2 — the block's own box, read once.
 *
 * jsdom lays nothing out, so the boxes are injected: the arithmetic that turns them into the
 * renderer's geometry is what these tests pin, and the browser proves the boxes themselves.
 */

const LINE = 30.24;

const box = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** A run of `count` graphemes over `lines` lines, `per` graphemes on each, from `origin` down. */
function measure(count: number, options: { origin?: number; per?: number } = {}): RunMeasure {
  const origin = options.origin ?? 0;
  const per = options.per ?? count;
  return {
    tops: Array.from({ length: count }, (_, index) => origin + Math.floor(index / per) * LINE),
    lefts: Array.from({ length: count }, (_, index) => 8 + (index % per) * 12),
    widths: Array.from({ length: count }, () => 12),
    copyWidth: 342,
    copyHeight: 4 * LINE,
    blockHeight: 4 * LINE,
    linePx: LINE,
  };
}

/** jsdom has no geometry for a Range: the stub is installed once, then read as the layout. */
function stubRanges(rectsOf: (range: Range) => DOMRect[]): void {
  type RectFn = { getClientRects: () => DOMRectList };
  const proto = Range.prototype as unknown as RectFn;
  if (typeof proto.getClientRects !== 'function') {
    proto.getClientRects = () => [] as unknown as DOMRectList;
  }
  vi.spyOn(proto, 'getClientRects').mockImplementation(function (this: Range) {
    return rectsOf(this) as unknown as DOMRectList;
  });
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

describe('geometryOf', () => {
  it('maps the run onto its lines and keeps the copy as the clip box', () => {
    const geometry = geometryOf(measure(23, { per: 21 }));
    expect(geometry).not.toBeNull();
    expect(geometry?.linePx).toBeCloseTo(LINE, 5);
    expect(geometry?.copyWidth).toBe(342);
    expect(geometry?.runLines[0]).toBe(0);
    expect(geometry?.runLines[20]).toBe(0);
    expect(geometry?.runLines[21]).toBe(1);
    expect(geometry?.lefts[0]).toBe(8);
    expect(geometry?.widths[0]).toBe(12);
  });

  it('refuses a run that goes back up the page, or boxes it cannot place', () => {
    const up = measure(4, { per: 2 });
    up.tops = [LINE, LINE, 0, 0];
    expect(geometryOf(up)).toBeNull();
    expect(geometryOf({ ...measure(2), lefts: [0] })).toBeNull();
    expect(geometryOf({ ...measure(2), linePx: 0 })).toBeNull();
    expect(geometryOf({ ...measure(2), copyWidth: 0 })).toBeNull();
    expect(geometryOf({ ...measure(2), copyHeight: 0 })).toBeNull();
  });
});

describe('measureGraphemes', () => {
  it('reads each grapheme with a Range, never a node per character', () => {
    const block = document.createElement('p');
    const copy = document.createElement('span');
    const node = document.createTextNode('абвгд');
    copy.append(node);
    block.append(copy);
    document.body.append(block);

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === block) return box(100, 0, 342, 4 * LINE);
      if (this === copy) return box(100, 8, 342, 4 * LINE);
      return box(0, 0, 0, 0);
    });
    // Two graphemes a line, 12 px each: the stub answers in the copy's coordinates.
    stubRanges((range) => {
      const index = range.startOffset;
      const top = 100 + Math.floor(index / 2) * LINE;
      const left = 8 + (index % 2) * 12;
      return [box(top, left, 12, LINE)];
    });
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: `${LINE}px` } as CSSStyleDeclaration);

    const measured = measureGraphemes(block, copy, node, ['а', 'б', 'в', 'г', 'д'], 0);
    expect(measured).not.toBeNull();
    expect(measured?.lefts).toEqual([0, 12, 0, 12, 0]);
    const tops = measured?.tops ?? [];
    for (const [index, expected] of [0, 0, LINE, LINE, 2 * LINE].entries()) {
      expect(tops[index]).toBeCloseTo(expected, 5);
    }
    expect(measured?.copyWidth).toBe(342);
    expect(measured?.copyHeight).toBeCloseTo(4 * LINE, 5);
  });

  it('answers null for an empty run: there is nothing to place a caret on', () => {
    expect(measureGraphemes(document.createElement('p'), document.createElement('span'), document.createTextNode('a'), [], 0)).toBeNull();
  });
});
