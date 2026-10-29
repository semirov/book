/**
 * BOOK-219 — the money ledger's `provenance` vocabulary gains `pipeline-estimated`.
 *
 * A pass whose provider reported no `usage` is **priced** on an estimate (`provider.ts`), and the
 * ledger has to say so: `priced = 1` (it is priced) with a word that names the estimate, never a
 * `priced = 0` and never a zero. Widening an inline CHECK is something SQLite cannot do in place,
 * so the table is rebuilt — renamed aside, recreated from the same constant a fresh install uses,
 * copied, dropped, with its index dropped first so the recreated one can take the name (the
 * BOOK-18/BOOK-43 style, and the same shape `widenPassSpend.ts` built for `triage`).
 *
 * Idempotent: a table whose SQL already names `pipeline-estimated` is left alone, so a fresh
 * install (created at the newest version) and an upgraded one agree exactly.
 *
 * It runs from `migrate()` as a boot guard rather than as a version step (`ensureStepLifecycle`
 * is the same shape): moving the cursor would rewrite every install's `user_version` for a
 * rebuild that is already idempotent, and the probe after it still sees one shape.
 *
 * `steps.provenance` is **not** widened: that column answers *who ran the pass*
 * (`pipeline`/`operator`), and an estimated pass is still the pipeline (`model.ts`
 * `stepProvenance`). The estimate is a fact about the money, and the money's record is here.
 */

import type { Db } from './db.ts';
import { PASS_SPEND_TABLE_SQL } from './schema.ts';

/** The ledger columns a rebuild copies, in the order both table definitions declare them. */
const PASS_SPEND_COLUMNS = [
  'id',
  'at',
  'day',
  'pass_id',
  'chapter',
  'pass',
  'change_id',
  'model',
  'tokens_in',
  'tokens_out',
  'usd',
  'priced',
  'provenance',
] as const;

export function widenSpendProvenance(db: Db): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pass_spend'`)
    .get() as { sql: string } | undefined;
  if (row === undefined || row.sql.includes("'pipeline-estimated'")) return;
  // An install old enough to predate v21 has no `provenance` column yet; the rebuild then copies
  // what it has and the recreated table takes the column from the constant.
  const byName = new Set(
    (db.pragma('table_info(pass_spend)') as Array<{ name: string }>).map((column) => column.name),
  );
  const shared = PASS_SPEND_COLUMNS.filter((column) => byName.has(column)).join(', ');
  db.exec('DROP INDEX IF EXISTS pass_spend_day');
  db.exec('ALTER TABLE pass_spend RENAME TO pass_spend_pre_v31');
  db.exec(PASS_SPEND_TABLE_SQL);
  db.exec(`INSERT INTO pass_spend (${shared}) SELECT ${shared} FROM pass_spend_pre_v31`);
  db.exec('DROP TABLE pass_spend_pre_v31');
}
