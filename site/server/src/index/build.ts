/**
 * Building the derived index from the manuscript (BOOK-18 §1).
 *
 * Reads every slot once, extracts its facts, and hashes the result. The hash is the
 * artifact's key: identical text gives identical bytes and the same `manuscriptHash`, so a
 * rebuild can replace the stored file wholesale without anyone having to ask whether it is
 * current. No clock, no path and no environment value enters the hashed payload.
 *
 * A file that cannot be read is an empty slot here — the index is a cache, and a cache that
 * refuses to be built is worse than one that says «nothing to say» (erring by design).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { allChapterNumbers, chapterLabel } from '@book/shared';

import { parseChapter } from '../ingest/parseChapter.ts';
import { sha256Hex } from '../util/hash.ts';
import { extractChapter } from './extract.ts';
import { INDEX_VERSION, type ChapterIndex, type DerivedIndex } from './types.ts';

export function chapterFile(bookRoot: string, n: number): string {
  return join(bookRoot, 'manuscript', `ch${chapterLabel(n)}.md`);
}

function readRaw(bookRoot: string, n: number): string {
  try {
    const path = chapterFile(bookRoot, n);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Extraction is the expensive part of a build, and a build runs on every editor dispatch.
 * A chapter is memoised by its own text hash, so a rebuild after one rewrite extracts one
 * chapter and reuses the other 66. The key includes `n` and the basis flag because the same
 * bytes in two slots are two different entries; the cache is bounded and holds only values
 * that are a pure function of the text and `INDEX_VERSION`.
 */
const MEMO_LIMIT = 512;
const MEMO = new Map<string, ChapterIndex>();

/** One chapter's facts from its raw file text (also used for a historical snapshot). */
export function indexChapterText(n: number, raw: string): ChapterIndex {
  const parsed = parseChapter(n, raw);
  // A slot holding only its basis sentence (ch01/ch67) is not prose: nothing to index.
  const written = parsed.blocks.length > 0 && !parsed.basis;
  const key = `${n}:${written ? 1 : 0}:${parsed.sha256}`;
  const cached = MEMO.get(key);
  if (cached !== undefined) return cached;
  const chapter = extractChapter({
    n,
    written,
    sha256: parsed.sha256,
    paragraphs: parsed.blocks.map((block) => block.text),
  });
  if (MEMO.size >= MEMO_LIMIT) MEMO.clear();
  MEMO.set(key, chapter);
  return chapter;
}

/** The artifact's key: the version and every chapter's text hash, in chapter order. */
export function hashChapters(chapters: readonly ChapterIndex[]): string {
  const lines = chapters.map((chapter) => `${chapter.n}:${chapter.sha256}`);
  return sha256Hex(`${INDEX_VERSION}\n${lines.join('\n')}`);
}

export function buildIndex(bookRoot: string): DerivedIndex {
  const chapters = allChapterNumbers().map((n) => indexChapterText(n, readRaw(bookRoot, n)));
  return { version: INDEX_VERSION, manuscriptHash: hashChapters(chapters), chapters };
}
