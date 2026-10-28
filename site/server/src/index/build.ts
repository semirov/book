/**
 * Building the derived index from the rows (BOOK-18 §1, BOOK-187 AC2).
 *
 * The index is a cache of the book's text, and since BOOK-187 the text is `chapters`/`blocks`:
 * nothing here opens a file. Each slot is read once (its stored `chapters.sha256` and its
 * paragraphs in `idx` order), its facts are extracted, and the lot is hashed. The hash is the
 * artifact's key: identical text gives identical bytes and the same `manuscriptHash`, so a
 * rebuild can replace the stored artifact wholesale without anyone having to ask whether it is
 * current. No clock, no path and no environment value enters the hashed payload.
 *
 * The key is **the hash of the stored per-chapter `chapters.sha256` in slot order** — the same
 * input the edition hash uses (`fb2/edition.ts`) — so it moves exactly when the text moves,
 * stays still on a restart, and costs 42 index reads instead of 380 000 characters.
 *
 * A slot without a row, or with no blocks, is an empty slot here — the index is a cache, and a
 * cache that refuses to be built is worse than one that says «nothing to say» (erring by design).
 */

import { allChapterNumbers } from '@book/shared';

import type { Db } from '../db/db.ts';
import { listBlocks, listChapterRows, type ChapterRow } from '../db/repo/chapters.ts';
import { parseChapter } from '../ingest/parseChapter.ts';
import { sha256Hex } from '../util/hash.ts';
import { extractChapter } from './extract.ts';
import { INDEX_VERSION, type ChapterIndex, type DerivedIndex } from './types.ts';

/**
 * Extraction is the expensive part of a build, and a build runs on every editor dispatch.
 * A chapter is memoised by its own text hash, so a rebuild after one rewrite extracts one
 * chapter and reuses the other 66. The key includes `n` and the basis flag because the same
 * bytes in two slots are two different entries; the cache is bounded and holds only values
 * that are a pure function of the text and `INDEX_VERSION`.
 */
const MEMO_LIMIT = 512;
const MEMO = new Map<string, ChapterIndex>();

/**
 * One chapter's facts from its raw text — the shape `chronicle.ts` compares two moments in, and
 * the one the row path and the text path share, so a chapter cannot be indexed two ways.
 */
export function indexChapterText(n: number, raw: string): ChapterIndex {
  const parsed = parseChapter(n, raw);
  // A slot holding only its basis sentence (ch01/ch42) is not prose: nothing to index.
  const written = parsed.blocks.length > 0 && !parsed.basis;
  return indexChapter({
    n,
    written,
    sha256: parsed.sha256,
    paragraphs: parsed.blocks.map((block) => block.text),
  });
}

/** The memoised extraction: one key, one entry, bounded. */
function indexChapter(input: {
  n: number;
  written: boolean;
  sha256: string;
  paragraphs: readonly string[];
}): ChapterIndex {
  const key = `${input.n}:${input.written ? 1 : 0}:${input.sha256}`;
  const cached = MEMO.get(key);
  if (cached !== undefined) return cached;
  const chapter = extractChapter({
    n: input.n,
    written: input.written,
    sha256: input.sha256,
    paragraphs: input.paragraphs,
  });
  if (MEMO.size >= MEMO_LIMIT) MEMO.clear();
  MEMO.set(key, chapter);
  return chapter;
}

/** One slot from its rows: the stored text hash, and its paragraphs in `idx` order. */
function indexChapterRow(db: Db, n: number, row: ChapterRow | undefined): ChapterIndex {
  const blocks = row === undefined ? [] : listBlocks(db, n);
  // BOOK-6: a basis-only slot (ch01/ch42) carries one readable paragraph and is not prose.
  const written = row !== undefined && row.basis === 0 && blocks.length > 0;
  return indexChapter({
    n,
    written,
    // A missing row hashes the empty string, exactly as an absent file did.
    sha256: row?.sha256 ?? sha256Hex(''),
    paragraphs: written ? blocks.map((block) => block.text) : [],
  });
}

/** The artifact's key: the version and every chapter's stored text hash, in chapter order. */
export function hashChapters(chapters: readonly ChapterIndex[]): string {
  const lines = chapters.map((chapter) => `${chapter.n}:${chapter.sha256}`);
  return sha256Hex(`${INDEX_VERSION}\n${lines.join('\n')}`);
}

/** The whole artifact, from the rows and nothing else. */
export function buildIndex(db: Db): DerivedIndex {
  const rows = new Map(listChapterRows(db).map((row) => [row.n, row]));
  const chapters = allChapterNumbers().map((n) => indexChapterRow(db, n, rows.get(n)));
  return { version: INDEX_VERSION, manuscriptHash: hashChapters(chapters), chapters };
}
