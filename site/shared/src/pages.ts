/**
 * Virtual pagination (BOOK-89): a page is a projection of the text, never a stored field.
 *
 * One page is `PAGE_CHARS` characters of prose — `book.ts` owns the constant and the
 * arithmetic behind it. Every chapter opens a page, and a slot with nothing written yet is
 * one page rather than zero: otherwise a 67-chapter book would print «1» sixty-seven times.
 * So `ch01` is always page 1 (the cover, page 2 and the contents are unnumbered) and a
 * chapter that grows past a page pushes every following start by exactly one.
 *
 * This module is the only arithmetic: the table of contents (`web/src/lib/toc.ts`) and the
 * reader's running folio (`web/src/lib/pageTrack.ts`) both call `chapterStartPages` over the
 * same catalog, so they cannot disagree. `ChapterLength` is structural — `CatalogEntry`
 * satisfies it without an import, so the model never depends on pagination.
 *
 * Pure: no DOM, no clock, no platform.
 */

import { PAGE_CHARS, TOTAL_CHAPTERS } from './book.ts';

/** What a chapter needs to be paginated: its number and its prose length. */
export type ChapterLength = { n: number; chars: number };

/** A resolved page: the chapter that owns it and the character offset it starts at. */
export type PageAnchor = { n: number; charsInto: number };

/** A prose length that is not a positive finite number is an empty chapter, not a crash. */
function proseChars(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? chars : 0;
}

/** A chapter number outside the book is clamped into it: there is nothing else to page. */
function chapterNumber(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(TOTAL_CHAPTERS, Math.max(1, Math.trunc(n)));
}

/** Pages a chapter occupies: `ceil(chars / PAGE_CHARS)`, and never fewer than one. */
export function pagesInChapter(chars: number): number {
  return Math.max(1, Math.ceil(proseChars(chars) / PAGE_CHARS));
}

/** The page, counted from 0 characters into a chapter: `floor(charsInto / PAGE_CHARS) + 1`. */
export function pageInChapter(charsInto: number): number {
  if (!Number.isFinite(charsInto) || charsInto <= 0) return 1;
  return Math.floor(charsInto / PAGE_CHARS) + 1;
}

/** Character counts and start pages, indexed by chapter number (1..TOTAL_CHAPTERS). */
type Pagination = { chars: number[]; starts: number[] };

/**
 * The book's two tables, indexed by chapter number. A chapter absent from the catalog counts
 * as an empty chapter — one page — because every number the book has is 1..67
 * (`TOTAL_CHAPTERS`), written or not; an entry outside that range is not a chapter.
 */
function paginate(lengths: readonly ChapterLength[]): Pagination {
  const chars = new Array<number>(TOTAL_CHAPTERS + 1).fill(0);
  for (const length of lengths) {
    const n = Math.trunc(length.n);
    if (n >= 1 && n <= TOTAL_CHAPTERS) chars[n] = proseChars(length.chars);
  }
  const starts = new Array<number>(TOTAL_CHAPTERS + 1).fill(1);
  let page = 1;
  for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
    starts[n] = page;
    page += pagesInChapter(chars[n]!);
  }
  return { chars, starts };
}

/**
 * The start page of every chapter: ch01 is 1, and each following start is the previous one
 * plus the pages the previous chapter occupies. A sparse catalog still yields all 67 rows.
 */
export function chapterStartPages(lengths: readonly ChapterLength[]): ReadonlyMap<number, number> {
  const { starts } = paginate(lengths);
  return new Map(Array.from({ length: TOTAL_CHAPTERS }, (_, index) => [index + 1, starts[index + 1]!] as const));
}

/** The last page of the book: the last chapter's start plus its own pages, minus one. */
export function totalPages(lengths: readonly ChapterLength[]): number {
  const { starts, chars } = paginate(lengths);
  return starts[TOTAL_CHAPTERS]! + pagesInChapter(chars[TOTAL_CHAPTERS]!) - 1;
}

/**
 * The absolute page at `charsInto` characters into chapter `n`. The result never leaves the
 * chapter: the running folio may advance imprecisely inside a chapter whose prose is not
 * loaded, but a number always belongs to the chapter the reader is in.
 */
export function pageAt(lengths: readonly ChapterLength[], n: number, charsInto: number): number {
  const { starts, chars } = paginate(lengths);
  const chapter = chapterNumber(n);
  return starts[chapter]! + Math.min(pageInChapter(charsInto), pagesInChapter(chars[chapter]!)) - 1;
}

/**
 * The inverse (BOOK-91): which chapter a page belongs to and the character offset it opens
 * at. Null outside the book — page 1..`totalPages`. A page inside an empty chapter resolves
 * to offset 0, the only offset that chapter has.
 */
export function resolvePage(lengths: readonly ChapterLength[], page: number): PageAnchor | null {
  if (!Number.isInteger(page) || page < 1) return null;
  const { starts, chars } = paginate(lengths);
  for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
    const start = starts[n]!;
    if (page < start + pagesInChapter(chars[n]!)) return { n, charsInto: (page - start) * PAGE_CHARS };
  }
  return null;
}
