/**
 * Full-text search over the block projection (BOOK-176): `blocks_fts` mirrors `blocks` through
 * triggers, so the index can never disagree with the text the reader is served — a phrase that
 * an edit removed stops being findable in the same transaction that removed it.
 *
 * The query is **data, never syntax**. FTS5 has its own language (`AND`, `NEAR`, `*`, `-`,
 * quotes) and a reader's words must not steer it: every token is quoted and the tokens are
 * ANDed, so `night shift` finds blocks that hold both words and `(` finds nothing instead of
 * raising. An empty query is an empty answer, not the whole book.
 */

import type { Db } from '../db/db.ts';

export type BlockHit = {
  blockId: string;
  chapter: number;
  idx: number;
  text: string;
};

export const SEARCH_LIMIT_MAX = 100;
export const SEARCH_LIMIT_DEFAULT = 20;

/** The MATCH expression for a reader's words: quoted tokens, all of them required. */
export function searchExpression(query: string): string | null {
  const tokens = query
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/gu, '""')}"`).join(' ');
}

/**
 * Blocks whose text matches every word of `query`, best first (bm25), capped. Ties between equal
 * scores fall back to the book's own order so the answer is stable between calls.
 */
export function searchBlocks(
  db: Db,
  query: string,
  limit: number = SEARCH_LIMIT_DEFAULT,
): BlockHit[] {
  const expression = searchExpression(query);
  if (expression === null) return [];
  const capped = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.trunc(limit)));
  const rows = db
    .prepare(
      `SELECT b.id AS blockId, b.chapter AS chapter, b.idx AS idx, b.text AS text
         FROM blocks_fts f
         JOIN blocks b ON b.rowid = f.rowid
        WHERE blocks_fts MATCH ?
        ORDER BY bm25(blocks_fts), b.chapter, b.idx
        LIMIT ?`,
    )
    .all(expression, capped) as BlockHit[];
  return rows;
}
