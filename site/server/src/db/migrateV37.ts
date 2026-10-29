/**
 * Migration v37 (BOOK-206, owner's correction 2026-10-29) — a read is bounded by **attempts**,
 * not by hours: «нет, сроков не надо — только конечное количество попыток».
 *
 * The attempt ledger gains the three columns the six-attempt ladder keeps on the row it decides:
 *   · `widened` — the widening code from `stateWords.ts` (`'as-document'`) once the third failure
 *     stops the narrow reading and accepts the next rung of the ladder; NULL while the narrow rung
 *     is still insisted on (BOOK-220's v35 already appends it alongside `desperate`);
 *   · `widening_note` — why it was widened, in words, for the operator (never the reader);
 *   · `desperate` — 1 on the sixth attempt, the one the engine answers itself with the coded floor
 *     rung and no model call.
 *
 * Additive and idempotent: every column is guarded by `table_info`, and a row written before this
 * step reads as a narrow, non-desperate attempt — which is what it was. A fresh install declares
 * the same columns in `tables.ts`.
 */

import type { Db } from './db.ts';

/** The columns v37 appends, in the order a fresh install declares them. */
export const V37_ATTEMPT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['widened', 'TEXT'],
  ['desperate', 'INTEGER NOT NULL DEFAULT 0'],
  ['widening_note', 'TEXT'],
];

function columnNames(db: Db, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
}

function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (columnNames(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateV37(db: Db): void {
  for (const [column, definition] of V37_ATTEMPT_COLUMNS) addColumn(db, 'comment_attempts', column, definition);
}
