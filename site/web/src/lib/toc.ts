/**
 * The live table of contents (ARCHITECTURE.md §6C.7, §11.8): four numbered parts, 67
 * entries, each entry `number · title` when the chapter has a title line and
 * `number · Глава N` in muted italics when the slot is empty or untitled.
 *
 * Derived on every change from the catalog; nothing here is stored, and the TOC can never
 * disagree with the chapter list because both read the same rows.
 */

import { PART_RANGES, type CatalogEntry, type StateSnapshot, type TocEntry } from '@book/shared';

export type TocSource = Pick<CatalogEntry, 'n' | 'part' | 'title' | 'written' | 'rev'>;

export type TocEntryView = {
  n: number;
  title: string | null;
  written: boolean;
  rev: number;
  /** The visible label: the live title line, or «Глава N» for an empty/untitled slot. */
  label: string;
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

/** A chapter without a title line still publishes; its slot is labelled, never blank. */
export function slotLabel(n: number, title: string | null): string {
  return title !== null && title.trim().length > 0 ? title : `Глава ${n}`;
}

export function tocEntry(entry: TocSource, currentChapter: number | null): TocEntryView {
  return {
    n: entry.n,
    title: entry.title,
    written: entry.written,
    rev: entry.rev,
    label: slotLabel(entry.n, entry.title),
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

/** The TOC's own heading is the live title, smaller than on the cover. */
export function tocHeading(state: StateSnapshot): string | null {
  return state.front.title;
}

/** A `state.toc` entry is already a view; this keeps the component and the server in step. */
export function fromStateToc(toc: readonly TocEntry[], currentChapter: number | null = null): TocEntryView[] {
  return toc.map((entry) => tocEntry(entry, currentChapter));
}

export function tocAriaLabel(written: number, total: number): string {
  return `оглавление · написано ${written} из ${total}`;
}
