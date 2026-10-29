/**
 * Migration v36 (BOOK-222) — a landing is a **candidate** until the close, and a gate verdict
 * says who answered it.
 *
 * The owner's defect of 2026-10-29: a draft was published as a revision, the gate call then
 * failed, the pass rolled the chapter back and the change closed as a stop — and the reader read
 * our failed check as a refusal of his filing. The rule now is: **no text is served before the
 * verdict.** A pass's text lives on its step as a candidate (`steps.candidate_text`,
 * `candidate_sha`); gates read the candidate; `done` publishes it once, through the same applier
 * every landing uses; a refusal drops it and publishes nothing. `landed_*` keeps its old meaning
 * — the text *was* published — so nothing that reads them has to change.
 *
 * The gate tables gain two columns and nothing else:
 *   · `gate_dispatches.landed_sha` — the sha the gate was handed, so an answer that arrives after
 *     the candidate moved is `CANDIDATE_MOVED` instead of a blessing of text nobody read;
 *   · `gate_verdicts.source` — `model` or `mechanical`, so the record shows when the engine's own
 *     deterministic check answered in place of a model that could not.
 *
 * Additive and idempotent: every column is guarded by `table_info`, a row written before this
 * step keeps every value it had, and both new verdict columns default to what an old row was
 * (`model`). A fresh install declares the same columns in `tables.ts`.
 */

import type { Db } from './db.ts';

/** The columns v36 appends, in the order a fresh install declares them. */
export const V36_STEP_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['candidate_text', 'TEXT'],
  ['candidate_sha', 'TEXT'],
];

function columnNames(db: Db, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
}

function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (columnNames(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateV36(db: Db): void {
  for (const [column, definition] of V36_STEP_COLUMNS) addColumn(db, 'steps', column, definition);
  addColumn(db, 'gate_dispatches', 'landed_sha', 'TEXT');
  addColumn(db, 'gate_verdicts', 'source', "TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model','mechanical'))");
}
