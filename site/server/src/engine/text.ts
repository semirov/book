/**
 * What the engine reads about the book's text: **rows** (ADR-043 §3 row 4, ADR-041 §1).
 *
 * The engine needs the text itself for three facts it cannot infer from intent: the base a
 * change was recorded against (§6A.7), the landed revision a gate will read (§6A.11), and
 * whether a chapter is written at all (C1 — a cascade stops at an empty slot instead of
 * walking into it). All three are answered by `chapters`/`blocks`/`front_matter`, never by a
 * file: the DB is the only home of the prose (BOOK-187).
 *
 * The row readers return **the same shapes** the file readers did — `exists`, `title`, `chars`,
 * `blocks[]`, `basis`, `sha256`, `raw` — because the callers are the same callers and only the
 * source moved. `raw` is the canonical text the applier would write from those rows: the title
 * line, a blank line, the paragraphs joined by a blank line, one trailing newline. `sha256`,
 * `chars` and `basis` come from the `chapters` row, which is what the site serves.
 *
 * The file readers stay for the one-shot import (`ingest/reconcile.ts` — files → rows) and for
 * tests that build a book from a manuscript. Nothing under `engine/**` or `writer/**` may call
 * them at runtime: `scripts/arch.mjs`'s text-home rule fails that import (BOOK-187 AC2).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRONT_FILE, TOTAL_CHAPTERS, chapterLabel } from '@book/shared';

import type { Db } from '../db/db.ts';
import { getChapterRow, listBlocks, listChapterRows } from '../db/repo/chapters.ts';
import { getFrontRow } from '../db/repo/front.ts';
import { parseChapter, type ParsedBlock, type ParsedChapter } from '../ingest/parseChapter.ts';
import { parseFront, type ParsedFront } from '../ingest/parseFront.ts';

export type ChapterText = ParsedChapter & { exists: boolean; raw: string };

export type FrontText = ParsedFront & { exists: boolean; raw: string };

/**
 * What a prompt may quote of one chapter — the shape `POST /internal/text` answers with. The
 * body is canonical and carries no title line: the prompt prints the title itself, as a heading.
 */
export type ChapterTextView = {
  n: number;
  title: string | null;
  exists: boolean;
  basis: boolean;
  chars: number;
  text: string;
};

/** The canonical text of a chapter from its parts: what a snapshot and a revision hash. */
export function canonicalChapterRaw(title: string | null, blocks: readonly { text: string }[]): string {
  const body = blocks.map((block) => block.text).join('\n\n');
  if (title === null) return body.length === 0 ? '' : `${body}\n`;
  return body.length === 0 ? `${title}\n` : `${title}\n\n${body}\n`;
}

