import { describe, expect, it } from 'vitest';

import { POPOVER_GAP, POPOVER_MARGIN, placePopover, samePlacement } from './popover.ts';

/** 390×844 is the owner's phone: the shape the popover bug was reported on. */
const PHONE = { width: 390, height: 844 };

describe('placePopover', () => {
  it('opens below an anchor with room, inside the viewport', () => {
    const placement = placePopover({ top: 200, left: 40, width: 100, height: 20 }, { width: 366, height: 300 }, PHONE);
    expect(placement.side).toBe('below');
    expect(placement.top).toBe(200 + 20 + POPOVER_GAP);
    expect(placement.maxHeight).toBe(300);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(PHONE.height - POPOVER_MARGIN);
  });

  it('flips above an anchor near the bottom when there is no room below', () => {
    // The last paragraph of chapter 67: the anchor sits eight pixels above the fold.
    const anchor = { top: 800, left: 32, width: 20, height: 20 };
    const placement = placePopover(anchor, { width: 366, height: 300 }, PHONE);
    expect(placement.side).toBe('above');
    expect(placement.top + placement.maxHeight).toBe(anchor.top - POPOVER_GAP);
    expect(placement.top).toBeGreaterThanOrEqual(POPOVER_MARGIN);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(PHONE.height);
  });

  it('chooses above when only above has room', () => {
    const placement = placePopover({ top: 700, left: 32, width: 20, height: 20 }, { width: 366, height: 120 }, PHONE);
    expect(placement.side).toBe('above');
  });

  it('caps the panel and keeps it inside when neither side holds its natural height', () => {
    const anchor = { top: 420, left: 32, width: 20, height: 20 };
    const placement = placePopover(anchor, { width: 366, height: 900 }, PHONE);
    expect(placement.maxHeight).toBeLessThan(900);
    expect(placement.top).toBeGreaterThanOrEqual(POPOVER_MARGIN);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(PHONE.height - POPOVER_MARGIN);
  });

  it('clamps horizontally at both edges', () => {
    const right = placePopover({ top: 100, left: 380, width: 20, height: 20 }, { width: 366, height: 200 }, PHONE);
    expect(right.left).toBeLessThanOrEqual(PHONE.width - POPOVER_MARGIN - right.width);
    expect(right.left).toBeGreaterThanOrEqual(POPOVER_MARGIN);

    const left = placePopover({ top: 100, left: -40, width: 20, height: 20 }, { width: 366, height: 200 }, PHONE);
    expect(left.left).toBe(POPOVER_MARGIN);
  });

  it('never renders wider than the viewport allows', () => {
    const placement = placePopover({ top: 100, left: 0, width: 20, height: 20 }, { width: 900, height: 200 }, PHONE);
    expect(placement.width).toBe(PHONE.width - 2 * POPOVER_MARGIN);
  });

  it('handles an anchor scrolled out above or below the viewport', () => {
    expect(placePopover({ top: -200, left: 10, width: 20, height: 20 }, { width: 300, height: 200 }, PHONE).side).toBe(
      'below',
    );
    const below = placePopover({ top: 900, left: 10, width: 20, height: 20 }, { width: 300, height: 200 }, PHONE);
    expect(below.side).toBe('above');
    expect(below.top).toBeGreaterThanOrEqual(POPOVER_MARGIN);
  });

  it('is a fixed point: a panel capped by the result measures the same again, so no oscillation', () => {
    const anchor = { top: 800, left: 32, width: 20, height: 20 };
    const first = placePopover(anchor, { width: 366, height: 900 }, PHONE);
    // The panel now measures the capped box, because CSS applies the returned maxHeight.
    const second = placePopover(anchor, { width: first.width, height: first.maxHeight }, PHONE);
    expect(samePlacement(first, second)).toBe(true);
    expect(second.top).toBe(first.top);
    expect(second.maxHeight).toBe(first.maxHeight);
  });

  it('stays valid on a viewport smaller than its own margins', () => {
    const placement = placePopover({ top: 4, left: 1, width: 2, height: 2 }, { width: 40, height: 40 }, { width: 20, height: 20 });
    expect(placement.top).toBe(POPOVER_MARGIN);
    expect(placement.maxHeight).toBe(0);
    expect(placement.width).toBe(0);
  });

  it('reports equal placements only within half a pixel', () => {
    const base = placePopover({ top: 100, left: 10, width: 20, height: 20 }, { width: 300, height: 200 }, PHONE);
    expect(samePlacement(base, { ...base, top: base.top + 0.2 })).toBe(true);
    expect(samePlacement(base, { ...base, top: base.top + 1 })).toBe(false);
    expect(samePlacement(base, null)).toBe(false);
    expect(samePlacement(null, base)).toBe(false);
    expect(samePlacement(null, null)).toBe(true);
  });
});
