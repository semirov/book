/**
 * The reader's place (BOOK-89 D2/D3, BOOK-104): one chapter, one page, one model.
 *
 * A page is never stored and never comes from the protocol — it is projected from the
 * catalogue's own `chars` and the characters the reader has passed. The chapter and the
 * number are therefore the same arithmetic the contents uses (`pageAt` over one catalog), so
 * the running head cannot name a chapter the contents call page 21 when it says 20.
 *
 * **One line decides both.** It sits at the top of the reading area — the head's own offset
 * plus `ANCHOR_EPS` — not at some fraction of the viewport: `scroll-margin-top` lands an
 * anchor target at `--offset-top`, but a device pixel of rounding can leave it a pixel lower,
 * and a line drawn exactly at the head's offset would then still name the previous chapter.
 * Two pixels is that rounding, not a threshold. A chapter opens a page at its first pixel, so
 * the chapter changes at once — no hysteresis; the page keeps one line of it.
 *
 * The one exception is the document's end: nothing lies below the last chapter, so `#ch-42`
 * leaves it mid-screen with the line still inside ch35. A reader who has reached the end of
 * the book is reading its end — the last chapter, on that chapter's last page.
 *
 * Two layers live here:
 *
 *   - the pure arithmetic (`readingLine`, `chapterAt`, `charsInBlocks`, `steadyPosition`,
 *     `atDocumentEnd`, `readingAt`) — geometry in, numbers out, no browser and no layout;
 *   - `useReading(catalog)` — the glue: one passive `scroll` listener, one
 *     `requestAnimationFrame` per frame, a chapter's blocks measured once per box, and state
 *     written only when `{ n, page }` actually changes.
 *
 * The head's offset is **not** a number of its own: the reading line reads `offsetTopOfPage()`
 * from `headerOffset.ts`, the same measurement a contents tap and a `#ch-N` jump land on, so the
 * line and the anchor cannot disagree about where the head ends.
 */

import { PAGE_CHARS, pageAt, type ChapterLength } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { offsetOf, offsetTopOfPage } from './headerOffset.ts';

/**
 * One line of prose: `PAGE_CHARS` over the 27 lines a page holds ≈ 67 characters. This is the
 * hysteresis the folio needs — a boundary that flickers under sub-line jitter is not a page
 * number but a strobe. It steadies the page inside a chapter; it never delays a chapter.
 */
export const LINE_CHARS = Math.round(PAGE_CHARS / 27);

/**
 * The head's offset plus this is the reading line. `scroll-margin-top` lands an anchor target
 * at `--offset-top`, but a device pixel of rounding can leave it a pixel lower, and a line
 * drawn exactly at the head's offset would then still name the previous chapter; 2 px is that
 * rounding, not a threshold (BOOK-104).
 */
export const ANCHOR_EPS = 2;

/**
 * The head's offset — the one measurement `headerOffset.ts` writes on the page and a jump lands
 * on. There is no second number here: the fallback for a page the hook has not measured is the
 * same function's fallback (the head's own height plus the breathing space), and a headless
 * environment has no head at all.
 */
export function headOffset(): number {
  return typeof document === 'undefined' ? offsetOf(0) : offsetTopOfPage(document);
}

/** The reading line, measured from the top of the viewport: the head, plus the anchor's eps. */
export function readingLine(offset: number): number {
  const head = Number.isFinite(offset) && offset > 0 ? offset : headOffset();
  return head + ANCHOR_EPS;
}

/** One chapter slot in document coordinates: where it starts and where it ends. */
export type SlotSpan = { n: number; top: number; bottom: number };

/**
 * The chapter the line is in — half-open `[top, bottom)`, so a line exactly on a boundary
 * belongs to the chapter that starts there, which is what an anchor asks for. Null above the
 * first slot, in a gap between slots and below the last: the cover, the contents and the end
 * matter are not chapters, and a line in none of them names none.
 */
