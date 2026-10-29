/**
 * Migration v29 (BOOK-185 stage 3, BOOK-DOC-77) — the graph the model fills and code judges, on
 * the volume that already holds the book (ADR-043, BOOK-DOC-76: the rows are the home of the
 * text).
 *
 * Three things happen here, and none of them changes a row's meaning:
 *
 *   · `extraction_runs` — one row per model call: what was asked (`chapter`, `rev`, `text_sha`,
 *     `prompt_sha`, `model`, `pass`), what came back (the raw `response`), what it cost and what
 *     the validator kept. The row is append-only: the tuple is a plain index, so a forced re-ask
 *     adds another answer instead of rewriting the one the book was built from, and reuse reads
 *     the **latest** `status = 'ok'` row;
 *   · `facts` is **rebuilt** with the columns BOOK-185 gives a fact — `key`, the normalised
 *     identity the extraction derives, and `sentence`, the sentence that first asserts it — plus
 *     the provenance of BOOK-DOC-77 (`extracted_by`, `superseded_by_extraction`) and the widened
 *     `kind` CHECK, from the ledger's five words to the seven carriers plus the three ledger
 *     words. SQLite cannot widen an inline CHECK, so the new shape is built beside the old table,
 *     filled from it and swapped in: the same constant a fresh install reads, which is what makes
 *     «a migrated install equals a fresh one» a property rather than a hope. ADR-044's
 *     `sentence_id` (v25) and every other v28 column is copied as it stands;
 *   · `fact_dependency` (ADR-040 §2.1) is created with its two indexes, and `threads` gains
 *     `extracted_by`.
 *
 * **The step invents nothing.** A row written before v29 keeps every value it had and reads
 * `key = ''`, `sentence = ''` and `extracted_by = ''`: it was never given an identity, an
 * asserting sentence or a run, and a migration that guessed one would put a made-up fact in the
 * graph the closure trusts. `superseded_by_extraction` stays NULL — no run retired it.
 *
 * **A fresh install equals a migrated one.** Every object comes from `ledgerTables.ts`, which
 * `SCHEMA_SQL`, `migrateV22`, the reset and this step all read, and `ADD COLUMN` appends, so the
 * migrated column order, NOT NULL flags, defaults and foreign keys are the fresh install's too.
 *
 * Idempotent to the statement: a table that already has every column and the whole kind
 * vocabulary is left untouched, so a fresh install — created at the newest version already — and
 * a replayed step both pass through without a rebuild.
 *
 * **29, not 23/24:** main owns v23–v28 (the author marker, the sentence, the push tables, the
 * disposition chain, the book's own state), and v24 is still ADR-043's reserved number, so this
 * step appends after them.
 */

import type { Db } from './db.ts';
import {
  EXTRACTION_RUNS_TABLE_SQL,
  FACT_DEPENDENCY_TABLE_SQL,
  FACT_KINDS,
  FACTS_COLUMNS,
  FACTS_INDEXES_SQL,
  FACTS_KEY_INDEX_SQL,
  FACTS_TABLE_SQL,
  FACTS_TRIGGER_SQL,
  factsTableSql,
} from './ledgerTables.ts';

const FACTS_INDEX_NAMES = ['facts_asof', 'facts_term', 'facts_key_live'] as const;
/** The new shape while the old one still holds the name: `facts` is the table every child names. */
const FACTS_REBUILD_TABLE = 'facts_v29';

function columnNames(db: Db, table: string): Set<string> {
  const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(info.map((column) => column.name));
}

