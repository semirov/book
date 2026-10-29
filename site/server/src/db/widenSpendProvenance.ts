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
 * **Crash safety.** A rebuild is four statements, and a process killed between them used to leave
 * the ledger renamed aside — the next boot saw no `pass_spend`, said "nothing to do", and the
 * rows stayed orphaned in `pass_spend_pre_v31` for good. Two rules close that hole: the whole
 * rebuild runs in **one transaction** (SQLite's DDL is transactional, so an interrupted rebuild
 * rolls back to the old table whole), and the function is **resumable** — a leftover
 * `pass_spend_pre_v31` is finished first, whichever statement the previous process died on, and
 * the copy is `INSERT OR IGNORE` keyed by the ledger's own primary key and `pass_id` UNIQUE, so
 * repeating it can never double a row.
 *
 * `steps.provenance` is **not** widened: that column answers *who ran the pass*
 * (`pipeline`/`operator`), and an estimated pass is still the pipeline (`model.ts`
 * `stepProvenance`). The estimate is a fact about the money, and the money's record is here.
 */

import type { Db } from './db.ts';
import { PASS_SPEND_TABLE_SQL } from './schema.ts';

/** The name a rebuild renames the ledger aside to; a leftover here is a rebuild that was cut off. */
const TEMP_TABLE = 'pass_spend_pre_v31';

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

function tableSql(db: Db, name: string): { sql: string } | undefined {
  return db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { sql: string } | undefined;
}

function columnsOf(db: Db, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
}

/** The columns both tables declare — a pre-v21 ledger has no `provenance`, and nothing is guessed. */
function sharedColumns(db: Db, to: string, from: string): string {
  const target = columnsOf(db, to);
  const source = columnsOf(db, from);
  return PASS_SPEND_COLUMNS.filter((column) => target.has(column) && source.has(column)).join(', ');
}

export function widenSpendProvenance(db: Db): void {
  db.transaction(() => rebuild(db))();
}

function rebuild(db: Db): void {
  // 1. Finish a rebuild a previous process was killed in the middle of. `pass_spend` missing means
  //    the death came between RENAME and CREATE: the old table goes back under its own name and the
  //    rebuild below runs again, whole. Both present means the death came after CREATE: the rows
  //    travel once (the idempotent copy below), and the leftover goes.
  if (tableSql(db, TEMP_TABLE) !== undefined) {
    if (tableSql(db, 'pass_spend') === undefined) {
      db.exec(`ALTER TABLE ${TEMP_TABLE} RENAME TO pass_spend`);
    } else {
      const shared = sharedColumns(db, 'pass_spend', TEMP_TABLE);
      db.exec(`INSERT OR IGNORE INTO pass_spend (${shared}) SELECT ${shared} FROM ${TEMP_TABLE}`);
      db.exec(`DROP TABLE ${TEMP_TABLE}`);
    }
  }

  const row = tableSql(db, 'pass_spend');
  // No ledger at all: there is nothing to widen here (an install old enough to predate the table
  // gets it from the version steps, and the probe after this says so if it is still missing).
  if (row === undefined) return;

  if (!row.sql.includes("'pipeline-estimated'")) {
    // A pre-v21 install has no `provenance` column: the rebuild copies what it has and the
    // recreated table takes the column from the constant.
    const byName = columnsOf(db, 'pass_spend');
    const shared = PASS_SPEND_COLUMNS.filter((column) => byName.has(column)).join(', ');
    db.exec('DROP INDEX IF EXISTS pass_spend_day');
    db.exec(`ALTER TABLE pass_spend RENAME TO ${TEMP_TABLE}`);
    db.exec(PASS_SPEND_TABLE_SQL);
    db.exec(`INSERT OR IGNORE INTO pass_spend (${shared}) SELECT ${shared} FROM ${TEMP_TABLE}`);
    db.exec(`DROP TABLE ${TEMP_TABLE}`);
  }
  // The index is part of the shape a rebuild owes: a finished table must answer a day's sum.
  db.exec('CREATE INDEX IF NOT EXISTS pass_spend_day ON pass_spend(day)');
}
