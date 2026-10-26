/**
 * The live table of contents (ARCHITECTURE.md §6C.7, §11.8): four numbered parts, 67
 * entries. A row's text is derived, never generated (BOOK-DOC-5 §4): a written chapter
 * shows its title line verbatim, a basis slot shows its frozen frame sentence verbatim, and
 * an empty slot shows nothing at all — the numeral is the entire row. There is no
 * «Глава N» fallback: an invented title is an invented chapter.
 *
 * Derived on every change from the catalog; nothing here is stored, and the TOC can never
 * disagree with the chapter list because both read the same rows.
 */

import { frameSentenceOf, PART_RANGES, type CatalogEntry, type StateSnapshot, type TocEntry } from '@book/shared';

export type TocSource = Pick<CatalogEntry, 'n' | 'part' | 'title' | 'written' | 'rev'> & {
  /** A slot that holds only its basis sentence (ch01/ch67, BOOK-6). */
  basis?: boolean;
};

export type TocEntryView = {
  n: number;
  title: string | null;
  written: boolean;
  rev: number;
  /** The row's text: a title line, a frozen sentence, or nothing. */
  text: string | null;
  /** A row is a link when it opens prose — a written chapter or a basis sentence. */
  link: boolean;
  /** The chapter the writer's caret is in — a dot in the TOC, not a caret in the prose. */
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

/** The title line of a chapter, or nothing — a slot never gets a label it did not write. */
export function slotLabel(title: string | null): string {
  return title !== null && title.trim().length > 0 ? title : '';
}

/** The text a row carries: title line, frozen frame of a basis slot, or nothing (§4). */
export function slotText(entry: TocSource): string | null {
  if (entry.written) return slotLabel(entry.title) || null;
  if (entry.basis === true) return frameSentenceOf(entry.n);
  return null;
}

export function tocEntry(entry: TocSource, currentChapter: number | null): TocEntryView {
  const text = slotText(entry);
  return {
    n: entry.n,
    title: entry.title,
    written: entry.written,
    rev: entry.rev,
    text,
    // A written chapter with a broken title line still opens: the row keeps its prose.
    link: entry.written || text !== null,
    current: currentChapter === entry.n,
    href: `#ch-${entry.n}`,
  };
}

export function tocParts(catalog: readonly TocSource[], currentChapter: number | null = null): TocPart[] {
  const byNumber = new Map(catalog.map((entry) => [entry.n, entry]));
  return PART_RANGES.map((range) => {
    const entries: TocEntryView[] = [];
    let written = 0;
    for (let n = range.from; n <= range.to; n += 1) {
      const entry = byNumber.get(n);
      if (entry === undefined) continue;
      if (entry.written) written += 1;
      entries.push(tocEntry(entry, currentChapter));
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

/** A `state.toc` entry is already a view; this keeps the component and the server in step. */
export function fromStateToc(toc: readonly TocEntry[], currentChapter: number | null = null): TocEntryView[] {
  return toc.map((entry) => tocEntry(entry, currentChapter));
}

export function tocAriaLabel(written: number, total: number): string {
  return `оглавление · написано ${written} из ${total}`;
}
