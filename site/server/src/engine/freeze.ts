/**
 * F025 — the ending freeze (ARCHITECTURE.md §6C.4, §13.4, ADR-024).
 *
 * «Конец фиксирован» is a promise to the reader, so it is an invariant, not a convention:
 * **no revision of the last chapter may have `cause_kind='cascade'`**. The ripple may walk up to
 * the last chapter, but it stops outside it and opens one `ending` step that *evaluates* the
 * ending without writing it. A cascade step that reaches the last chapter is therefore a planning
 * bug, and the engine must refuse to close a step on top of one instead of publishing a
 * rewritten ending.
 *
 * The check reads the revision table, not the plan: it catches a bug wherever the row came
 * from — a planner, a stray ingest with a lease, a manual edit of the database.
 */

import { TOTAL_CHAPTERS } from '@book/shared';

import type { Db } from '../db/db.ts';
import { refuse } from './types.ts';

type OffendingRow = { chapter: number; rev: number; at: string };

/** Throws `ENDING_FROZEN` when the ending has been rewritten by a ripple step. */
export function assertEndingFreeze(db: Db): void {
  const row = db
    .prepare(
      `SELECT chapter, rev, at FROM revisions
        WHERE chapter = ? AND cause_kind = 'cascade'
        ORDER BY rev LIMIT 1`,
    )
    .get(TOTAL_CHAPTERS) as OffendingRow | undefined;
  if (row === undefined) return;
  refuse(
    'ENDING_FROZEN',
    409,
    `глава ${String(TOTAL_CHAPTERS)} переписана волной (rev ${row.rev}): конец фиксирован (F025, ADR-024)`,
    row,
  );
}
