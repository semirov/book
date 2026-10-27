// @vitest-environment jsdom
import { chapterStartPages, PAGE_CHARS, totalPages, type ChapterLength } from '@book/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANCHOR_EPS,
  atDocumentEnd,
  chapterAt,
  charsInBlocks,
  headOffset,
  LINE_CHARS,
  readingAt,
  readingLine,
  steadyPosition,
  type BlockSpan,
  type SlotSpan,
} from './pageTrack.ts';

/**
 * BOOK-104 — the page model, pure: one line at the head's edge decides the chapter, the
 * catalogue's own `chars` decide the page. The hook's half (scroll, rects, state) lives in
 * `useReading.dom.test.ts`.
 */

describe('readingLine', () => {
  it('sits at the head’s offset plus the anchor’s rounding: 66 at the 64 px fallback', () => {
    expect(readingLine(64)).toBe(64 + ANCHOR_EPS);
    expect(readingLine(64)).toBe(66);
    expect(readingLine(80)).toBe(82);
  });

  it('falls back to the 64 px head, never to a negative or a fractions-of-nothing line', () => {
    expect(readingLine(Number.NaN)).toBe(66);
    expect(readingLine(0)).toBe(66);
    expect(readingLine(-40)).toBe(66);
  });
});

describe('headOffset', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the sheet’s own --offset-top', () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '80px' }));
    expect(headOffset()).toBe(80);
  });

  it('keeps 64 when the token cannot be read', () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    expect(headOffset()).toBe(64);
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'auto' }));
    expect(headOffset()).toBe(64);
  });
});

describe('chapterAt', () => {
  // The measured defect (BOOK-104): an empty chapter is ~90 px and the old band started at
  // the head's offset, so ch20's last pixel named ch20 while the reader was in ch21.
  const slots: SlotSpan[] = [
    { n: 20, top: 5, bottom: 65 },
    { n: 21, top: 65, bottom: 125 },
  ];

  it('is half-open: the line on a boundary belongs to the chapter that starts there', () => {
    expect(chapterAt(slots, 4)).toBeNull();
    expect(chapterAt(slots, 5)).toBe(20);
    expect(chapterAt(slots, 64.9)).toBe(20);
    expect(chapterAt(slots, 65)).toBe(21);
    expect(chapterAt(slots, 66)).toBe(21);
    expect(chapterAt(slots, 124)).toBe(21);
  });

  it('names the anchor’s line where the old band named the chapter above it', () => {
    expect(chapterAt(slots, 64)).toBe(20); // the bug, stated: the head's offset is still ch20
    expect(chapterAt(slots, 66)).toBe(21); // the line 64 + eps is ch21, which is what #ch-21 asks
  });

  it('is null above the first slot and below the last', () => {
    expect(chapterAt(slots, -1)).toBeNull();
    expect(chapterAt(slots, Number.NEGATIVE_INFINITY)).toBeNull();
    expect(chapterAt(slots, 125)).toBeNull();
    expect(chapterAt(slots, 9_999)).toBeNull();
    expect(chapterAt([], 66)).toBeNull();
  });

  it('is null in a gap between slots: no article contains the line', () => {
    expect(chapterAt([{ n: 1, top: 0, bottom: 10 }, { n: 2, top: 20, bottom: 30 }], 15)).toBeNull();
  });
});

describe('charsInBlocks', () => {
  const spans: BlockSpan[] = [
    { top: 0, bottom: 100, chars: 900 },
    { top: 100, bottom: 300, chars: 1800 },
  ];

  it('counts nothing above the first block and everything below the last', () => {
    expect(charsInBlocks(spans, -10, 2700)).toBe(0);
    expect(charsInBlocks(spans, 0, 2700)).toBe(0);
    expect(charsInBlocks(spans, 300, 2700)).toBe(2700);
    expect(charsInBlocks(spans, 9_999, 2700)).toBe(2700);
  });

  it('interpolates inside a block from its own share of the chapter', () => {
    expect(charsInBlocks(spans, 50, 2700)).toBe(450);
    expect(charsInBlocks(spans, 200, 2700)).toBe(900 + 900);
    expect(charsInBlocks(spans, 299, 2700)).toBe(900 + 1791);
  });

  it('treats a broken character count as no prose', () => {
    const broken: BlockSpan[] = [
      { top: 0, bottom: 100, chars: 0 },
      { top: 100, bottom: 200, chars: Number.NaN },
    ];
    expect(charsInBlocks(broken, 50, 3600)).toBe(0);
    expect(charsInBlocks(broken, 150, 3600)).toBe(0);
    expect(charsInBlocks(broken, 250, 3600)).toBe(3600);
  });

  it('is zero for a chapter with no blocks — the prose has not arrived', () => {
    expect(charsInBlocks([], 400, 2700)).toBe(0);
    expect(charsInBlocks([], 400, 0)).toBe(0);
  });

  it('clamps into the chapter and never decreases as the line moves down', () => {
    let previous = -1;
    for (let line = -50; line <= 350; line += 1) {
      const value = charsInBlocks(spans, line, 2700);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2700);
      previous = value;
    }
    // A chapter shorter than the blocks claim is still only its own length.
    expect(charsInBlocks(spans, 999, 1000)).toBe(1000);
    expect(charsInBlocks(spans, 999, 0)).toBe(0);
  });
});

