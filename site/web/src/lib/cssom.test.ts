import { describe, expect, it } from 'vitest';

import { placeFill, placePanel, reserveHeight, type PanelBox } from './cssom.ts';

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

describe('placePanel', () => {
  function panel(): { style: { top: string; left: string; width: string; maxHeight: string } } {
    return { style: { top: '', left: '', width: '', maxHeight: '' } };
  }

  it('writes the measured box onto the panel style', () => {
    const aside = panel();
    const box: PanelBox = { top: 120, left: 10, width: 320, maxHeight: 476 };
    placePanel(aside, box);
    expect(aside.style).toEqual({ top: '120px', left: '10px', width: '320px', maxHeight: '476px' });
  });

  it('clears the box when the panel is not anchored, and tolerates a missing node', () => {
    const aside = panel();
    placePanel(aside, { top: 1, left: 2, width: 3, maxHeight: 4 });
    placePanel(aside, null);
    expect(aside.style).toEqual({ top: '', left: '', width: '', maxHeight: '' });
    expect(() => placePanel(null, null)).not.toThrow();
  });
});