export function chapterAt(slots: readonly SlotSpan[], line: number): number | null {
  for (const slot of slots) {
    if (line < slot.top) return null;
    if (line < slot.bottom) return slot.n;
  }
  return null;
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

/** The reader's place: the chapter, how far into it, and the page the contents calls that. */
export type Reading = ReadingPosition & { page: number };

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

/** The chapter's own prose length, from the catalogue; a broken count is an empty chapter. */
function chapterChars(catalog: readonly ChapterLength[], n: number): number {
  const chars = catalog.find((chapter) => chapter.n === n)?.chars ?? 0;
  return Number.isFinite(chars) && chars > 0 ? chars : 0;
}

/**
 * Has the reader reached the end of the page? `scrollY + innerHeight >= scrollHeight − 1`,
 * and only where there is something to scroll: a document shorter than the viewport has no
 * end to reach (and a layout-less test environment reports 0).
 */
export function atDocumentEnd(scroll: number, viewportHeight: number, scrollHeight: number): boolean {
  if (!Number.isFinite(scroll) || !Number.isFinite(viewportHeight) || !Number.isFinite(scrollHeight)) return false;
  if (scrollHeight <= viewportHeight) return false;
  return scroll + viewportHeight >= scrollHeight - 1;
}

/**
 * The place at the line, from measured geometry: the chapter half-open under it and the
 * characters of that chapter the reader has passed. Null where no chapter owns the line.
 *
 * At the end of the document the last chapter owns the reader (BOOK-104): nothing lies below
 * it, so its top can never reach the line — `#ch-42` scrolls to the document's end and leaves
 * the last slot around mid-screen, with the line still inside ch35. A reader who has scrolled
 * to the end of the book is reading its end, and the page there is that chapter's last one.
 */
function measuredReading(
  catalog: readonly ChapterLength[],
  slots: readonly SlotSpan[],
  line: number,
  spansOf: (n: number) => readonly BlockSpan[],
  atEnd: boolean,
): ReadingPosition | null {
  if (atEnd) {
    const last = slots.at(-1);
    if (last === undefined) return null;
    return { n: last.n, chars: chapterChars(catalog, last.n) };
  }
  const n = chapterAt(slots, line);
  if (n === null) return null;
  return { n, chars: charsInBlocks(spansOf(n), line, chapterChars(catalog, n)) };
}

/**
 * The whole page model over measured geometry: the chapter under the line, its characters
 * steadied against `previous` (one line inside the chapter, none across it), and the page the
 * contents prints for that chapter and those characters. An empty chapter has no blocks, so
 * its page is exactly the chapter's start page — the contents' own number. At the document's
 * end (`atEnd`) the last chapter and its last page stand in for the line.
 */
export function readingAt(
  catalog: readonly ChapterLength[],
  slots: readonly SlotSpan[],
  line: number,
  spansOf: (n: number) => readonly BlockSpan[],
  previous: ReadingPosition | null = null,
  atEnd = false,
): Reading | null {
  const position = steadyPosition(previous, measuredReading(catalog, slots, line, spansOf, atEnd));
  if (position === null) return null;
  return { n: position.n, chars: position.chars, page: pageAt(catalog, position.n, position.chars) };
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
 * The chapter and the page at the reading line, derived from the DOM this page already
 * renders. The chapter is `null` where none owns the line — the cover, page 2, the contents,
 * the end matter: a number appears only where a page exists.
 *
 * Mounted once, next to the head. Cost per frame: one rect per slot (42 numbers on a clean
 * layout) and the blocks of one chapter, measured only when that chapter's own box changed.
 * No block outside the chapter the reader is in is measured, and the pair is committed only
 * when the chapter or the page moved.
 */
export function useReading(catalog: readonly ChapterLength[]): { n: number | null; page: number | null } {
  const [reading, setReading] = useState<{ n: number | null; page: number | null }>({ n: null, page: null });
  /** The steadied position; the hysteresis compares against it, not against the last frame. */
  const position = useRef<Reading | null>(null);
  /** What is on the page; a move that changes neither number writes no state. */
  const shown = useRef<{ n: number | null; page: number | null }>({ n: null, page: null });
  const cache = useRef(new Map<number, ChapterGeometry>());

  useEffect(() => {
    // A revision (a new catalog) invalidates every measured box: `resize` and the revision
    // itself are the only two events that can move prose the reader did not scroll past.
    cache.current.clear();
    const articles = [...document.querySelectorAll<HTMLElement>('article[data-n]')];
    const byNumber = new Map(articles.map((article) => [Number(article.dataset.n), article]));

    const commit = (next: Reading | null): void => {
      position.current = next;
      const n = next?.n ?? null;
      const page = next?.page ?? null;
      if (shown.current.n === n && shown.current.page === page) return;
      shown.current = { n, page };
      setReading(shown.current);
    };

    if (articles.length === 0) {
      commit(null);
      return undefined;
    }

    let frame = 0;
    let lastScroll = Number.NaN;
    /** The head's own token: re-read on resize, when the sheet steps to another width. */
    let head = headOffset();

    const slots = (): SlotSpan[] =>
      articles.map((article) => {
        const box = documentRect(article);
        return { n: Number(article.dataset.n), top: box.top, bottom: box.top + box.height };
      });

    const spansOf = (n: number): readonly BlockSpan[] => {
      const article = byNumber.get(n);
      if (article === undefined) return [];
      const box = documentRect(article);
      const rev = article.getAttribute('data-rev');
      const cached = cache.current.get(n);
      if (cached !== undefined && cached.top === box.top && cached.height === box.height && cached.rev === rev) {
        return cached.spans;
      }
      const spans = [...article.querySelectorAll<HTMLElement>('[data-block-id]')].map((block) => {
        const rect = documentRect(block);
        return { top: rect.top, bottom: rect.top + rect.height, chars: spanChars(block) };
      });
      cache.current.set(n, { top: box.top, height: box.height, rev, spans });
      return spans;
    };

    /** One frame: measure the slots, resolve the place, and commit only a real move. */
    const measure = (): void => {
      frame = 0;
      const scroll = window.scrollY;
      if (scroll === lastScroll) return;
      lastScroll = scroll;
      // At the document's end the line cannot climb into the last chapter (BOOK-104), so the
      // end of the page is its own reading: the last slot and that chapter's last page.
      const atEnd = atDocumentEnd(scroll, window.innerHeight, document.documentElement.scrollHeight);
      commit(readingAt(catalog, slots(), scroll + readingLine(head), spansOf, position.current, atEnd));
    };

    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    const onResize = (): void => {
      cache.current.clear();
      head = headOffset();
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

  return reading;
}
