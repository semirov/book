/**
 * What the engine reads from the manuscript (read-only, §1: the engine never writes prose).
 *
 * The site owns the projection in `chapters`/`blocks`; the engine needs the *text itself*
 * for three facts it cannot infer from intent: the base a change was recorded against
 * (§6A.7), the landed revision a gate will read (§6A.11), and whether a chapter is written
 * at all (C1 — a cascade stops at an empty slot instead of walking into it).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRONT_FILE, TOTAL_CHAPTERS, chapterLabel } from '@book/shared';

import { parseChapter, type ParsedChapter } from '../ingest/parseChapter.ts';
import { parseFront, type ParsedFront } from '../ingest/parseFront.ts';

export type ChapterText = ParsedChapter & { exists: boolean; raw: string };

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

export function readFront(bookRoot: string): ParsedFront & { exists: boolean; raw: string } {
  const path = frontPath(bookRoot);
  if (!existsSync(path)) {
    return { ...parseFront(''), exists: false, raw: '' };
  }
  const raw = readFileSync(path, 'utf8');
  return { ...parseFront(raw), exists: true, raw };
}

/**
 * A chapter that may carry prose edits: the file exists and holds real paragraphs.
 *
 * A basis-only slot (ch01/ch67, one frozen sentence, BOOK-6) reads as one paragraph but is
 * an empty slot for every process fact — no change may be admitted against it, no pass may
 * start on it, and nothing may take its frame as landed text. One predicate, so the engine
 * cannot mean two things by "written".
 */
export function isWrittenChapter(chapter: ChapterText | null): chapter is ChapterText {
  return chapter !== null && chapter.exists && chapter.blocks.length > 0 && !chapter.basis;
}

/** A chapter is written when its file exists and holds a paragraph that is not the basis sentence. */
export function isWritten(bookRoot: string, n: number): boolean {
  return isWrittenChapter(readChapter(bookRoot, n));
}

/** Chapter numbers the cascade may walk into: written, in 1..67. */
export function writtenChapters(bookRoot: string): Set<number> {
  const written = new Set<number>();
  for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
    if (isWritten(bookRoot, n)) written.add(n);
  }
  return written;
}
