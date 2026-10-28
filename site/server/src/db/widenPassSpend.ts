/**
 * BOOK-158 — the money ledger's `pass` vocabulary gains `triage`.
 *
 * The attempt ledger charges the model call a refusal or an acceptance took to the same
 * `pass_spend` table the writer lane closes into, because a spend total must have one source
 * (`budget.ts`: totals are always `SUM(usd)` over the ledger). That widens an inline CHECK, and
 * SQLite cannot alter one in place: the table is rebuilt — renamed aside, recreated from the
 * same constant a fresh install uses, copied, dropped — with its index dropped first so the
 * recreated one can take the name (the BOOK-18/BOOK-43 style). Idempotent: a table whose SQL
 * already names `triage` is left alone, so a fresh install and a migrated v19 agree exactly.
 *
 * It lives apart from `migrate.ts` only because that file is at its 500-line arch bound.
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
] as const;

export function widenPassSpend(db: Db): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pass_spend'`)
    .get() as { sql: string } | undefined;
  if (row === undefined || row.sql.includes("'triage'")) return;
  const shared = PASS_SPEND_COLUMNS.join(', ');
  db.exec('DROP INDEX IF EXISTS pass_spend_day');
  db.exec('ALTER TABLE pass_spend RENAME TO pass_spend_v19');
  db.exec(PASS_SPEND_TABLE_SQL);
  db.exec(`INSERT INTO pass_spend (${shared}) SELECT ${shared} FROM pass_spend_v19`);
  db.exec('DROP TABLE pass_spend_v19');
}
