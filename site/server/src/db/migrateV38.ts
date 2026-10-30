/**
 * Migration v38 (BOOK-222, follow-up) — the patch's character edits travel with the candidate.
 *
 * A landing holds its text on the step and publishes nothing before the close, so the one thing
 * a landing used to hand straight to the ingest — `sentences`, the per-block character edit that
 * keeps sentence ids across a patch (BOOK-173 §2, ADR-044 §2.2) — has nothing to be applied to
 * until the close. Without it the publish re-segments the chapter and every id is minted afresh:
 * a one-word fix inside a sentence came back as a new sentence with a new id.
 *
 * `steps.candidate_sentences` is that edit, JSON, beside `candidate_text`/`candidate_sha`: it is
 * cleared when the candidate is replaced, published or dropped, so no close ever applies edits
 * that describe a text nobody landed.
 *
 * Additive and idempotent: the column is guarded by `table_info`, a row written before this step
 * keeps every value it had (and reads as «the candidate carries no patch» — exactly what a
 * rewrite, a draft or an older build wrote). A fresh install declares it in `tables.ts`.
 */

import type { Db } from './db.ts';

/** The columns v38 appends, in the order a fresh install declares them. */
export const V38_STEP_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['candidate_sentences', 'TEXT'],
];

function columnNames(db: Db, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
}

function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (columnNames(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateV38(db: Db): void {
  for (const [column, definition] of V38_STEP_COLUMNS) addColumn(db, 'steps', column, definition);
}
