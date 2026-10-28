/**
 * Migration v24 (BOOK-173, BOOK-DOC-75) — the graph a consequence walks on.
 *
 * Two things are added, and neither touches a row that exists:
 *
 *   · `edges` — «this fact stands on that one», with the component of the source the target
 *     consumes (`on_component`) and who wrote the row (`origin`). `fact_dependency`, the owner's
 *     name for the relation, is a view over it, so the name a reader was promised is queryable
 *     without a second copy of the data;
 *   · `change_plans` — the frozen plan of a change: the closure without its patches, the patches
 *     the writer produced, the caps frozen at estimate, the fixpoint's iteration journal, the
 *     lane claim and the park.
 *
 * Both statements live in `ledgerTables.ts` next to the tables v22 created, so a fresh install
 * (which reads them from `SCHEMA_SQL`) and an upgraded one (which reads them from here) build the
 * same objects — table for table, index for index, view for view. Every statement is
 * `IF NOT EXISTS`: a database that already ran this step, or a fresh one that got the tables
 * before the migration ran, passes through untouched.
 *
 * v24, not v23: the author marker (`migrateV23.ts`) took 23 first on `main`. An install that
 * already carries 23 must still run this step — a shared version number would skip it silently
 * and leave a server without `edges` or `change_plans`.
 */

import type { Db } from './db.ts';
import { CHANGE_PLANS_SQL, LEDGER_GRAPH_SQL } from './ledgerTables.ts';

export function migrateV24(db: Db): void {
  db.exec(LEDGER_GRAPH_SQL);
  db.exec(CHANGE_PLANS_SQL);
}
