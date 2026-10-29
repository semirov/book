/**
 * BOOK-206 (ADR-045 §2, §4, §5) — the reading's refusal sink: one of the two ends a filing has.
 *
 * A **filing** is the comment row; the thing a model is asked to read is an **attempt**
 * (`attempts.ts` writes it, its claim and its schedule live in `triageLedger.ts`). This module is
 * the second sink of that ledger — the read that never happened.
 *
 * The one rule the whole module serves: **no filing waits forever.** A read ends in one of two
 * sinks — an answer (`verdict`, `triageLedger.ts`) or a refusal (`refuseTriage`), and a refusal is
 * reached without a model: a claim with no process left behind it, and the total deadline
 * (`TRIAGE_DEADLINE_MS`) spent with no verdict. Below the cap a failed call only moves `next_at`
 * and widens the reading; it never decides anything.
 */

import { TRIAGE_REFUSED_LINE } from '@book/shared';

import type { Db } from '../db/db.ts';

/**
 * The longest a filing may wait for its read: **30 minutes**. Three calls at 120 s plus the
 * ladder's backoffs is the whole schedule a broken provider or a killed writer can spend, and a
 * deadline a few minutes past that sum is the whole margin; a reader who wrote a text and waited
 * half an hour is owed an answer, not a fourth queue place.
 *
 * It is measured from the later of the attempt's own submission and Gate B's clearance: the
 * rights door can hold a filing for hours waiting on a person's source, and a deadline that
 * spent that wait would refuse a filing the moment it became readable.
 */
export const TRIAGE_DEADLINE_MS = 30 * 60_000;

/** One attempt whose read can no longer happen, and why the sweep found it. */
export type EndedTriage = { commentId: string; n: number; tries: number };

/**
 * The filings whose **deadline** has passed with no verdict and no live claim: `submitted`, no
 * verdict, and the later of the attempt's submission and Gate B's clearance older than
 * `TRIAGE_DEADLINE_MS`. A claim still running is skipped — a call in flight is never cut — and
 * its own lease (15 min) bounds how long that can hold the sweep off.
 *
 * These rows, with the ones the engine's cap sweep finds, are the only way out of `dueTriage`
 * besides an answer: both end the filing `rejected` with `TRIAGE_REFUSED_LINE`, never silently.
 */
export function overdueTriage(db: Db, now: string, limit = 8): EndedTriage[] {
  const deadline = new Date(Date.parse(now) - TRIAGE_DEADLINE_MS).toISOString();
  return db
    .prepare(
      `SELECT c.id AS commentId, a.n AS n, a.tries AS tries
         FROM comments c
         JOIN comment_attempts a ON a.comment_id = c.id
        WHERE c.status = 'new' AND c.disposition IS NULL
          AND c.rights_verdict = 'CLEAR'
          AND a.n = (SELECT MAX(n) FROM comment_attempts WHERE comment_id = c.id)
          AND a.outcome = 'submitted'
          AND a.verdict IS NULL
          AND (a.claim_until IS NULL OR a.claim_until <= ?)
          AND max(a.at, COALESCE(c.rights_at, a.at)) <= ?
        ORDER BY c.created_at, c.id
        LIMIT ?`,
    )
    .all(now, deadline, limit) as EndedTriage[];
}

/**
 * End the filing in the refusal sink — the one place this ledger settles a filing it could not
 * read. The attempt is closed `refused` (never `submitted`, so no query and no tick can pick it up
 * again), the row becomes `rejected` with the one sentence a reader understands, and the moment is
 * stored. One transaction, and `true` only for the caller that moved it: a replayed `fail`, a
 * sweep racing the writer, or a row the applier already placed answers `false` and owes no alert.
 *
 * The sentence is `TRIAGE_REFUSED_LINE` and never a code: «заявка отклонена» is the second sink,
 * and the engine writes the `triage.failed` event (`retryAt: null`) the site's bridge already
 * drains into a `comment:decision` frame (`engineState/bridge.ts`).
 */
export function refuseTriage(db: Db, input: { commentId: string; n: number; at: string }): boolean {
  const run = db.transaction((): boolean => {
    const settled = db
      .prepare(
        `UPDATE comment_attempts
            SET outcome = 'refused', decided_at = ?, next_at = NULL, claim_by = NULL, claim_until = NULL
          WHERE comment_id = ? AND n = ? AND outcome = 'submitted' AND verdict IS NULL`,
      )
      .run(input.at, input.commentId, input.n).changes;
    if (settled !== 1) return false;
    const moved = db
      .prepare(
        `UPDATE comments SET status = 'rejected', reason = ?, decided_at = ?
          WHERE id = ? AND status = 'new' AND disposition IS NULL`,
      )
      .run(TRIAGE_REFUSED_LINE, input.at, input.commentId).changes;
    return moved === 1;
  });
  return run();
}
