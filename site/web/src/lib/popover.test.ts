import { describe, expect, it } from 'vitest';

import { POPOVER_GAP, POPOVER_MARGIN, placePopover, samePlacement, viewportOf } from './popover.ts';

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
    // The last paragraph of chapter 42: the anchor sits eight pixels above the fold.
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

/**
 * BOOK-137 — the box is the **visual** viewport. A phone's URL bar and keyboard shrink what
 * the reader sees while the layout viewport (`innerWidth/innerHeight`) stays whole, so a panel
 * clamped to the latter opened below the fold: the anchor sits on the last line of the last
 * paragraph, near the bottom of the visible area, and the panel must rise into the box.
 */
describe('placePopover inside the visual viewport', () => {
  /** The last line of the last paragraph: the anchor's bottom is the box's bottom, minus a line. */
  const lastLine = (height: number) => ({ top: height - 40, left: 32, width: 120, height: 20 });

  it('fits above the last line at 390×844 with the browser’s own offsets', () => {
    // A URL bar (60 px) and a keyboard-free page: the visible box starts 60 px down.
    const box = { width: 390, height: 700, offsetLeft: 0, offsetTop: 60 };
    const placement = placePopover(lastLine(844 - 60), { width: 366, height: 520 }, box);
    expect(placement.side).toBe('above');
    expect(placement.maxHeight).toBeGreaterThan(0);
    expect(placement.top).toBeGreaterThanOrEqual(60 + POPOVER_MARGIN);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(60 + 700 - POPOVER_MARGIN);
    expect(placement.left).toBeGreaterThanOrEqual(POPOVER_MARGIN);
    expect(placement.left + placement.width).toBeLessThanOrEqual(390 - POPOVER_MARGIN);
  });

  it('fits above the last line at 360×640, where the panel is taller than the box', () => {
    const box = { width: 360, height: 560, offsetLeft: 0, offsetTop: 80 };
    const placement = placePopover(lastLine(640 - 80), { width: 336, height: 900 }, box);
    expect(placement.maxHeight).toBeGreaterThan(0);
    // Taller than the box: it is capped and scrolls its own text, never leaves the box.
    expect(placement.maxHeight).toBeLessThanOrEqual(560 - 2 * POPOVER_MARGIN);
    expect(placement.top).toBeGreaterThanOrEqual(80 + POPOVER_MARGIN);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(80 + 560 - POPOVER_MARGIN);
    expect(placement.left + placement.width).toBeLessThanOrEqual(360 - POPOVER_MARGIN);
  });

  it('applies the horizontal offset too: a zoomed box is not anchored at zero', () => {
    const box = { width: 300, height: 600, offsetLeft: 40, offsetTop: 20 };
    const placement = placePopover({ top: 200, left: 0, width: 20, height: 20 }, { width: 366, height: 200 }, box);
    expect(placement.left).toBe(40 + POPOVER_MARGIN);
    expect(placement.left + placement.width).toBeLessThanOrEqual(40 + 300 - POPOVER_MARGIN);
    expect(placement.top).toBeGreaterThanOrEqual(20 + POPOVER_MARGIN);
  });
});

describe('viewportOf', () => {
  it('reads the visual viewport and its offsets when the browser has one', () => {
    expect(
      viewportOf({
        innerWidth: 390,
        innerHeight: 844,
        visualViewport: { width: 390, height: 700, offsetLeft: 0, offsetTop: 60 },
      }),
    ).toEqual({ width: 390, height: 700, offsetLeft: 0, offsetTop: 60 });
  });

  it('falls back to the window’s own size, with no offsets to apply', () => {
    expect(viewportOf({ innerWidth: 1024, innerHeight: 900 })).toEqual({
      width: 1024,
      height: 900,
      offsetLeft: 0,
      offsetTop: 0,
    });
    expect(viewportOf({ innerWidth: 390, innerHeight: 844, visualViewport: null })).toEqual({
      width: 390,
      height: 844,
      offsetLeft: 0,
      offsetTop: 0,
    });
  });

  it('treats a missing measurement as missing, never as a zero-sized box', () => {
    // `0` is what jsdom reports for an unlaid-out `visualViewport`; the window's size wins.
    expect(viewportOf({ innerWidth: 390, innerHeight: 844, visualViewport: { width: 0, height: 0 } })).toMatchObject({
      width: 390,
      height: 844,
    });
    expect(viewportOf(null)).toEqual({ width: 0, height: 0, offsetLeft: 0, offsetTop: 0 });
  });
});