function tableExists(db: Db, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** `ALTER TABLE … ADD COLUMN` unless the column is already there — every step is idempotent. */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (!columnNames(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** The `facts` table a fresh install builds: every column and every kind word. */
export function factsShapeIsCurrent(db: Db): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'facts'`)
    .get() as { sql: string } | undefined;
  if (row === undefined) return false;
  const columns = columnNames(db, 'facts');
  if (!FACTS_COLUMNS.every((column) => columns.has(column))) return false;
  return FACT_KINDS.every((kind) => row.sql.includes(`'${kind}'`));
}

/**
 * Rebuild `facts` to the v29 shape. Returns whether the table was rebuilt, so a caller can tell a
 * no-op from a rewrite. The table, its indexes and its trigger come from the same constants
 * `SCHEMA_SQL` uses; nothing here is a second declaration of the shape.
 */
export function rebuildFacts(db: Db): boolean {
  const columns = columnNames(db, 'facts');
  if (columns.size === 0) {
    db.exec(FACTS_TABLE_SQL);
    db.exec(FACTS_INDEXES_SQL);
    db.exec(FACTS_KEY_INDEX_SQL);
    db.exec(FACTS_TRIGGER_SQL);
    return true;
  }
  if (factsShapeIsCurrent(db)) {
    // The one index that is not in the shared ledger text — it names `key`, which a pre-v29 table
    // lacks — still has to exist, or a skipped rebuild and a fresh install differ index for index.
    db.exec(FACTS_KEY_INDEX_SQL);
    return false;
  }
  // `migrate` runs every step with `foreign_keys` off, which is what makes dropping the old table
  // legal while `mentions` and `thread_events` still name it. A caller outside a transaction gets
  // the same guarantee here; inside one the pragma cannot change, and the step then fails loudly
  // rather than leaving a half-rebuilt table.
  const foreignKeys = Number(db.pragma('foreign_keys', { simple: true }) ?? 0);
  const switchForeignKeys = foreignKeys === 1 && !db.inTransaction;
  if (switchForeignKeys) db.pragma('foreign_keys = OFF');
  // A savepoint, not a transaction: `migrate` already holds one, and the swap has to be
  // all-or-nothing for a caller that does not — the book must never be left without `facts`.
  db.exec('SAVEPOINT facts_v29');
  try {
    // The trigger and the indexes are recreated from the constants below, so they go first: an
    // index would otherwise travel with whichever table this step leaves behind.
    db.exec('DROP TRIGGER IF EXISTS facts_no_delete');
    for (const index of FACTS_INDEX_NAMES) db.exec(`DROP INDEX IF EXISTS ${index}`);
    db.exec(`DROP TABLE IF EXISTS ${FACTS_REBUILD_TABLE}`);
    db.exec(factsTableSql(FACTS_REBUILD_TABLE));
    // Only the columns the old table actually has are copied; the new ones take their defaults.
    // A pre-v29 row was never given a key, a sentence or a run and keeps none.
    const shared = FACTS_COLUMNS.filter((column) => columns.has(column));
    db.exec(
      `INSERT INTO ${FACTS_REBUILD_TABLE} (${shared.join(', ')})
         SELECT ${shared.join(', ')} FROM facts`,
    );
    db.exec('DROP TABLE facts');
    db.exec(`ALTER TABLE ${FACTS_REBUILD_TABLE} RENAME TO facts`);
    db.exec(FACTS_INDEXES_SQL);
    db.exec(FACTS_KEY_INDEX_SQL);
    db.exec(FACTS_TRIGGER_SQL);
    db.exec('RELEASE facts_v29');
  } catch (error) {
    db.exec('ROLLBACK TO facts_v29');
    db.exec('RELEASE facts_v29');
    throw error;
  } finally {
    if (switchForeignKeys) db.pragma('foreign_keys = ON');
  }
  return true;
}

/**
 * The v29 step: the run ledger, the rebuilt `facts` and the edge table. `run` is a transaction in
 * `migrate`, so a failure here leaves neither a half-rebuilt table nor a bumped `user_version`.
 *
 * Order matters: `extraction_runs` before the rebuild, because the new `facts` carries a foreign
 * key to it; `fact_dependency` after, because it names `facts` in both of its end columns.
 */
export function migrateV29(db: Db): void {
  db.exec(EXTRACTION_RUNS_TABLE_SQL);
  rebuildFacts(db);
  db.exec(FACT_DEPENDENCY_TABLE_SQL);
  // `threads` may predate this step (the ledger created it at v22) or already carry the column
  // (a fresh install); `ADD COLUMN` appends, so the two shapes stay equal.
  if (tableExists(db, 'threads')) addColumn(db, 'threads', 'extracted_by', `TEXT NOT NULL DEFAULT ''`);
}
