/**
 * v26 — the three push tables (BOOK-189). No backfill, no column, no rebuilt table: a push
 * subscription is something a reader creates after this build ships, and there is nothing on
 * disk to convert.
 *
 * **26, not 24** — 24 is ADR-043's, still unwritten, and this step must never take a number a
 * migration that lands later may claim. The cursor is a list of steps, not a count: v25
 * (`migrateV25.ts`, ADR-044's sentence) is the step before this one, and a database that went
 * from 23 to 25 only gains the push tables when it reaches 26.
 *
 * It lives here rather than inline in `migrate.ts` for the same reason the v22 ledger step
 * does: the statements are shared with the fresh-install schema (`pushTables.ts`), so the two
 * shapes cannot drift, and the reasoning about *why* there are three tables is written once.
 *
 * Idempotent by the table guard: a fresh install has already been created with them by
 * `SCHEMA_SQL`, and a second run of the step must be a no-op rather than a `table exists`
 * error. The indexes are re-run unconditionally — a table is not proof its indexes survived.
 */

import type { Db } from './db.ts';
import {
  PUSH_INDEXES_SQL,
  PUSH_LOG_TABLE_SQL,
  PUSH_OUTBOX_TABLE_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SQL,
} from './pushTables.ts';

export function migrateV26(db: Db): void {
  if (!tableExists(db, 'push_subscriptions')) db.exec(PUSH_SUBSCRIPTIONS_TABLE_SQL);
  if (!tableExists(db, 'push_log')) db.exec(PUSH_LOG_TABLE_SQL);
  if (!tableExists(db, 'push_outbox')) db.exec(PUSH_OUTBOX_TABLE_SQL);
  // Unconditionally, after the tables: a partial earlier run can leave a table without its
  // indexes, and a probe that only looks for tables would call that a healthy database while the
  // claim and the due-row scan fall back to a full scan. Every statement is `IF NOT EXISTS`.
  db.exec(PUSH_INDEXES_SQL);
}

function tableExists(db: Db, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}
