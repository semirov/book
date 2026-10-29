/**
 * Migration v31 (BOOK-173, BOOK-DOC-75 §3, BOOK-DOC-80) — the frozen plan of a change: the mode
 * it was written in, the money it was priced at, and the record of its verification.
 *
 * **The graph is not here.** `main`'s v29 (BOOK-185 stage 3, BOOK-DOC-77) already owns the graph
 * the ripple walks — `fact_dependency` with its `"from"`/`"to"` ends, `extraction_runs`, the
 * rebuilt `facts` — and this step adds the one object the ripple keeps of its own: `change_plans`.
 *
 * The step is **additive and touches no row that exists**:
 *
 *   · `change_plans` — the frozen plan of a change: the closure without its patches, the patches
 *     the writer produced, the caps frozen at estimate, the fixpoint's iteration journal, the
 *     lane claim and the park — plus `mode` (`patch`|`rewrite`) and `price_usd`: the estimate
 *     frozen with the plan, replaced by the actual when the pass closes, so a change carries how
 *     it was written and what it cost rather than leaving both to a log line;
 *   · the verification record of that plan (BOOK-DOC-80): `tier1_verdict`, `tier1_usd`,
 *     `gates_mode`, and the safeguard's queue — `sample_requested`, `sampled_at`,
 *     `sample_verdict`. All nullable (or defaulted to 0) because every plan written before this
 *     step was verified by the full pair and has nothing to say here.
 *
 * The table lives in `ledgerTables.ts` next to the ledger's own, so a fresh install (which reads
 * it from `SCHEMA_SQL`) and an upgraded one (which reads it from here) build the same objects —
 * table for table, index for index. Every statement is `IF NOT EXISTS` and every column is added
 * only when `table_info` lacks it, so a database that already ran this step, a fresh one that got
 * the table before the migration ran, and an install that carries it in its pre-`mode` shape all
 * converge on the same schema.
 *
 * **v31, not v24/26/29/30.** This step was written as v24 while `main` was at v23 and renumbered
 * for every number `main` took since — the sentence (25), the push tables (26), the disposition
 * chain (27), the book's own state (28), BOOK-185's graph (29) and BOOK-206's triage ledger (30).
 * `user_version` only moves forward: an install already at 30 would never run a step numbered
 * below it, so it would boot without `change_plans` — a lane that can plan nothing and drain
 * nothing. It is **31** now, so every upgrade path (fresh, 22, 23, 25, 27, 28, 29, 30) arrives at
 * the same schema.
 */

import type { Db } from './db.ts';
import { CHANGE_PLANS_SQL } from './ledgerTables.ts';

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

export function migrateV31(db: Db): void {
  db.exec(CHANGE_PLANS_SQL);
  for (const [column, definition] of COLUMN_ADDITIONS) addColumn(db, 'change_plans', column, definition);
}
