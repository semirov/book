import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  marginFits,
  noteGapFrom,
  noteWidth,
  placeMargin,
  MARK_AIR,
  MARK_HIT,
  NOTE_GAP,
  NOTE_MIN,
} from './marginPass.ts';

/**
 * BOOK-90 §1.9 — the margin's pass, as a pure function.
 *
 * `top = max(anchorTop, cursor)`; `cursor = top + height + 12`. A note is never above its own
 * line, never on top of the neighbour before it, and the pass never drops, merges or reorders
 * an item. The residual is what the page must grow to hold the last object.
 *
 * BOOK-208 — the horizontal arithmetic is measured from the prose's right edge and starts with
 * air: 16 px at the measure, the mark's 40 px target (`--note-gap` = 56), the note, 8 px to the
 * viewport. A channel under `--note-min` (120) holds no note at all: `noteWidth` answers 0 and
 * the paragraph is a strip.
 */

const STEP = 12;

describe('the channel’s arithmetic (BOOK-208)', () => {
  it('states the gap as the air plus the mark’s target, and the floor as 120', () => {
    expect(MARK_AIR).toBe(16);
    expect(MARK_HIT).toBe(40);
    // The CSS says `calc(var(--mark-air) + var(--mark-hit))`: the constant is that same sum.
    expect(MARK_AIR + MARK_HIT).toBe(NOTE_GAP);
    expect(NOTE_GAP).toBe(56);
    expect(NOTE_MIN).toBe(120);
  });

  it('reads the gap from the two plain px tokens, never from the calc’s token stream', () => {
    const asked: string[] = [];
    const values: Record<string, string> = {
      '--mark-air': '16px',
      '--mark-hit': '40px',
      // A custom property's computed value is the token stream itself, not the used length.
      '--note-gap': 'calc(var(--mark-air) + var(--mark-hit))',
    };
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => {
        asked.push(name);
        return values[name] ?? '';
      },
    }));
    expect(noteGapFrom({ documentElement: {} } as unknown as Document)).toBe(56);
    // The pass asks for the two numbers the calc is made of: `--note-gap` is unreadable.
    expect(asked).toEqual(['--mark-air', '--mark-hit']);
    expect(asked).not.toContain('--note-gap');
  });

  it('falls back to the design’s own sum when a page lost the tokens', () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    expect(noteGapFrom({ documentElement: {} } as unknown as Document)).toBe(NOTE_GAP);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('marginFits — the measured guard (BOOK-DOC-47 §7)', () => {
  it('lets today’s frame keep its note at 1440, and at 1024 with the width it computed', () => {
    // 1040 + 56 + 188 + 8 = 1292 of 1440.
    expect(marginFits(1040, 1440)).toBe(true);
    // The design width does not fit at 1024 (832 + 56 + 188 + 8 = 1084); the narrowed one does.
    expect(marginFits(832, 1024)).toBe(false);
    expect(marginFits(832, 1024, NOTE_GAP, noteWidth(1024, 640))).toBe(true);
  });

  it('is a measurement, not a breakpoint: the one-column frame’s paragraphs', () => {
    expect(marginFits(752, 1024)).toBe(true); // 216 px of channel at 1024
    expect(marginFits(792, 1440)).toBe(true); // the same at 1440
  });

  it('gives way to the strip when the channel would leave the viewport', () => {
    expect(marginFits(789, 1024)).toBe(false);
    expect(marginFits(1205, 1440)).toBe(false);
    expect(marginFits(1000, 1024)).toBe(false);
  });

  it('reads a zero width as "no margin at all", never as a narrow note', () => {
    // A 0 px object is not a note: it is the strip's own case, whatever the frame says.
    expect(marginFits(832, 1024, NOTE_GAP, 0)).toBe(false);
    expect(marginFits(400, 1440, NOTE_GAP, 0)).toBe(false);
    expect(marginFits(832, 1024, NOTE_GAP, NOTE_MIN)).toBe(true);
  });
});

describe('noteWidth — the note narrows with the channel, it is never clipped (BOOK-91)', () => {
  it('holds the design’s 188 px while the centred column leaves room', () => {
    expect(noteWidth(1440, 640)).toBe(188);
    expect(noteWidth(1280, 640)).toBe(188);
    expect(noteWidth(1100, 640)).toBe(166);
  });

  it('gives the channel itself at the 1024 step, and never a negative width', () => {
    // (1024 − 640) / 2 = 192 of channel, minus the 56 px gap and 8 px of air. The narrower
    // 622 px column (below 1024) would leave 137 of channel — still a margin, and still not
    // painted: the note is the desktop object.
    expect(noteWidth(1024, 640)).toBe(128);
    expect(noteWidth(1024, 622)).toBeCloseTo(137, 6);
    expect(noteWidth(390, 622)).toBe(0);
  });

  it('answers 0 — not a floor-forced width — under the 120 px floor', () => {
    // 900 and 768 leave 75 and 9 px of channel on the 622 px column: the paragraph is a strip,
    // and a 120 px note there would be wider than the channel it stands in.
    expect(noteWidth(900, 622)).toBe(0);
    expect(noteWidth(768, 622)).toBe(0);
    expect(noteWidth(390, 622)).toBe(0);
    // The floor is read from the root: a page that states its own floor is obeyed.
    expect(noteWidth(900, 622, NOTE_GAP, 188, 8, 60)).toBe(75);
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

  it('counts a tall item as an item of the same pass', () => {
    const closed = placeMargin([{ anchorTop: 100, height: 96 }, { anchorTop: 250, height: 96 }], STEP, 1_000);
    const opened = placeMargin([{ anchorTop: 100, height: 300 }, { anchorTop: 250, height: 96 }], STEP, 1_000);
    expect(closed.tops[1]).toBe(250);
    expect(opened.tops[1]).toBe(412);
  });
});
