/**
 * Migration v26 (BOOK-173, BOOK-DOC-75) — the graph a consequence walks on, and the plan of a
 * change with the mode and the price it was written in.
 *
 * The step is **additive and touches no row that exists**:
 *
 *   · `edges` — «this fact stands on that one», with the component of the source the target
 *     consumes (`on_component`) and who wrote the row (`origin`). `fact_dependency`, the owner's
 *     name for the relation, is a view over it, so the name a reader was promised is queryable
 *     without a second copy of the data;
 *   · `change_plans` — the frozen plan of a change: the closure without its patches, the patches
 *     the writer produced, the caps frozen at estimate, the fixpoint's iteration journal, the
 *     lane claim and the park — plus, from this version, `mode` (`patch`|`rewrite`) and
 *     `price_usd`: the estimate frozen with the plan, replaced by the actual when the pass
 *     closes, so a change carries how it was written and what it cost rather than leaving both
 *     to a log line.
 *   · the verification record of that plan (BOOK-DOC-80): `tier1_verdict`, `tier1_usd`,
 *     `gates_mode`, and the safeguard's queue — `sample_requested`, `sampled_at`,
 *     `sample_verdict`. All nullable (or defaulted to 0) because every plan written before this
 *     step was verified by the full pair and has nothing to say here.
 *
 * Both statements live in `ledgerTables.ts` next to the tables v22 created, so a fresh install
 * (which reads them from `SCHEMA_SQL`) and an upgraded one (which reads them from here) build the
 * same objects — table for table, index for index, view for view. Every statement is
 * `IF NOT EXISTS` and every column is added only when `table_info` lacks it, so a database that
 * already ran this step, a fresh one that got the tables before the migration ran, and an install
 * that carries the tables in their pre-`mode` shape all converge on the same schema.
 *
 * **v26, not v24.** This step was written as v24 while `main` was at v23; the sentence (ADR-044,
 * BOOK-182) then took **25** on `main` while this branch held 24, and `main` has no v24 at all.
 * `user_version` only moves forward: an install already at 25 would never run a step numbered 24,
 * so it would boot without `edges` or `change_plans` — a server that answers every consequence
 * with nothing. Renumbering to 26 is what makes the four upgrade paths (22, 23, 25, fresh) all
 * arrive at the same schema.
 */

import type { Db } from './db.ts';
import { CHANGE_PLANS_SQL, LEDGER_GRAPH_SQL } from './ledgerTables.ts';

/** Columns `change_plans` gains in this step, for an install that created the table earlier. */
const COLUMN_ADDITIONS: ReadonlyArray<readonly [column: string, definition: string]> = [
  ['mode', "TEXT CHECK (mode IN ('patch','rewrite'))"],
  ['price_usd', 'REAL'],
  // BOOK-DOC-80: the verification record and the sample queue of a `local only` change.
  ['tier1_verdict', "TEXT CHECK (tier1_verdict IN ('HOLDS','GAP','UNSURE','TIER1_UNPARSED'))"],
  ['tier1_usd', 'REAL'],
  ['gates_mode', "TEXT CHECK (gates_mode IN ('local only','full','local_only_rechecked'))"],
  ['sample_requested', 'INTEGER NOT NULL DEFAULT 0'],
  ['sampled_at', 'TEXT'],
  ['sample_verdict', "TEXT CHECK (sample_verdict IN ('ok','gap','error'))"],
];

function addColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateV26(db: Db): void {
  db.exec(LEDGER_GRAPH_SQL);
  db.exec(CHANGE_PLANS_SQL);
  for (const [column, definition] of COLUMN_ADDITIONS) addColumn(db, 'change_plans', column, definition);
}
