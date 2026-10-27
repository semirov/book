/**
 * The reader's running page (BOOK-89, D2/D3): the folio in the margin, and the maths behind
 * it. A page is never stored and never comes from the protocol — it is projected, on every
 * flip, from the characters the reader has passed and the catalog's own `chars`.
 *
 * Two layers live here:
 *
 *   - the pure arithmetic (`readingLineY`, `charsInBlocks`, `steadyPosition`) — it takes
 *     geometry as plain numbers, so it is testable with no browser and no layout;
 *   - `useRunningPage(catalog)` — the glue: one passive `scroll` listener, one
 *     `requestAnimationFrame` per frame, `setState` only when the page actually flips.
 *
 * The number is honest by construction: a chapter's prose is measured only through
 * `[data-block-id][data-chars]` rects, and a chapter whose prose has not arrived has no
 * blocks at all — its folio reads the catalog's start page instead of guessing inside it.
 * The chapter is found by walking the article rects from the last chapter seen, so a
 * chapter that grows above the reader shifts every later article without a stale cache.
 */

import { PAGE_CHARS, pageAt, type ChapterLength } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

/**
 * One line of prose: `PAGE_CHARS` over the 27 lines a page holds ≈ 67 characters. This is the
 * hysteresis the folio needs — a boundary that flickers under sub-line jitter is not a page
 * number but a strobe.
 */
export const LINE_CHARS = Math.round(PAGE_CHARS / 27);

/**
 * The reading line: upper-middle of the viewport, always clear of the sticky head (96px
 * above) and of the bottom edge (96px below). `clamp(0.4·h, 96, h − 96)` as a function.
 */
export function readingLineY(viewportHeight: number): number {
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  return Math.max(96, Math.min(0.4 * height, height - 96));
}

/** One measured block in document coordinates: where it sits and how much prose it carries. */
export type BlockSpan = { top: number; bottom: number; chars: number };

/**
 * Characters of a chapter above the reading line. Above the first block: 0; inside a block:
 * everything before it plus the fraction of the block already passed; below the last one: the
 * chapter's full length, so the folio always holds the chapter's own last page. Never
 * decreasing in `lineY`, and clamped into `[0, chapterChars]`.
 */
export function charsInBlocks(spans: readonly BlockSpan[], lineY: number, chapterChars: number): number {
  const total = Number.isFinite(chapterChars) && chapterChars > 0 ? chapterChars : 0;
  if (spans.length === 0) return 0;
  let before = 0;
  for (const span of spans) {
    const chars = Number.isFinite(span.chars) && span.chars > 0 ? span.chars : 0;
    if (lineY <= span.top) return Math.min(before, total);
    if (lineY < span.bottom) {
      // The guards make `bottom > top` here, so the fraction is always a real one.
      const passed = Math.floor(((lineY - span.top) / (span.bottom - span.top)) * chars);
      return Math.min(Math.max(0, before + passed), total);
    }
    before += chars;
  }
  return total;
}

/** A committed reading position: the chapter the reader is in and how far into it. */
export type ReadingPosition = { n: number; chars: number };

/**
 * Hysteresis (one line of prose): a chapter change commits at once — a chapter always opens
 * a page — while a move under `tolerance` characters inside the same chapter keeps the
 * committed position. Returns `previous` itself when nothing is committed, so a caller can
 * compare references and skip all work on a jittering frame.
 */
export function steadyPosition(
  previous: ReadingPosition | null,
  measured: ReadingPosition | null,
  tolerance: number = LINE_CHARS,
): ReadingPosition | null {
  if (measured === null) return null;
  if (previous === null) return measured;
  if (previous.n !== measured.n) return measured;
  const limit = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : LINE_CHARS;
  if (Math.abs(measured.chars - previous.chars) < limit) return previous;
  return measured;
}

/** The chapter's rect and blocks in document coordinates, with the cache's identity. */
type ChapterGeometry = { top: number; height: number; rev: string | null; spans: BlockSpan[] };

