/**
 * The live table of contents (ARCHITECTURE.md §6C.7, §11.8): four numbered parts, 67
 * entries. A row's text is derived, never generated (BOOK-DOC-5 §4): a written chapter
 * shows its title line verbatim, a basis slot shows its frozen frame sentence verbatim, and
 * an empty slot shows the flow's own state word — «замысел», the word the chapter's premise
 * already carries. It is a state, not a title: there is still no «Глава N» fallback, because
 * an invented title would be an invented chapter.
 *
 * Derived on every change from the catalog; nothing here is stored, and the TOC can never
 * disagree with the chapter list because both read the same rows.
 */

import { chapterStartPages, frameSentenceOf, PART_RANGES, type CatalogEntry, type StateSnapshot } from '@book/shared';

export type TocSource = Pick<CatalogEntry, 'n' | 'part' | 'title' | 'written' | 'rev' | 'chars'> & {
  /** A slot that holds only its basis sentence (ch01/ch67, BOOK-6). */
  basis?: boolean;
};

export type TocEntryView = {
  n: number;
  title: string | null;
  written: boolean;
  rev: number;
  /** The row's text: a title line, a frozen sentence, or the state word of an empty slot. */
  text: string | null;
  /** The text is the state word («замысел»), not prose: an unwritten, non-basis slot. */
  state: boolean;
  /** The chapter's opening page, from `chapterStartPages` — never a second count (BOOK-89). */
  page: number;
  /** A row is a link when it opens prose — a written chapter or a basis sentence. */
  link: boolean;
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
 * What an empty slot's row says (BOOK-89, owner): the state word the flow itself prints on a
 * premise row, not a label invented for the contents. Three cases in this order — a written
 * chapter's title line, a basis slot's frozen sentence, otherwise «замысел».
 */
export const SLOT_STATE_WORD = 'замысел';

/** The title line of a chapter, or nothing — a slot never gets a label it did not write. */
export function slotLabel(title: string | null): string {
  return title !== null && title.trim().length > 0 ? title : '';
}

/**
 * The text a row carries: a written chapter's title line (null when the title line is broken —
 * the row still opens its prose), a basis slot's frozen frame, or the state word of a slot
 * that holds no prose at all (§4, BOOK-89).
 */
export function slotText(entry: TocSource): string | null {
  if (entry.written) return slotLabel(entry.title) || null;
  if (entry.basis === true) return frameSentenceOf(entry.n);
  return SLOT_STATE_WORD;
}

export function tocEntry(entry: TocSource, currentChapter: number | null, page: number): TocEntryView {
  const text = slotText(entry);
  const state = !entry.written && entry.basis !== true;
  return {
    n: entry.n,
    title: entry.title,
    written: entry.written,
    rev: entry.rev,
    text,
    state,
    page,
    // A written chapter with a broken title line still opens: the row keeps its prose. The
    // state word is not prose, so a row that carries only the word stays inert.
    link: entry.written || (text !== null && !state),
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

/** The chapter the caret is in; a title caret is not a chapter and stays out of the TOC. */
export function currentChapterOf(state: StateSnapshot | null): number | null {
  const current = state?.current ?? null;
  return current !== null && current.chapter !== 'front' ? current.chapter : null;
}

export function tocAriaLabel(written: number, total: number): string {
  return `оглавление · написано ${written} из ${total}`;
}
