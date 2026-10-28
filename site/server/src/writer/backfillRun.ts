/**
 * `npm run writer -- --backfill-ledger` — the operator's door to the ripple's graph (BOOK-173).
 *
 * `backfillLedger` is the deterministic half of the ripple: it reads the written chapters and
 * writes `facts`, `mentions` and `edges`. Until this file it had no production caller — the graph
 * existed in tests and on nobody's server — so a real filing could reach no line of prose and the
 * closure was empty for a reason that looked like «nothing depends on it» (review fix 2).
 *
 * What it resolves, and how: the data directory and the book root come from the same
 * `pathsOf(env)` the other flags use, and the database is opened by `databaseFile(dataDir)` — the
 * engine's own path, read short-lived the way `--revert` and `--plan` read it. It writes rows and
 * no manifest: the manuscript is never touched. The run is safe on a live book (a transaction per
 * chapter inside `backfillLedger`) and safe to repeat (every insert is guarded by its own
 * identity, so a second run reports zeros).
 *
 * Exit code: `0` the run finished, `2` the ledger cannot be opened (no database, an unreadable
 * one, or a schema older than the graph).
 */

import { existsSync } from 'node:fs';

import { databaseFile, openDatabase } from '../db/db.ts';
import { backfillLedger } from '../ledger/graph/backfill.ts';
import { toIso } from '../util/time.ts';

export type BackfillCliInput = {
  dataDir: string;
  bookRoot: string;
  now: () => number;
  log: (line: string) => void;
  error: (line: string) => void;
};

/** The ledger tables the run needs: a database without them is «cannot be opened», not a no-op. */
const REQUIRED = ['facts', 'mentions', 'edges'] as const;

export function runBackfillCli(input: BackfillCliInput): number {
  const file = databaseFile(input.dataDir);
  if (!existsSync(file)) {
    input.error('writer: базы нет — бэкфилл некуда писать');
    return 2;
  }
  let db;
  try {
    db = openDatabase(file);
    for (const table of REQUIRED) {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
      if (row === undefined) {
        input.error(`writer: в базе нет таблицы ${table} — схема старше v24, бэкфилл не начат`);
        db.close();
        return 2;
      }
    }
  } catch (error) {
    input.error(`writer: база не открылась: ${error instanceof Error ? error.message : 'отказ'}`);
    return 2;
  }
  try {
    const started = input.now();
    const result = backfillLedger(db, { bookRoot: input.bookRoot, at: toIso(input.now()) });
    const elapsed = input.now() - started;
    input.log(
      `[writer] бэкфилл: фактов ${String(result.facts)}, рёбер ${String(result.edges)}, упоминаний ${String(result.mentions)}; ` +
        `глав ${String(result.chapters.length)}, пропущено ${String(result.skipped.length)}, не прочитано ${String(result.failed.length)}; ` +
        `${String(elapsed)} мс`,
    );
    if (result.failed.length > 0) input.log(`[writer] бэкфилл: не прочитаны главы ${result.failed.join(', ')}`);
    if (result.truncated) input.log('[writer] бэкфилл: предохранитель числа фактов сработал — продолжение на следующем проходе');
    return 0;
  } catch (error) {
    input.error(`writer: бэкфилл не прошёл: ${error instanceof Error ? error.message : 'отказ'}`);
    return 2;
  } finally {
    db.close();
  }
}
