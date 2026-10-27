import { describe, expect, it } from 'vitest';

import { marginFits, noteWidth, placeMargin } from './marginPass.ts';

/**
 * BOOK-90 §1.9 — the margin's pass, as a pure function.
 *
 * `top = max(anchorTop, cursor)`; `cursor = top + height + 12`. A note is never above its own
 * line, never on top of the neighbour before it, and the pass never drops, merges or reorders
 * an item. The residual is what the page must grow to hold the last object.
 */

const STEP = 12;

describe('marginFits — the measured guard (BOOK-DOC-47 §7)', () => {
  it('lets today’s frame keep its note at 1440 and 1024', () => {
    expect(marginFits(990, 1440)).toBe(true);
    expect(marginFits(782, 1024)).toBe(true);
  });

  it('is a measurement, not a breakpoint: the one-column frame’s paragraphs', () => {
    expect(marginFits(752, 1024)).toBe(true); // 396 px of channel at 1024
    expect(marginFits(792, 1440)).toBe(true); // the same at 1440
  });

  it('gives way to the strip when the channel would leave the viewport', () => {
    expect(marginFits(789, 1024)).toBe(false);
    expect(marginFits(1205, 1440)).toBe(false);
    expect(marginFits(1000, 1024)).toBe(false);
  });
});

describe('noteWidth — the note narrows with the channel, it is never clipped (BOOK-91)', () => {
  it('holds the design’s 188 px while the centred column leaves room', () => {
    expect(noteWidth(1440, 640)).toBe(188);
    expect(noteWidth(1100, 640)).toBeCloseTo(182, 6);
  });

  it('gives the channel itself at the 1024 step, and never a negative width', () => {
    // (1024 − 640) / 2 = 192 of channel, minus the 40 px mark and 8 px of air.
    expect(noteWidth(1024, 640)).toBe(144);
    expect(noteWidth(1024, 622.4)).toBeCloseTo(152.8, 6);
    expect(noteWidth(390, 622.4)).toBe(0);
  });

  it('keeps the note a margin at 1024 — the narrowed width is what lets it fit', () => {
    // The prose's right edge at 1024 is 832; with the design width the note would end at 1060.
    expect(marginFits(832, 1024, 40, 188)).toBe(false);
    expect(marginFits(832, 1024, 40, noteWidth(1024, 640))).toBe(true);
  });
});

describe('placeMargin', () => {
  it('starts every note on its own line when the channel is empty', () => {
    expect(placeMargin([{ anchorTop: 100, height: 96 }, { anchorTop: 400, height: 117 }], STEP, 1_000)).toEqual({
      tops: [100, 400],
      tail: 0,
    });
  });

  it('pushes a colliding note by exactly the step after the one above it', () => {
    expect(placeMargin([{ anchorTop: 100, height: 96 }, { anchorTop: 110, height: 117 }], STEP, 1_000)).toEqual({
      tops: [100, 208],
      tail: 0,
    });
  });

  it('never moves the first note up to meet the second', () => {
    const placed = placeMargin([{ anchorTop: 300, height: 96 }, { anchorTop: 100, height: 96 }], STEP, 1_000);
    expect(placed.tops).toEqual([300, 408]);
  });

  it('reads the measured heights, not an assumed one (95.8 / 116.8 / 134.3)', () => {
    const placed = placeMargin(
      [
        { anchorTop: 0, height: 95.8 },
        { anchorTop: 0, height: 116.8 },
        { anchorTop: 0, height: 134.3 },
      ],
      STEP,
      10_000,
    );
    expect(placed.tops[0]).toBe(0);
    expect(placed.tops[1]).toBeCloseTo(107.8, 5);
    expect(placed.tops[2]).toBeCloseTo(236.6, 5);
  });

  it('never drops an item: one top per anchor, in document order, even for a zero-height one', () => {
    const items = [
      { anchorTop: 40, height: 0 },
      { anchorTop: 10, height: 117 },
      { anchorTop: 30, height: 96 },
    ];
    const placed = placeMargin(items, STEP, 1_000);
    expect(placed.tops).toHaveLength(items.length);
    // The hidden item keeps its anchor and consumes no room; the visible ones still stack.
    expect(placed.tops).toEqual([40, 10, 139]);
  });

  it('grows the tail by what the last note reaches past the flow’s bottom', () => {
    const placed = placeMargin([{ anchorTop: 900, height: 117 }], STEP, 1_000);
    expect(placed.tail).toBe(17);
    expect(placeMargin([{ anchorTop: 100, height: 117 }], STEP, 1_000).tail).toBe(0);
    expect(placeMargin([], STEP, 1_000)).toEqual({ tops: [], tail: 0 });
  });

  it('counts an opened object as an item of the same pass', () => {
    const closed = placeMargin([{ anchorTop: 100, height: 96 }, { anchorTop: 250, height: 96 }], STEP, 1_000);
    const opened = placeMargin([{ anchorTop: 100, height: 300 }, { anchorTop: 250, height: 96 }], STEP, 1_000);
    expect(closed.tops[1]).toBe(250);
    expect(opened.tops[1]).toBe(412);
  });
});
