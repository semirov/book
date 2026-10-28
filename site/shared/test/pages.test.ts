import { BOOK_CHARS, PAGE_CHARS, TOTAL_CHAPTERS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  chapterStartPages,
  pageAt,
  pageInChapter,
  pagesInChapter,
  resolvePage,
  totalPages,
  type ChapterLength,
} from '../src/pages.ts';

/** The book's slots with no prose: the state a book with only its frame chapters is in. */
const emptyBook = (): ChapterLength[] => Array.from({ length: TOTAL_CHAPTERS }, (_, index) => ({ n: index + 1, chars: 0 }));

/** A book where one chapter has grown to `chars`. */
function bookWith(n: number, chars: number): ChapterLength[] {
  return emptyBook().map((chapter) => (chapter.n === n ? { ...chapter, chars } : chapter));
}

describe('PAGE_CHARS', () => {
  it('is one A5 page at the book’s own measure: 67 characters × 27 lines', () => {
    expect(PAGE_CHARS).toBe(1800);
    expect(Math.round(PAGE_CHARS / 67)).toBe(27);
  });

  it('reads the book’s length bands in pages', () => {
    // 42 × 1 600 = 67 200 characters → 37 pages; 42 × 30 000 = 1 260 000 → 700 pages.
    expect(Math.round(BOOK_CHARS.min / PAGE_CHARS)).toBe(37);
    expect(Math.round(BOOK_CHARS.max / PAGE_CHARS)).toBe(700);
  });
});

