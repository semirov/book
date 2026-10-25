import { allChapterNumbers, directionOf, lineOf, type CatalogEntry } from '@book/shared';

import type { Db } from '../db.ts';

export type ChapterRow = {
  n: number;
  rev: number;
  sha256: string;
  chars: number;
  block_count: number;
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
    sha256: string;
    chars: number;
    blockCount: number;
    writtenAt: string;
    updatedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO chapters (n, rev, sha256, chars, block_count, written_at, updated_at, parse_error)
     VALUES (@n, @rev, @sha256, @chars, @blockCount, @writtenAt, @updatedAt, NULL)
     ON CONFLICT(n) DO UPDATE SET
       rev = excluded.rev,
       sha256 = excluded.sha256,
       chars = excluded.chars,
       block_count = excluded.block_count,
       updated_at = excluded.updated_at,
       parse_error = NULL`,
  ).run(row);
}

export function deleteChapterRow(db: Db, n: number): void {
  db.prepare('DELETE FROM chapters WHERE n = ?').run(n);
}

export function listBlocks(db: Db, n: number): BlockRow[] {
  return db.prepare('SELECT * FROM blocks WHERE chapter = ? ORDER BY idx').all(n) as BlockRow[];
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
 * The catalog of §9: all 67 slots, unwritten ones with `rev: 0`. The SPA renders the
 * опись from this without a request per slot.
 */
export function listCatalog(db: Db): CatalogEntry[] {
  const rows = new Map(listChapterRows(db).map((row) => [row.n, row]));
  return allChapterNumbers().map((n) => {
    const row = rows.get(n);
    const written = row !== undefined && row.block_count > 0;
    return {
      n,
      rev: row?.rev ?? 0,
      chars: row?.chars ?? 0,
      blocks: row?.block_count ?? 0,
      written,
      writtenAt: written ? (row?.written_at ?? null) : null,
      updatedAt: written ? (row?.updated_at ?? null) : null,
      direction: directionOf(n),
      line: lineOf(n),
    };
  });
}
