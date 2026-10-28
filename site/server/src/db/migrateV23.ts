/**
 * Migration v23 (BOOK-187, decisions ADR-043 and ADR-041) — the book's own state leaves the
 * filesystem.
 *
 * Four additive tables (`book_frame`, `writer_state`, `pass_transcripts`, `block_deltas`), and
 * one seed: the two canon sentences. Nothing is rebuilt, no row changes shape, so an upgraded
 * v22 install and a fresh one are indistinguishable afterwards — both get the tables from the
 * same constant (`V23_TABLES_SQL`), and both get the seed from the same function below.
 *
 * **The frame is seeded from the constants the image compiles in**, never from a file and never
 * from a copy typed here: `FRAME_FIRST_SENTENCE` for ch01/`first` and `FRAME_LAST_SENTENCE` for
 * ch42/`last`, read from `@book/shared`. The DB row is the *served* text (the volume is the book,
 * ADR-043 G2) while the constant stays the independent witness the three-source check compares
 * against (G6) — which is why both the `text` and its `sha256` are stored.
 *
 * `ON CONFLICT(chapter, position) DO NOTHING` makes the seed idempotent in the strong sense: a
 * second run, a re-migration after a rollback or an operator's deliberate edit of a row is never
 * overwritten by the image's copy. `seeded_at` records the moment the row first appeared.
 */

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, OPENING_CHAPTER, TOTAL_CHAPTERS } from '@book/shared';

import { sha256Hex } from '../util/hash.ts';
import type { Db } from './db.ts';
import { V23_TABLES_SQL } from './tables.ts';

/** The two rows the canon is, and the position each one holds in the book. */
export const FRAME_SEED = [
  { chapter: OPENING_CHAPTER, position: 'first', text: FRAME_FIRST_SENTENCE },
  { chapter: TOTAL_CHAPTERS, position: 'last', text: FRAME_LAST_SENTENCE },
] as const;

/**
 * Insert the two canon rows if they are not there yet. Called by the v23 step and by nothing
 * else: a fresh install runs the step too, so it reads the same text from the same constants.
 */
export function seedFrame(db: Db, at: string): void {
  const insert = db.prepare(
    `INSERT INTO book_frame (chapter, position, text, sha256, seeded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chapter, position) DO NOTHING`,
  );
  for (const row of FRAME_SEED) insert.run(row.chapter, row.position, row.text, sha256Hex(row.text), at);
}

/**
 * The v23 step. Every statement is idempotent — `IF NOT EXISTS` for each object and
 * `DO NOTHING` for each seeded row — so a database that already ran it passes through untouched.
 */
export function migrateV23(db: Db, at: string = new Date().toISOString()): void {
  db.exec(V23_TABLES_SQL);
  seedFrame(db, at);
}
