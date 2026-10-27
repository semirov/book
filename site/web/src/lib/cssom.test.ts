import { describe, expect, it } from 'vitest';

import { placePanel, placeTicks, reserveHeight, type PanelBox } from './cssom.ts';

/** BOOK-30 — the values a `style` attribute would carry, written through CSSOM instead. */

function node(): { style: { minHeight: string; left: string } } {
  return { style: { minHeight: '', left: '' } };
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

describe('placeTicks', () => {
  it('places one tick per position, in order', () => {
    const ticks = [node(), node(), node()];
    placeTicks(ticks, [10, 50, 100]);
    expect(ticks.map((tick) => tick.style.left)).toEqual(['10%', '50%', '100%']);
  });

  it('never writes past the elements or the positions it was given', () => {
    const fewerElements = [node()];
    placeTicks(fewerElements, [10, 50]);
    expect(fewerElements[0]?.style.left).toBe('10%');

    const fewerPositions = [node(), node()];
    placeTicks(fewerPositions, []);
    expect(fewerPositions[1]?.style.left).toBe('');

    expect(() => placeTicks([], [10])).not.toThrow();
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