describe('steadyPosition', () => {
  it('commits the first measurement and a chapter change at once', () => {
    const first = { n: 1, chars: 10 };
    expect(steadyPosition(null, first)).toEqual(first);
    expect(steadyPosition({ n: 1, chars: 1_799 }, { n: 2, chars: 0 })).toEqual({ n: 2, chars: 0 });
  });

  it('holds a move under one line and commits a move past it', () => {
    const previous = { n: 1, chars: 1_800 };
    expect(steadyPosition(previous, { n: 1, chars: 1_800 + LINE_CHARS - 1 })).toBe(previous);
    expect(steadyPosition(previous, { n: 1, chars: 1_800 - LINE_CHARS + 1 })).toBe(previous);
    expect(steadyPosition(previous, { n: 1, chars: 1_800 + LINE_CHARS })).toEqual({ n: 1, chars: 1_800 + LINE_CHARS });
  });

  it('falls back to one line when the tolerance is not a positive number', () => {
    const previous = { n: 1, chars: 1_800 };
    expect(steadyPosition(previous, { n: 1, chars: 1_801 }, 0)).toBe(previous);
    expect(steadyPosition(previous, { n: 1, chars: 1_801 }, Number.NaN)).toBe(previous);
  });

  it('never flashes on a jitter of ±30 characters around a page boundary', () => {
    const boundary = PAGE_CHARS;
    let position = steadyPosition(null, { n: 1, chars: boundary - 10 });
    const first = position;
    for (const chars of [boundary + 20, boundary - 30, boundary + 5]) {
      position = steadyPosition(position, { n: 1, chars });
      expect(position).toBe(first);
    }
  });
});

/** The slots an all-empty book has: one 90 px row per chapter, laid end to end. */
function emptySlots(count: number, top = 500, height = 90): SlotSpan[] {
  return Array.from({ length: count }, (_, index) => ({
    n: index + 1,
    top: top + index * height,
    bottom: top + (index + 1) * height,
  }));
}

function spansByChapter(map: Record<number, BlockSpan[]>): (n: number) => readonly BlockSpan[] {
  return (n) => map[n] ?? [];
}

