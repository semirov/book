/**
 * BOOK-61 — the two gate tables gain the conditional `rights` role, and `gate_verdicts` couples
 * its verdict to the role. Split out of `migrate.ts` the way `widenPassSpend.ts` and
 * `widenSpendProvenance.ts` are: the migration table is at its size limit, and a version step
 * that rebuilds tables is a module of its own.
 *
 * SQLite cannot widen an inline CHECK, so both tables are rebuilt — renamed aside, recreated
 * from the same constant a fresh install uses, copied, dropped. The step is idempotent: a table
 * whose SQL already names `rights` is left alone.
 */

import type { Db } from './db.ts';
import { GATE_TABLES_SQL } from './schema.ts';

/** The columns both the v13 gate tables and the v14 ones carry — the rebuild copies them. */
const DISPATCH_COLUMNS = ['step_id', 'role', 'session', 'dispatched_at', 'expires_at'] as const;
const VERDICT_COLUMNS = [
  'step_id',
  'role',
  'verdict',
  'findings',
  'cycles',
  'model',
  'tokens_in',
  'tokens_out',
  'at',
  'late',
] as const;

export function widenGateRoles(db: Db): void {
  const sql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gate_verdicts'`)
    .get() as { sql: string } | undefined;
  if (sql === undefined || sql.sql.includes("'rights'")) return;
  db.exec('ALTER TABLE gate_dispatches RENAME TO gate_dispatches_v13');
  db.exec('ALTER TABLE gate_verdicts RENAME TO gate_verdicts_v13');
  db.exec(GATE_TABLES_SQL);
  const dispatches = DISPATCH_COLUMNS.join(', ');
  db.exec(
    `INSERT INTO gate_dispatches (${dispatches}) SELECT ${dispatches} FROM gate_dispatches_v13`,
  );
  const verdicts = VERDICT_COLUMNS.join(', ');
  db.exec(`INSERT INTO gate_verdicts (${verdicts}) SELECT ${verdicts} FROM gate_verdicts_v13`);
  db.exec('DROP TABLE gate_dispatches_v13');
  db.exec('DROP TABLE gate_verdicts_v13');
}
