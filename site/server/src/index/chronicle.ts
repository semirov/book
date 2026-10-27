/**
 * The document-status diff the chronicle speaks from (BOOK-18 §3).
 *
 * A change closes; for every chapter it actually rewrote we hold the text before and after.
 * Both sides are read by the same extraction rules, and only the **effective status** of a
 * document is compared — the last status in the chapter's reading order. A paper whose
 * status is the same on both sides is silence; a paper that moved in three chapters is one
 * statement naming the paper and the three chapters, never three statements.
 *
 * A chapter without a pre-image is skipped: with nothing to compare against, the honest
 * answer is silence, not «everything appeared». A generic «документ» (no number, no name) is
 * not a paper but a common noun, so it is not reported either.
 *
 * This module is pure: no database, no files, no clock. The engine supplies the two texts.
 */

import { indexChapterText } from './build.ts';
import type { DocumentStatus } from './types.ts';

export type ChapterTextChange = {
  chapter: number;
  /** The chapter's text before this change; `null` when there is no pre-image to compare. */
  before: string | null;
  /** The chapter's text now; `null` when the chapter is gone. */
  after: string | null;
};

export type DocumentMove = {
  /** The stable key, for identity — never printed as the reader-facing name. */
  document: string;
  /** The paper as the text spells it, for the statement. */
  surface: string;
  /** Chapters where the status moved, ascending — the statement's payload. */
  chapters: number[];
};

type StatusEntry = { status: DocumentStatus; surface: string };

function statusesOf(raw: string | null, chapter: number): Map<string, StatusEntry> {
  if (raw === null || raw.trim().length === 0) return new Map();
  return new Map(
    indexChapterText(chapter, raw).documents.map((entry) => [
      entry.document,
      { status: entry.status, surface: entry.surface },
    ]),
  );
}

/** One entry per document whose status moved, with every chapter where it moved. */
export function documentMoves(changes: readonly ChapterTextChange[]): DocumentMove[] {
  const moved = new Map<string, { surface: string; chapters: Set<number> }>();
  const ordered = [...changes].sort((left, right) => left.chapter - right.chapter);
  for (const change of ordered) {
    // No pre-image, no claim: a lost snapshot is not a chapter born full of papers.
    if (change.before === null || change.before.trim().length === 0) continue;
    const before = statusesOf(change.before, change.chapter);
    const after = statusesOf(change.after, change.chapter);
    const documents = new Set<string>([...before.keys(), ...after.keys()]);
    for (const document of documents) {
      if (document === 'документ') continue;
      const prior = before.get(document);
      const now = after.get(document);
      if (prior?.status === now?.status) continue;
      const entry = moved.get(document) ?? { surface: now?.surface ?? prior?.surface ?? document, chapters: new Set<number>() };
      entry.chapters.add(change.chapter);
      moved.set(document, entry);
    }
  }
  return [...moved.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([document, entry]) => ({
      document,
      surface: entry.surface,
      chapters: [...entry.chapters].sort((left, right) => left - right),
    }));
}
