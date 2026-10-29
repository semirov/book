/**
 * BOOK-DOC-84 §10.8 (schema v35) — the ladder's own facts.
 *
 * Two surfaces gain columns and one CHECK grows, so the migration is two shapes:
 *
 *   · `steps` and `comment_attempts` take plain nullable/defaulted columns — the desperate
 *     sixth, the widening code, and the writer's mode. Additive and idempotent.
 *   · `pass_stages` has an inline CHECK over its stage vocabulary, and SQLite cannot widen a
 *     CHECK in place. The table is rebuilt from the same constant a fresh install uses, with
 *     every row and its index kept (the BOOK-61/BOOK-18 style). The step is idempotent: a table
 *     whose SQL already names `revising` is left alone.
 *
 * `attempt`/`iteration` are nullable here on purpose: a stage row written before this migration
 * has no number, and none is invented for it.
 *
 * **v35, not v31.** This step was written as v31 while `main` was at v30 and was renumbered for
 * every number `main` took since — BOOK-117's `steps.reopened_at` (31), BOOK-218's
 * `comments.number` (32), BOOK-173's `change_plans` (33) and BOOK-209's `reader_places` (34).
 * `user_version` only moves forward, so an install already at 34 would never run a step numbered
 * below it, and the reader's place keeps the number main gave it. The step's own `steps.mode`
 * is gone: BOOK-173's plan already records the write mode (`change_plans.mode`), and the ladder's
 * widening is read from `steps.widened` — one knob for one fact.
 */

import type { Db } from './db.ts';
import { PASS_STAGES_TABLE_SQL } from './tables.ts';

/** The columns both the old and the new `pass_stages` carry — the rebuild copies them. */
const SHARED_STAGE_COLUMNS = [
  'seq',
  'pass_id',
  'chapter',
  'stage_seq',
  'stage',
  'at',
  'actor_process',
  'actor_model',
  'change_id',
  'summary',
  'span',
  'tokens_in',
  'tokens_out',
  'cost_usd',
] as const;

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((row) => row.name === column);
}

function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateV35(db: Db): void {
  // The sixth attempt is a fact of the step (the engine re-issues it) and of the filing's reading
  // (the site settles it without a model call); the widening is a code, never a sentence.
  addColumn(db, 'steps', 'desperate', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'steps', 'widened', 'TEXT');
  addColumn(db, 'comment_attempts', 'widened', 'TEXT');
  addColumn(db, 'comment_attempts', 'desperate', 'INTEGER NOT NULL DEFAULT 0');

  const current = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pass_stages'`)
    .get() as { sql: string } | undefined;
  if (current === undefined || current.sql.includes("'revising'")) return;

  // Rebuild without the index line: the index is re-created under the real name after the rename.
  const [tableSql = ''] = PASS_STAGES_TABLE_SQL.split('CREATE INDEX');
  db.exec('DROP INDEX IF EXISTS pass_stages_chapter_seq');
  db.exec(tableSql.replace('CREATE TABLE pass_stages', 'CREATE TABLE pass_stages_v35'));
  const shared = SHARED_STAGE_COLUMNS.join(', ');
  db.exec(`INSERT INTO pass_stages_v35 (${shared}) SELECT ${shared} FROM pass_stages`);
  db.exec('DROP TABLE pass_stages');
  db.exec('ALTER TABLE pass_stages_v35 RENAME TO pass_stages');
  db.exec('CREATE INDEX pass_stages_chapter_seq ON pass_stages(chapter, seq)');
}
