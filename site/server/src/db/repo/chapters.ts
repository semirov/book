import { allChapterNumbers, directionOf, openingOf, partOf, type CatalogEntry } from '@book/shared';

import type { Db } from '../db.ts';

export type ChapterRow = {
  n: number;
  rev: number;
  title: string | null;
  sha256: string;
  chars: number;
  block_count: number;
  /** 1 = the file is exactly its basis sentence: one block to read, not a written chapter. */
  basis: number;
  written_at: string;
  updated_at: string;
  parse_error: string | null;
};

export type BlockRow = {
  id: string;
  chapter: number;
  idx: number;
  text: string;
  hash: string;
  first_rev: number;
  last_rev: number;
};

export function getChapterRow(db: Db, n: number): ChapterRow | undefined {
  return db.prepare('SELECT * FROM chapters WHERE n = ?').get(n) as ChapterRow | undefined;
}

export function listChapterRows(db: Db): ChapterRow[] {
  return db.prepare('SELECT * FROM chapters ORDER BY n').all() as ChapterRow[];
}

export function upsertChapterRow(
  db: Db,
  row: {
    n: number;
    rev: number;
    title: string | null;
    sha256: string;
    chars: number;
    blockCount: number;
    /** True when the file is exactly its basis sentence (ch01/ch42). */
    basis: boolean;
    writtenAt: string;
    updatedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at, parse_error)
     VALUES (@n, @rev, @title, @sha256, @chars, @blockCount, @basis, @writtenAt, @updatedAt, NULL)
     ON CONFLICT(n) DO UPDATE SET
       rev = excluded.rev,
       title = excluded.title,
       sha256 = excluded.sha256,
       chars = excluded.chars,
       block_count = excluded.block_count,
       basis = excluded.basis,
       updated_at = excluded.updated_at,
       parse_error = NULL`,
  ).run({ ...row, basis: row.basis ? 1 : 0 });
}

export function deleteChapterRow(db: Db, n: number): void {
  db.prepare('DELETE FROM chapters WHERE n = ?').run(n);
}

export function listBlocks(db: Db, n: number): BlockRow[] {
  return db.prepare('SELECT * FROM blocks WHERE chapter = ? ORDER BY idx').all(n) as BlockRow[];
}

/**
 * The first block's text for every chapter that has one, keyed by chapter — one statement for
 * the whole catalog, so the contents' excerpt costs no request per row (BOOK-155 follow-up).
 *
 * The only index over `blocks` is `(chapter, idx)`, and this table holds every paragraph's text:
 * a bare `WHERE idx = 0` scans that whole index for each chapter. `CROSS JOIN` pins the loop
 * order — `chapters` (42 rows) drives, and each row is one index seek into the blocks of that
 * chapter (`SEARCH b USING INDEX blocks_chapter_idx (chapter=? AND idx=?)`). No temp b-tree: the
 * chapter order is the table's own.
 */
export function listFirstBlockTexts(db: Db): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT b.chapter, b.text FROM chapters c
         CROSS JOIN blocks b
        WHERE b.chapter = c.n AND b.idx = 0
        ORDER BY c.n`,
    )
    .all() as Array<{ chapter: number; text: string }>;
  return new Map(rows.map((row) => [row.chapter, row.text]));
}

export function replaceBlocks(
  db: Db,
  n: number,
  rev: number,
  blocks: Array<{ id: string; text: string; hash: string }>,
): void {
  const firstRev = new Map<string, number>();
  for (const row of listBlocks(db, n)) firstRev.set(row.id, row.first_rev);
  db.prepare('DELETE FROM blocks WHERE chapter = ?').run(n);
  const insert = db.prepare(
    `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev)
     VALUES (@id, @chapter, @idx, @text, @hash, @firstRev, @lastRev)`,
  );
  blocks.forEach((block, idx) => {
    insert.run({
      id: block.id,
      chapter: n,
      idx,
      text: block.text,
      hash: block.hash,
      firstRev: firstRev.get(block.id) ?? rev,
      lastRev: rev,
    });
  });
}

/**
 * The catalog of §9: all `TOTAL_CHAPTERS` slots, unwritten ones with `rev: 0` and `title: null`.
 * The SPA renders the опись from this without a request per slot; `part` is the chapter's part
 * (null for the opening and the finale), `direction` only says which lane drafted it.
 *
 * A slot that holds only its basis sentence (ch01/ch42) is not written — `chars` stay 0 and
 * it does not enter `/api/state` — but it carries `basis: true` and `blocks: 1`, because the
 * reader must see that paragraph (BOOK-6).
 */
export function listCatalog(db: Db): CatalogEntry[] {
  const rows = new Map(listChapterRows(db).map((row) => [row.n, row]));
  const firstBlocks = listFirstBlockTexts(db);
  return allChapterNumbers().map((n) => {
    const row = rows.get(n);
    const basis = row?.basis === 1;
    const written = row !== undefined && row.block_count > 0 && !basis;
    return {
      n,
      part: partOf(n),
      title: row?.title ?? null,
      rev: row?.rev ?? 0,
      chars: row?.chars ?? 0,
      blocks: row?.block_count ?? 0,
      written,
      basis,
      // The contents' excerpt: the book's own words, derived from the first block.
      opening: openingOf(firstBlocks.get(n) ?? null),
      writtenAt: written ? (row?.written_at ?? null) : null,
      updatedAt: written ? (row?.updated_at ?? null) : null,
      direction: directionOf(n),
    };
  });
}
