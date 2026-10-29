/**
 * Migration v34 (BOOK-209, requirement 3) — the reader's place: where each signed-in reader
 * stopped reading, kept server-side so a second device resumes on the same sentence.
 *
 * One table, one row per identity, and the row is an **anchor**, never a scroll offset: `chapter`
 * plus `sentence_id` (a block id and a sentence index inside it) name the sentence, `delta_px`
 * says how far below the reading line it sat, and `at` is the visiting device's own clock. The
 * prose is rewritten between two visits, so a stored pixel height would point nowhere; an anchor
 * is resolved against the text the reader is served now.
 *
 * `identity_id` is a foreign key, like every other per-identity table (`sessions`,
 * `contributions`): `identities.id` is that table's primary key, so the reference is natural, and
 * `ON DELETE CASCADE` means a forgotten identity leaves no trace of where its owner was reading.
 *
 * **A fresh install equals a migrated one.** The table comes from `READER_PLACES_TABLE_SQL` in
 * `schema.ts` — the same constant `SCHEMA_SQL` embeds — so the migrated column order, NOT NULL
 * flags and foreign key are the fresh install's too, rather than a second declaration of the
 * shape that could drift.
 *
 * The step is additive and idempotent to the statement: `CREATE TABLE IF NOT EXISTS` leaves an
 * install that already has the table untouched, so a fresh install (created at the newest version
 * already) and a replay both pass through without a rebuild and without losing a row.
 *
 * **34, not 30:** the cursor has passed 30 — BOOK-206 took 30, BOOK-117's `steps.reopened_at`
 * took 31, BOOK-218's `comments.number` took 32 and BOOK-173's frozen plan took 33 — so this step
 * appends after them.
 */

import { READER_PLACES_TABLE_SQL } from './schema.ts';
import type { Db } from './db.ts';

/**
 * The v34 step. `run` is a transaction in `migrate`, so a failure here leaves neither a half-built
 * table nor a bumped `user_version`.
 */
export function migrateV34(db: Db): void {
  db.exec(READER_PLACES_TABLE_SQL);
}
