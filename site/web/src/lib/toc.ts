/**
 * The live table of contents (ARCHITECTURE.md §6C.7, §11.8): four numbered parts of ten
 * chapters each, plus the two frames outside them — chapter 1 opens the book and chapter
 * `TOTAL_CHAPTERS` closes it, so the contents prints `TOTAL_CHAPTERS` rows.
 *
 * A row's text is derived, never generated (BOOK-DOC-5 §4), and `slotText` is the one place
 * that decides it:
 *   1. a chapter with a title line shows the title verbatim — a written chapter's own heading
 *      or the heading a basis slot carries above its frozen sentence («Замечаний нет»);
 *   2. a written chapter with no title line shows **its first five words**, `…` when the prose
 *      goes on: the book's own words, never a state word (the owner, 2026-10-28: «a status
 *      word is not a title»);
 *   3. a basis slot with no title shows its frozen frame sentence verbatim — the book's text,
 *      not a state;
 *   4. a slot with no prose at all shows «Пусто» — one word in the text slot, nothing else.
 *
 * There is still no «Глава N» fallback, because an invented title would be an invented chapter.
 * Every row opens its chapter: an empty slot is an anchor to its own `#ch-N`, not a dead span.
 *
 * Derived on every change from the catalog; nothing here is stored, and the TOC can never
 * disagree with the chapter list because both read the same rows.
 */

import {
  chapterStartPages,
  frameSentenceOf,
  PART_RANGES,
  TOTAL_CHAPTERS,
  type CatalogEntry,
  type StateSnapshot,
} from '@book/shared';

export type TocSource = Pick<CatalogEntry, 'n' | 'part' | 'title' | 'written' | 'rev' | 'chars' | 'opening'> & {
  /** A slot that holds only its basis sentence (the opening and the finale, BOOK-6). */
  basis?: boolean;
};

export type TocEntryView = {
  n: number;
  title: string | null;
  written: boolean;
  rev: number;
  /** The row's text: a title line, a written chapter's first five words, a basis slot's frozen
   *  sentence, or the one word «Пусто» for a slot that holds no prose. */
  text: string | null;
  /** The chapter's opening page, from `chapterStartPages` — never a second count (BOOK-89). */
  page: number;
  /** Every row opens its chapter — an empty slot opens its own place in the flow. */
  link: boolean;
  /** The slot holds no prose at all: the row keeps its quieter styling, and it still opens. */
  empty: boolean;
  /** The chapter the writer's caret is in; the fact keeps the row exposed, no glyph is drawn. */
  current: boolean;
  href: string;
};

export type TocPart = {
  part: 1 | 2 | 3 | 4;
  /** Roman numeral, the only numeral the book uses for parts. */
  numeral: string;
  from: number;
  to: number;
  written: number;
  total: number;
  entries: TocEntryView[];
};

const NUMERALS: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };

/**
 * The title line of a chapter, or nothing — a slot never gets a label it did not write.
 * An empty slot's row carries no title; its text is decided by `slotText` (BOOK-112).
 */
export function slotLabel(title: string | null): string {
  return title !== null && title.trim().length > 0 ? title : '';
}

/** The one word an empty slot's text slot carries (the owner, 2026-10-28: «Пусто»). */
export const EMPTY_SLOT_TEXT = 'Пусто';

/**
 * The text a row carries, and the only place it is decided (§4, owner 2026-10-28):
 *
 *   1. a title line wins — a written chapter's heading, or the heading a basis slot carries;
 *   2. a written chapter with no heading → its first five words (`…` when truncated): the
 *      book's own text, **never** a state word («написана» was BOOK-137's and is gone);
 *   3. a basis slot with no heading → its frozen frame sentence, verbatim;
 *   4. a slot that holds no prose → «Пусто», exactly one word.
 */
export function slotText(entry: TocSource): string | null {
  const title = slotLabel(entry.title);
  if (title !== '') return title;
  // A written chapter always has prose, so its excerpt is the row; `null` only if a broken
  // catalog has no first block, and then the slot says nothing rather than something false.
  if (entry.written) return entry.opening ?? null;
  if (entry.basis === true) return frameSentenceOf(entry.n) ?? EMPTY_SLOT_TEXT;
  return EMPTY_SLOT_TEXT;
}

export function tocEntry(entry: TocSource, currentChapter: number | null, page: number): TocEntryView {
  return {
    n: entry.n,
    title: entry.title,
    written: entry.written,
    rev: entry.rev,
    text: slotText(entry),
    page,
    // Every row opens its chapter, an empty slot included (owner, 2026-10-28): its `#ch-N`
    // section is in the flow, so a tap scrolls to the place the chapter will stand in.
    link: true,
    empty: !entry.written && entry.basis !== true,
    current: currentChapter === entry.n,
    href: `#ch-${entry.n}`,
  };
}

export function tocParts(catalog: readonly TocSource[], currentChapter: number | null = null): TocPart[] {
  // One call, one arithmetic: the TOC and the reader's folio read the same start pages, so a
  // row can never print a number the folio would contradict (BOOK-89 AC3).
  const starts = chapterStartPages(catalog);
  const byNumber = new Map(catalog.map((entry) => [entry.n, entry]));
  return PART_RANGES.map((range) => {
    const entries: TocEntryView[] = [];
    let written = 0;
    for (let n = range.from; n <= range.to; n += 1) {
      const entry = byNumber.get(n);
      if (entry === undefined) continue;
      if (entry.written) written += 1;
      entries.push(tocEntry(entry, currentChapter, starts.get(n) ?? 1));
    }
    return {
      part: range.part,
      numeral: NUMERALS[range.part] ?? String(range.part),
      from: range.from,
      to: range.to,
      written,
      total: range.to - range.from + 1,
      entries,
    };
  });
}

export function writtenCount(catalog: readonly TocSource[]): number {
  return catalog.reduce((count, entry) => count + (entry.written ? 1 : 0), 0);
}

/** The two rows that stand outside the parts: the opening (1) and the finale (`TOTAL_CHAPTERS`). */
export type TocFrames = {
  opening: TocEntryView | null;
  finale: TocEntryView | null;
};

/**
 * The book's two frames as contents rows (BOOK-155): chapter 1 opens it, chapter
 * `TOTAL_CHAPTERS` closes it, and neither belongs to a part. They carry the same shape as a
 * part's row — the same text, the start page from the one `chapterStartPages` count, and the
 * `#ch-N` href — so the contents prints them like any other row and only the layout places
 * them before «часть I» and after «часть IV». A catalog without a frame yields `null` for it:
 * a row is never invented for a chapter the book does not have.
 */
export function tocFrames(catalog: readonly TocSource[], currentChapter: number | null = null): TocFrames {
  const starts = chapterStartPages(catalog);
  const byNumber = new Map(catalog.map((entry) => [entry.n, entry]));
  const frame = (n: number): TocEntryView | null => {
    const entry = byNumber.get(n);
    return entry === undefined ? null : tocEntry(entry, currentChapter, starts.get(n) ?? 1);
  };
  return { opening: frame(1), finale: frame(TOTAL_CHAPTERS) };
}

/** The chapter the caret is in; a title caret is not a chapter and stays out of the TOC. */
export function currentChapterOf(state: StateSnapshot | null): number | null {
  const current = state?.current ?? null;
  return current !== null && current.chapter !== 'front' ? current.chapter : null;
}

export function tocAriaLabel(written: number, total: number): string {
  return `оглавление · написано ${written} из ${total}`;
}
