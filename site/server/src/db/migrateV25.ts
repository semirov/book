/**
 * Migration v25 (ADR-044, BOOK-DOC-74) — the sentence becomes a stored, identified row.
 *
 * The step is **additive and inventing as little as possible**:
 *
 *   · `sentences` and `sentence_touches` are created from the same constant a fresh install reads
 *     (`sentenceTables.ts`), so an upgraded install and a new one cannot drift apart;
 *   · `comments`, `facts`, `literals` and `mentions` gain a nullable `sentence_id` carrier, and a
 *     comment gains the offsets of the reader's selection inside the sentence. They carry **no**
 *     foreign key: SQLite cannot add one by `ALTER TABLE`, so a migrated install would refuse what
 *     a fresh one accepts — the two shapes must stay equal, and the reference is enforced by the
 *     writer instead. `edges` gets the column too, but only when that table exists (v22 has no
 *     `edges`; ADR-041 adds it later) — no table is created here;
 *   · **every live block is segmented once**, in one transaction, by the shared segmenter: `idx`,
 *     `start`/`end` in code points, `text_hash`, `seg_version`. A block that already has any
 *     sentence row is skipped, so a replayed migration cannot double a block's sentences;
 *   · every filing with a block and a quote is **re-anchored** to the one sentence its quote sits
 *     in, with the quote's offsets inside it. A quote that is ambiguous, gone, or straddles a
 *     boundary gets `NULL` and keeps its block anchor — the NULL count is published in `meta`,
 *     never reduced by guessing;
 *   · **nothing is invented**: no `sentence_touches` row (an imported sentence has no known edit),
 *     no fact, no literal, no mention, and no re-segmentation of history. The history before this
 *     cut stays block-level, which is what `block_lineage` and `block_deltas` are for.
 *
 * Rollback is the ADR's: drop the two tables, leave the nullable columns — they are harmless and a
 * fresh install carries them anyway.
 */

import { SEGMENTER_VERSION } from '@book/shared';

import { reanchorComments } from '../sentences/anchor.ts';
import { blockHasSentences, insertImportedSentences } from '../sentences/store.ts';
import type { Db } from './db.ts';
import { SENTENCE_TABLES_SQL } from './sentenceTables.ts';

/** Every column v25 adds, and nothing else. `edges` is not here — see `migrateV25`. */
const COLUMN_ADDITIONS: ReadonlyArray<readonly [table: string, column: string, definition: string]> = [
  ['comments', 'sentence_id', 'TEXT'],
  ['comments', 'sel_start', 'INTEGER'],
  ['comments', 'sel_end', 'INTEGER'],
  ['facts', 'sentence_id', 'TEXT'],
  ['literals', 'sentence_id', 'TEXT'],
  ['mentions', 'sentence_id', 'TEXT'],
];

function tableExists(db: Db, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  return row !== undefined;
}

/** `ALTER TABLE … ADD COLUMN` unless the column is there already (the step is idempotent). */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** A key this migration owns: written now, replaced if the same step runs again. */
function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ).run(key, value);
}

/** A key written once: the moment of the import is a fact about the first run, not the last. */
function keepMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING').run(key, value);
}

/**
 * Segment every live block that has no sentence rows yet. One transaction, ordered by chapter and
 * position so the ids of a fresh import follow the book; the store's own check makes a block that
 * arrived between two runs a no-op rather than a second set of rows.
 */
function segmentLiveBlocks(db: Db, at: string): void {
  const blocks = db
    .prepare('SELECT id, text FROM blocks ORDER BY chapter, idx')
    .all() as Array<{ id: string; text: string }>;
  const segment = db.transaction(() => {
    for (const block of blocks) {
      if (blockHasSentences(db, block.id)) continue;
      insertImportedSentences(db, { blockId: block.id, text: block.text, at });
    }
  });
  segment();
}

/** The v25 step. A fresh install already has the tables and columns; this passes through. */
export function migrateV25(db: Db): void {
  for (const [table, column, definition] of COLUMN_ADDITIONS) addColumn(db, table, column, definition);
  // Future-proof, not a promise: ADR-041's `edges` is not part of v22, and v25 must not create it.
  if (tableExists(db, 'edges')) addColumn(db, 'edges', 'sentence_id', 'TEXT');

  db.exec(SENTENCE_TABLES_SQL);

  const at = new Date().toISOString();
  segmentLiveBlocks(db, at);

  setMeta(db, 'sentences.segmenter', String(SEGMENTER_VERSION));
  keepMeta(db, 'sentences.migrated_at', at);
  const counts = reanchorComments(db);
  setMeta(db, 'sentences.comment_reanchor', JSON.stringify(counts));
}
