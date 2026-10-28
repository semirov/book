import { describe, expect, it } from 'vitest';

import { placeFill, reserveHeight } from './cssom.ts';

/** BOOK-30 — the values a `style` attribute would carry, written through CSSOM instead. */

function node(): { style: { minHeight: string; width: string } } {
  return { style: { minHeight: '', width: '' } };
}

describe('reserveHeight', () => {
  it('writes the reserved height onto the element style, in pixels', () => {
    const element = node();
    reserveHeight(element, 11_060);
    expect(element.style.minHeight).toBe('11060px');
  });

  it('does nothing when the slot is gone (the chapter arrived first)', () => {
    expect(() => reserveHeight(null, 400)).not.toThrow();
  });
});

describe('placeFill (BOOK-DOC-50 §4)', () => {
  it('writes the traversed part of the rail as a percentage of its width', () => {
    const fill = node();
    placeFill(fill, 42.5);
    expect(fill.style.width).toBe('42.5%');
    placeFill(fill, 0);
    expect(fill.style.width).toBe('0%');
    placeFill(fill, 100);
    expect(fill.style.width).toBe('100%');
  });

  it('clamps to the track, so a stale value never paints past an end', () => {
    const fill = node();
    placeFill(fill, 140);
    expect(fill.style.width).toBe('100%');
    placeFill(fill, -3);
    expect(fill.style.width).toBe('0%');
    placeFill(fill, Number.NaN);
    expect(fill.style.width).toBe('0%');
  });

  it('tolerates a missing node (the rail is not rendered under two records)', () => {
    expect(() => placeFill(null, 50)).not.toThrow();
  });
});
