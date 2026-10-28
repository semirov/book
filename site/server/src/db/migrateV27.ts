/**
 * v27 — the disposition of a filing (BOOK-174 comment #3888, BOOK-DOC-78).
 *
 * A filing is never thrown away, only read: `as_said`, `through_paper`, `refused_in_world`, or
 * `inadmissible` under one of four locks — and `escalated` when the ladder cannot place it and
 * the author must decide. The five columns are that reading, stored once with the decision; the
 * `disposition_counts` table is the editor's view of how often the world refuses, recomputed
 * from `comments` and never read by a reader surface.
 *
 * The step lives here rather than inside `migrate.ts`, like the v22 ledger and the v23 author
 * marker: the SQL is one call, the decision is documented once. Every statement is guarded, so
 * a fresh v27 install (which is created with the columns already) is left untouched.
 */

import { DISPOSITION_COUNTS_TABLE_SQL } from './tables.ts';
import type { Db } from './db.ts';

export function migrateV27(db: Db): void {
  // `ALTER TABLE … ADD COLUMN` unless the column is already there: the step runs on a fresh
  // install too, and a build that runs it twice must not fail. The CHECK travels with the
  // column, so a migrated install has the same shape as a fresh one, column for column.
  addColumn(
    db,
    'comments',
    'disposition',
    `TEXT CHECK (disposition IN ('as_said','through_paper','refused_in_world','inadmissible','escalated'))`,
  );
  addColumn(db, 'comments', 'lock', `TEXT CHECK (lock IN ('rights','harm','frame','finale'))`);
  addColumn(
    db,
    'comments',
    'carrier_kind',
    `TEXT CHECK (carrier_kind IN ('document','speech','registry_discrepancy','numbered_object','unheeded_joke','obligatory_joke'))`,
  );
  addColumn(db, 'comments', 'quote_kept', 'TEXT');
  // ADR-044's `sentence_id` (v25) is the anchor a decision records; it is not added here.
  // The same constant a fresh install uses, so the two cannot drift apart.
  db.exec(DISPOSITION_COUNTS_TABLE_SQL);
}

/** `ALTER TABLE … ADD COLUMN` unless the column is already there (the migration's own guard). */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