/** The body alone: paragraphs joined by a blank line, no title line (what a prompt quotes). */
export function chapterBodyOf(blocks: readonly { text: string }[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

/** The narrow prompt shape, from the wide reader — one adapter, so the two cannot drift. */
export function viewOfChapter(chapter: ChapterText): ChapterTextView {
  return {
    n: chapter.n,
    title: chapter.title,
    exists: chapter.exists,
    basis: chapter.basis,
    chars: chapter.chars,
    text: chapterBodyOf(chapter.blocks),
  };
}

/**
 * A chapter as `chapters`/`blocks` hold it. A slot with no row is `exists: false` with the empty
 * parse — the same answer a missing file gave, so every caller's branch stays the case it was.
 */
export function readChapterRows(db: Db, n: number): ChapterText {
  const row = getChapterRow(db, n);
  if (row === undefined) return { ...parseChapter(n, ''), exists: false, raw: '' };
  const blocks: ParsedBlock[] = listBlocks(db, n).map((block) => ({
    id: block.id,
    i: block.idx,
    text: block.text,
    hash: block.hash,
  }));
  const raw = canonicalChapterRaw(row.title, blocks);
  const body = blocks.length === 0 ? '' : `${chapterBodyOf(blocks)}\n`;
  return {
    n,
    title: row.title,
    titleProblems: [],
    text: raw,
    body,
    sha256: row.sha256,
    chars: row.chars,
    blocks,
    basis: row.basis === 1,
    exists: true,
    raw,
  };
}

/**
 * The first sheet as `front_matter` holds it. The annotation's paragraphs are re-split from the
 * stored annotation, so a caller sees the same `blocks` the file reader gave it; both hashes are
 * the row's, because they are what a pass is measured against (`FRONT_ANNOTATION_FROZEN`).
 */
export function readFrontRows(db: Db): FrontText {
  const row = getFrontRow(db);
  if (row === undefined) return { ...parseFront(''), exists: false, raw: '' };
  const raw = `${row.title}\n\n${row.about}\n`;
  const parsed = parseFront(raw);
  return {
    ...parsed,
    sha256: row.sha256,
    aboutSha256: row.about_sha256,
    exists: true,
    raw,
  };
}

/** One statement per chapter's blocks is enough for a prompt; the rows are already ordered. */
export function textViewsOf(db: Db, chapters: readonly number[]): ChapterTextView[] {
  return chapters.map((n) => viewOfChapter(readChapterRows(db, n)));
}

/**
 * The prompt's "may I read this?" predicate on the narrow shape: a chapter that exists, is not
 * its own frame, and holds a paragraph. The same three facts `isWrittenChapter` reads.
 */
export function isWrittenView(view: ChapterTextView): boolean {
  return view.exists && !view.basis && view.text.trim().length > 0;
}

/**
 * A chapter that may carry prose edits: the row exists and holds real paragraphs.
 *
 * A basis-only slot (ch01/ch42, one frozen sentence, BOOK-6) reads as one paragraph but is
 * an empty slot for every process fact — no change may be admitted against it, no pass may
 * start on it, and nothing may take its frame as landed text. One predicate, so the engine
 * cannot mean two things by "written".
 */
export function isWrittenChapter(chapter: ChapterText | null): chapter is ChapterText {
  return chapter !== null && chapter.exists && chapter.blocks.length > 0 && !chapter.basis;
}

/** A chapter is written when its row holds a paragraph that is not the basis sentence. */
export function isWrittenIn(db: Db, n: number): boolean {
  return isWrittenChapter(readChapterRows(db, n));
}

/**
 * A basis-only slot (§BOOK-6): its whole text is the frame sentence, so it is not prose — read
 * from the file (`ParsedChapter.basis`, what the engine parses) or from the projection
 * (`chapters.basis`, what the site serves). One predicate, so the queue, the acceptance path and
 * the premise sweep cannot mean two things by "the frame is the whole text".
 */
export function isBasisSlot(slot: { basis: boolean | number } | undefined): boolean {
  return slot !== undefined && slot.basis !== false && slot.basis !== 0;
}

/** Chapter numbers the cascade may walk into: written, in 1..`TOTAL_CHAPTERS`. */
export function writtenChaptersOf(db: Db): Set<number> {
  const rows = listChapterRows(db);
  const withBlocks = new Set(
    (db.prepare('SELECT DISTINCT chapter FROM blocks').all() as Array<{ chapter: number }>).map(
      (row) => row.chapter,
    ),
  );
  const written = new Set<number>();
  for (const row of rows) {
    if (row.n >= 1 && row.n <= TOTAL_CHAPTERS && row.basis === 0 && withBlocks.has(row.n)) written.add(row.n);
  }
  return written;
}

// ── the one-shot import (files → rows) ───────────────────────────────────────────────────────
//
// Kept for `ingest/reconcile.ts` and for tests that build a book from a manuscript. No engine or
// writer module may call these: the text they need is a row (the arch rule `text-home`).

export function chapterPath(bookRoot: string, n: number): string {
  return join(bookRoot, 'manuscript', `ch${chapterLabel(n)}.md`);
}

export function frontPath(bookRoot: string): string {
  return join(bookRoot, 'manuscript', FRONT_FILE);
}

export function readChapter(bookRoot: string, n: number): ChapterText {
  const path = chapterPath(bookRoot, n);
  if (!existsSync(path)) {
    return { ...parseChapter(n, ''), exists: false, raw: '' };
  }
  const raw = readFileSync(path, 'utf8');
  return { ...parseChapter(n, raw), exists: true, raw };
}

export function readFront(bookRoot: string): FrontText {
  const path = frontPath(bookRoot);
  if (!existsSync(path)) {
    return { ...parseFront(''), exists: false, raw: '' };
  }
  const raw = readFileSync(path, 'utf8');
  return { ...parseFront(raw), exists: true, raw };
}

/** A chapter is written when its file exists and holds a paragraph that is not the basis sentence. */
export function isWritten(bookRoot: string, n: number): boolean {
  return isWrittenChapter(readChapter(bookRoot, n));
}

/** Chapter numbers the cascade may walk into: written, in 1..`TOTAL_CHAPTERS`. */
export function writtenChapters(bookRoot: string): Set<number> {
  const written = new Set<number>();
  for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
    if (isWritten(bookRoot, n)) written.add(n);
  }
  return written;
}