describe('pagesInChapter', () => {
  it('pins the boundaries: 1799 → 1, 1800 → 1, 1801 → 2', () => {
    expect(pagesInChapter(1799)).toBe(1);
    expect(pagesInChapter(1800)).toBe(1);
    expect(pagesInChapter(1801)).toBe(2);
    expect(pagesInChapter(30_000)).toBe(17);
  });

  it('counts an empty, broken or absent length as exactly one page', () => {
    expect(pagesInChapter(0)).toBe(1);
    expect(pagesInChapter(-5)).toBe(1);
    expect(pagesInChapter(Number.NaN)).toBe(1);
    expect(pagesInChapter(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('chapterStartPages', () => {
  it('gives every empty slot one page, so ch01 is page 1', () => {
    const starts = chapterStartPages(emptyBook());
    expect(starts.size).toBe(TOTAL_CHAPTERS);
    for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) expect(starts.get(n)).toBe(n);
  });

  it('still yields every row for a sparse catalog: an absent chapter is one page', () => {
    const starts = chapterStartPages([{ n: 1, chars: 1801 }]);
    expect(starts.size).toBe(TOTAL_CHAPTERS);
    expect(starts.get(1)).toBe(1);
    expect(starts.get(2)).toBe(3);
    expect(starts.get(TOTAL_CHAPTERS)).toBe(TOTAL_CHAPTERS + 1);
  });

  it('ignores an entry that is not a chapter of this book', () => {
    const starts = chapterStartPages([
      { n: 0, chars: 90_000 },
      { n: TOTAL_CHAPTERS + 1, chars: 90_000 },
      { n: 2, chars: 1 },
    ]);
    expect(starts.size).toBe(TOTAL_CHAPTERS);
    expect(starts.get(1)).toBe(1);
    expect(starts.get(2)).toBe(2);
  });

  it('moves ch02 by the pages of ch01: 1800 is one page, 1801 is two', () => {
    expect(chapterStartPages(bookWith(1, 1800)).get(2)).toBe(2);
    expect(chapterStartPages(bookWith(1, 1801)).get(2)).toBe(3);
  });

  it('a chapter that grows pushes every following number and nothing before it', () => {
    const before = chapterStartPages(emptyBook());
    const grown = chapterStartPages(bookWith(5, 1801));
    for (let n = 1; n <= 5; n += 1) expect(grown.get(n)).toBe(before.get(n));
    for (let n = 6; n <= TOTAL_CHAPTERS; n += 1) expect(grown.get(n)).toBe((before.get(n) ?? 0) + 1);
  });
});

describe('pageInChapter', () => {
  it('is the page of a character offset inside its chapter', () => {
    expect(pageInChapter(0)).toBe(1);
    expect(pageInChapter(1799)).toBe(1);
    expect(pageInChapter(1800)).toBe(2);
    expect(pageInChapter(3600)).toBe(3);
  });

  it('never returns a page below one', () => {
    expect(pageInChapter(-1)).toBe(1);
    expect(pageInChapter(Number.NaN)).toBe(1);
  });
});

describe('totalPages', () => {
  it('is the last start plus the last chapter’s pages, minus one', () => {
    expect(totalPages(emptyBook())).toBe(TOTAL_CHAPTERS);
    expect(totalPages(bookWith(TOTAL_CHAPTERS, 1801))).toBe(TOTAL_CHAPTERS + 1);
    expect(totalPages(bookWith(1, 1801))).toBe(TOTAL_CHAPTERS + 1);
  });

  it('stays inside the BOOK_CHARS band in pages', () => {
    const full = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => ({ n: index + 1, chars: BOOK_CHARS.max / TOTAL_CHAPTERS }));
    const pages = totalPages(full);
    // Each chapter is rounded up on its own (14 pages of 1800 for 25 000 characters), so the
    // book can exceed the raw maximum by at most one page per chapter.
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(BOOK_CHARS.min / PAGE_CHARS));
    expect(pages).toBeLessThanOrEqual(Math.ceil(BOOK_CHARS.max / PAGE_CHARS) + TOTAL_CHAPTERS);
  });
});

describe('pageAt', () => {
  it('returns the chapter’s start page at its first character, for every chapter', () => {
    const book = bookWith(3, 5000);
    const starts = chapterStartPages(book);
    for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) expect(pageAt(book, n, 0)).toBe(starts.get(n));
  });

  it('never leaves the chapter it is in, even past the chapter’s own end', () => {
    const book = bookWith(4, 3600); // two pages of 1800; 3601 would be three
    const starts = chapterStartPages(book);
    expect(pageAt(book, 4, 3599)).toBe((starts.get(4) ?? 0) + 1);
    expect(pageAt(book, 4, 100_000)).toBe((starts.get(4) ?? 0) + 1);
  });

  it('clamps a chapter number outside the book into it', () => {
    const book = emptyBook();
    expect(pageAt(book, 0, 0)).toBe(1);
    expect(pageAt(book, 999, 0)).toBe(TOTAL_CHAPTERS);
    expect(pageAt(book, Number.NaN, 0)).toBe(1);
  });
});

describe('resolvePage', () => {
  it('is the inverse of pageAt at every chapter start', () => {
    const book = bookWith(2, 4000);
    const starts = chapterStartPages(book);
    for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
      const start = starts.get(n) ?? 0;
      expect(resolvePage(book, start)).toEqual({ n, charsInto: 0 });
      expect(pageAt(book, n, 0)).toBe(start);
    }
  });

  it('resolves a page inside a chapter to the character offset that opens it', () => {
    const book = bookWith(1, 4000); // ch01: pages 1–3, ch02 starts at 4
    expect(resolvePage(book, 1)).toEqual({ n: 1, charsInto: 0 });
    expect(resolvePage(book, 2)).toEqual({ n: 1, charsInto: PAGE_CHARS });
    expect(resolvePage(book, 3)).toEqual({ n: 1, charsInto: PAGE_CHARS * 2 });
    expect(resolvePage(book, 4)).toEqual({ n: 2, charsInto: 0 });
  });

  it('is null outside the book and for a page that is not a page number', () => {
    const book = emptyBook();
    expect(resolvePage(book, 0)).toBeNull();
    expect(resolvePage(book, TOTAL_CHAPTERS + 1)).toBeNull();
    expect(resolvePage(book, 1.5)).toBeNull();
    expect(resolvePage(book, Number.NaN)).toBeNull();
  });
});