describe('atDocumentEnd', () => {
  it('is the page’s last pixel, and only where the page can scroll at all', () => {
    expect(atDocumentEnd(1_000, 900, 1_900)).toBe(true); // 1900 ≥ 1899
    expect(atDocumentEnd(999, 900, 1_900)).toBe(true); // one pixel short still counts
    expect(atDocumentEnd(998, 900, 1_900)).toBe(false);
    // A document shorter than the viewport has no end to reach, and an unlaid-out one (jsdom)
    // reports 0 — neither is the end of the book.
    expect(atDocumentEnd(0, 900, 900)).toBe(false);
    expect(atDocumentEnd(0, 900, 0)).toBe(false);
    expect(atDocumentEnd(Number.NaN, 900, 1_900)).toBe(false);
    expect(atDocumentEnd(1_000, Number.NaN, 1_900)).toBe(false);
    expect(atDocumentEnd(1_000, 900, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('readingAt', () => {
  it('prints the slot number as the page on an all-empty 67-slot book: one page per chapter', () => {
    const catalog: ChapterLength[] = Array.from({ length: 67 }, (_, index) => ({ n: index + 1, chars: 0 }));
    const slots = emptySlots(67);
    for (const slot of slots) {
      const reading = readingAt(catalog, slots, slot.top + ANCHOR_EPS, spansByChapter({}));
      expect(reading?.n).toBe(slot.n);
      // The contents counts the same characters, so the folio *is* the contents' number.
      expect(reading?.page).toBe(slot.n);
    }
    // Nothing above the first slot and nothing below the last.
    expect(readingAt(catalog, slots, 499, spansByChapter({}))).toBeNull();
    expect(readingAt(catalog, slots, 500 + 67 * 90, spansByChapter({}))).toBeNull();
  });

  it('pages a written chapter from its own prose: start + floor(chars / PAGE_CHARS), clamped', () => {
    const catalog: ChapterLength[] = [
      { n: 1, chars: 2 * PAGE_CHARS },
      { n: 2, chars: 0 },
    ];
    const slots: SlotSpan[] = [
      { n: 1, top: 0, bottom: 600 },
      { n: 2, top: 600, bottom: 690 },
    ];
    const blocks = spansByChapter({ 1: [{ top: 0, bottom: 600, chars: 2 * PAGE_CHARS }] });

    expect(readingAt(catalog, slots, 0, blocks)).toEqual({ n: 1, chars: 0, page: 1 });
    expect(readingAt(catalog, slots, 300, blocks)).toEqual({ n: 1, chars: PAGE_CHARS, page: 2 });
    // Below the last block of the chapter the count is the chapter's own length, clamped to
    // its own last page — never a page the chapter does not have.
    expect(readingAt(catalog, slots, 599, blocks)).toEqual({ n: 1, chars: 3_594, page: 2 });
    // An empty chapter opens its own start page: ch02 starts on page 3.
    expect(readingAt(catalog, slots, 600, spansByChapter({}))).toEqual({ n: 2, chars: 0, page: 3 });
  });

  it('treats a chapter absent from the catalog as an empty chapter, not a crash', () => {
    const catalog: ChapterLength[] = [
      { n: 1, chars: 2 * PAGE_CHARS },
      { n: 2, chars: 1_800 },
    ];
    const slots: SlotSpan[] = [{ n: 9, top: 0, bottom: 90 }];
    expect(readingAt(catalog, slots, 2, spansByChapter({}))).toEqual({
      n: 9,
      chars: 0,
      page: chapterStartPages(catalog).get(9),
    });
  });

  it('ends the book at the document’s end: the last chapter, on its own last page', () => {
    const catalog: ChapterLength[] = Array.from({ length: 67 }, (_, index) => ({ n: index + 1, chars: 0 }));
    const slots = emptySlots(67);
    const line = slots[59]!.top + ANCHOR_EPS; // inside ch60: what `#ch-67` really leaves

    // Without the end rule the line names the chapter it is in — the reported defect.
    expect(readingAt(catalog, slots, line, spansByChapter({}))?.n).toBe(60);

    // At the end of the document the last chapter owns the reader, and its page is the page
    // the contents prints: an empty chapter's last page is its start page.
    const end = readingAt(catalog, slots, line, spansByChapter({}), null, true);
    expect(end).toEqual({ n: 67, chars: 0, page: 67 });
    expect(end?.page).toBe(chapterStartPages(catalog).get(67));

    // Without any slot there is no chapter to end on.
    expect(readingAt(catalog, [], line, spansByChapter({}), null, true)).toBeNull();
  });

  it('prints a written last chapter’s last page at the end, never its start', () => {
    const catalog: ChapterLength[] = Array.from({ length: 67 }, (_, index) => ({ n: index + 1, chars: 0 }));
    catalog[66] = { n: 67, chars: 2 * PAGE_CHARS };
    const slots = emptySlots(67);

    const end = readingAt(catalog, slots, slots[10]!.top, spansByChapter({}), null, true);
    expect(end?.n).toBe(67);
    // `pageAt` over the chapter's full length is the book's last page — no second arithmetic.
    expect(end?.page).toBe(totalPages(catalog));
  });

  it('steadies the page against the previous position, never the chapter', () => {
    const catalog: ChapterLength[] = [{ n: 1, chars: 2 * PAGE_CHARS }];
    const slots: SlotSpan[] = [{ n: 1, top: 0, bottom: 600 }];
    const blocks = spansByChapter({ 1: [{ top: 0, bottom: 600, chars: 2 * PAGE_CHARS }] });
    const committed = { n: 1, chars: PAGE_CHARS, page: 2 };

    // 24 characters under a page boundary: less than one line, so the page holds.
    expect(readingAt(catalog, slots, 296, blocks, committed)).toEqual({ n: 1, chars: PAGE_CHARS, page: 2 });
    // A chapter opening is never steadied: at 600 the line is in no chapter at all.
    expect(readingAt(catalog, slots, 600, blocks, committed)).toBeNull();
  });
});