/** A block's own prose length; a missing or broken attribute counts as no prose. */
function spanChars(element: Element): number {
  const raw = Number(element.getAttribute('data-chars') ?? '0');
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Document coordinates: the rect a reader scrolls past, not the rect on screen. */
function documentRect(element: Element): { top: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { top: rect.top + window.scrollY, height: rect.height };
}

/**
 * The page at the reading line, derived from the DOM this page already renders. Returns
 * `null` where no chapter owns the line — the cover, page 2, the contents, the end matter:
 * a number appears only where a page exists.
 *
 * Cost per frame: one chapter located by walking rects from the previous one (a scroll
 * usually moves by zero or one article), and that chapter's blocks measured only when its
 * own box changed. The 67 articles are never all measured, and no block outside the chapter
 * the reader is in is touched.
 */
export function useRunningPage(catalog: readonly ChapterLength[]): number | null {
  const [page, setPage] = useState<number | null>(null);
  const position = useRef<ReadingPosition | null>(null);
  /** The number the page is showing; a move that does not flip it writes no state. */
  const shown = useRef<number | null>(null);
  const cache = useRef(new Map<number, ChapterGeometry>());

  useEffect(() => {
    // A revision (a new catalog) invalidates every measured box: `resize` and the revision
    // itself are the only two events that can move prose the reader did not scroll past.
    cache.current.clear();
    const articles = [...document.querySelectorAll<HTMLElement>('article[data-n]')];
    if (articles.length === 0) return undefined;

    let frame = 0;
    let hint = 0;
    let lastScroll = Number.NaN;
    const charsOf = new Map(catalog.map((chapter) => [chapter.n, chapter.chars]));

    const geometry = (article: HTMLElement, n: number): ChapterGeometry => {
      const box = documentRect(article);
      const rev = article.getAttribute('data-rev');
      const cached = cache.current.get(n);
      if (cached !== undefined && cached.top === box.top && cached.height === box.height && cached.rev === rev) {
        return cached;
      }
      const spans = [...article.querySelectorAll<HTMLElement>('[data-block-id]')].map((block) => {
        const rect = documentRect(block);
        return { top: rect.top, bottom: rect.top + rect.height, chars: spanChars(block) };
      });
      const measured = { top: box.top, height: box.height, rev, spans };
      cache.current.set(n, measured);
      return measured;
    };

    /** The article under the line; `null` above the first chapter or below the last. */
    const chapterAt = (line: number): HTMLElement | null => {
      let index = Math.min(Math.max(hint, 0), articles.length - 1);
      let box = documentRect(articles[index] as HTMLElement);
      while (line < box.top) {
        if (index === 0) return null;
        index -= 1;
        box = documentRect(articles[index] as HTMLElement);
      }
      while (line >= box.top + box.height) {
        if (index === articles.length - 1) return null;
        index += 1;
        box = documentRect(articles[index] as HTMLElement);
      }
      hint = index;
      return articles[index] ?? null;
    };

    /** One frame: measure, steady the position, and write state only when the page flips. */
    const measure = (): void => {
      frame = 0;
      const scroll = window.scrollY;
      if (scroll === lastScroll) return;
      lastScroll = scroll;

      const line = scroll + readingLineY(window.innerHeight);
      const article = chapterAt(line);
      if (article === null) {
        if (position.current === null) return;
        position.current = null;
        shown.current = null;
        setPage(null);
        return;
      }

      const n = Number(article.getAttribute('data-n'));
      const chars = charsOf.get(n) ?? 0;
      const charsInto = charsInBlocks(geometry(article, n).spans, line, chars);
      const next = steadyPosition(position.current, { n, chars: charsInto });
      if (next === position.current) return;
      position.current = next;
      const value = next === null ? null : pageAt(catalog, next.n, next.chars);
      // The position may move past the hysteresis while the page stays the same: that is not
      // a flip, and nothing re-renders for it.
      if (value === shown.current) return;
      shown.current = value;
      setPage(value);
    };

    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    const onResize = (): void => {
      cache.current.clear();
      lastScroll = Number.NaN;
      schedule();
    };

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', onResize);
    schedule();
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [catalog]);

  return page;
}
