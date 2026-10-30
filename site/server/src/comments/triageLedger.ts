/**
 * BOOK-206 (ADR-045 §2) / BOOK-DOC-84 §10.8 — the reading's ledger: the claim, the schedule, the
 * one stored verdict, and the ladder's counters.
 *
 * Split out of `attempts.ts` when §10's amendment pushed that file past the arch bound; the
 * functions are re-exported from `attempts.ts`, so no call site moved.
 */

import { READING_RESCHEDULED_LINE } from '@book/shared';

import type { Db } from '../db/db.ts';

const DAY_MS = 24 * 60 * 60_000;



// ── BOOK-206 (ADR-045 §2): the claim, the schedule and the one stored verdict ─────────────


/**
 * BOOK-DOC-84 §10.8 — five calls everywhere, then a deterministic sixth (no model call).
 * `TRIAGE_MAX_TRIES` is the ladder's ceiling, not the filing's last word: the sixth is desperate.
 */
export const TRIAGE_MAX_TRIES = 5;
/** §10.8: the sixth, cheapest attempt — no new reasoning, a deterministic placement. */
export const TRIAGE_DESPERATE_ATTEMPT = 6;

/** One provider call's cap: the writer's `WRITER_TIMEOUT_MS` default (`writer/config.ts`, 420 s). */
export const TRIAGE_CALL_TIMEOUT_MS = 420_000;

/**
 * The claim's lease: **two** call caps plus a margin (900 s). `writer/provider.ts` retries a
 * broken call once, so one triage call can take 2 × 420 s and still be live; a 600 s lease let a
 * restarted writer claim the same attempt under a running call and buy it twice (BOOK-206 M2).
 */
export const TRIAGE_CLAIM_TTL_MS = 2 * TRIAGE_CALL_TIMEOUT_MS + 60_000;

/** The backoff a failed call sets, by the try that failed: 60 s → 10 min → 6 h → 6 h → 6 h. */
export const TRIAGE_BACKOFF_MS: readonly number[] = [60_000, 600_000, 6 * 60 * 60_000, 6 * 60 * 60_000, 6 * 60 * 60_000];

/** One filing a run may be asked to read, and the claim the previous writer held (M4). */
export type DueTriage = {
  commentId: string;
  n: number;
  chapter: number;
  tries: number;
  claimUntil: string | null;
};

/**
 * The filings due for a read, oldest first: a `new` filing with no disposition whose latest
 * attempt is `submitted`, unread, has tries left, is not backing off and is claimed by nobody —
 * this is a query, not a queue. The rights door comes first (`rights_verdict = 'CLEAR'`): no read
 * is bought for a row Gate B has not cleared (BOOK-61), and the verdict landing makes it due.
 */
export function dueTriage(db: Db, now: string, limit = 8): DueTriage[] {
  return db
    .prepare(
      `SELECT c.id AS commentId, a.n AS n, c.chapter AS chapter, a.tries AS tries, a.claim_until AS claimUntil
         FROM comments c
         JOIN comment_attempts a ON a.comment_id = c.id
        WHERE c.status = 'new' AND c.disposition IS NULL
          AND c.rights_verdict = 'CLEAR'
          AND a.n = (SELECT MAX(n) FROM comment_attempts WHERE comment_id = c.id)
          AND a.outcome = 'submitted'
          AND a.verdict IS NULL
          AND a.tries < ?
          AND (a.next_at IS NULL OR a.next_at <= ?)
          AND (a.claim_until IS NULL OR a.claim_until <= ?)
        ORDER BY c.created_at, c.id
        LIMIT ?`,
    )
    .all(TRIAGE_MAX_TRIES, now, now, limit) as DueTriage[];
}

/**
 * Claim one due attempt: one writer moves `claim_until` past now and counts the try, and
 * `changes = 1` is the proof this caller owns the call. A second writer — or a restarted process
 * whose claim outlived it — loses the race and buys nothing.
 */
export function claimTriage(
  db: Db,
  input: { commentId: string; n: number; session: string; now: string; ttlMs?: number },
): boolean {
  const until = new Date(Date.parse(input.now) + (input.ttlMs ?? TRIAGE_CLAIM_TTL_MS)).toISOString();
  const changed = db
    .prepare(
      `UPDATE comment_attempts SET claim_by = ?, claim_until = ?, tries = tries + 1
        WHERE comment_id = ? AND n = ? AND outcome = 'submitted'
          AND (claim_until IS NULL OR claim_until <= ?)`,
    )
    .run(input.session, until, input.commentId, input.n, input.now).changes;
  return changed === 1;
}

/**
 * Schedule the next try and give the claim back: the backoff is the wait, and a claim left
 * standing would make a 60 s retry wait out the writer's 600 s lease instead.
 */
export function scheduleRetry(db: Db, input: { commentId: string; n: number; nextAt: string }): boolean {
  return (
    db
      .prepare(
        `UPDATE comment_attempts SET next_at = ?, claim_by = NULL, claim_until = NULL
          WHERE comment_id = ? AND n = ? AND outcome = 'submitted' AND verdict IS NULL`,
      )
      .run(input.nextAt, input.commentId, input.n).changes === 1
  );
}

/**
 * BOOK-206 B5 — the day's last try is not the filing's last: one new UTC day is a new reading
 * budget. The attempt is put back to the next 00:00 UTC with `tries` at zero and the claim
 * released, and the row's public line says the time (`READING_RESCHEDULED_LINE`) — a reader must
 * never be told «остаётся в очереди» about a row `dueTriage` had already excluded.
 *
 * One transaction with the caller's, so the budget and the sentence cannot disagree. Returns the
 * new `next_at`, or `null` when the attempt is no longer open (an answer landed meanwhile).
 */
export function rescheduleTomorrow(db: Db, input: { commentId: string; n: number; nowMs: number }): string | null {
  const nextAt = new Date(utcDayEnd(input.nowMs)).toISOString();
  const run = db.transaction((): string | null => {
    const moved = db
      .prepare(
        `UPDATE comment_attempts SET next_at = ?, tries = 0, claim_by = NULL, claim_until = NULL
          WHERE comment_id = ? AND n = ? AND outcome = 'submitted' AND verdict IS NULL`,
      )
      .run(nextAt, input.commentId, input.n).changes;
    if (moved !== 1) return null;
    // The row's own line is the only place the page reads a fact about a `new` filing
    // (`commentView.ts` prints `reason` beside the word), so the sentence lives there.
    db.prepare(`UPDATE comments SET reason = ? WHERE id = ? AND status = 'new' AND disposition IS NULL`).run(
      READING_RESCHEDULED_LINE,
      input.commentId,
    );
    return nextAt;
  });
  return run();
}

/**
 * Give back the sentence a rescheduled attempt wrote: the next reading happened, so the row's
 * line must stop naming a wait that is over (BOOK-206 B5). Conditional on the exact sentence, so
 * a line the gate or the ladder wrote is never touched.
 */
export function clearRetryLine(db: Db, commentId: string): void {
  db.prepare(`UPDATE comments SET reason = NULL WHERE id = ? AND reason = ?`).run(commentId, READING_RESCHEDULED_LINE);
}

/** The backoff for the try that just failed; `null` at the cap (no sixth call: the ladder ends). */
export function triageBackoffMs(tries: number): number | null {
  if (tries >= TRIAGE_MAX_TRIES) return null;
  return TRIAGE_BACKOFF_MS[Math.max(0, tries - 1)] ?? null;
}

/** One stored attempt, as the engine and the applier read it. */
export type AttemptVerdict = {
  n: number;
  outcome: string | null;
  tries: number;
  verdict: string | null;
  verdict_at: string | null;
  next_at: string | null;
  claim_by: string | null;
  /** §10.8: the widening code this attempt runs under, and the desperate sixth marker. */
  widened: string | null;
  desperate: number;
  claim_until: string | null;
};

export function readAttempt(db: Db, commentId: string, n: number): AttemptVerdict | undefined {
  return db
    .prepare(
      `SELECT n, outcome, tries, verdict, verdict_at, next_at, claim_by, widened, desperate, claim_until
         FROM comment_attempts WHERE comment_id = ? AND n = ?`,
    )
    .get(commentId, n) as AttemptVerdict | undefined;
}

/**
 * The newest attempt row, whatever its outcome. A filing is decided by its **latest** submission:
 * a revision clears the row's chain and adds the next `n`, so the sentence a model read about the
 * old words must not place the new ones.
 */
export function latestAttempt(db: Db, commentId: string): AttemptVerdict | undefined {
  return db
    .prepare(
      `SELECT n, outcome, tries, verdict, verdict_at, next_at, claim_by, widened, desperate, claim_until
         FROM comment_attempts WHERE comment_id = ? ORDER BY n DESC LIMIT 1`,
    )
    .get(commentId) as AttemptVerdict | undefined;
}

/**
 * Is this filing's attempt out of tries with no placement to show for it? Then the page says so
 * (`attempt: 'failed'`): the row stays `new` and visible as a defect, never silently terminal.
 *
 * Two shapes count, both at the cap: an attempt the writer gave up on (`submitted`, no verdict),
 * and one the applier could not place (settled `held` — a corrupt reading, a gate that never
 * cleared). A held attempt below the cap is a gate's own hold and says nothing about triage.
 *
 * BOOK-206 B5: a capped attempt is **rescheduled** (`rescheduleTomorrow`) — `tries` back to zero
 * and `next_at` at the next UTC midnight — so the count below no longer reaches the cap and the
 * page reads «ждёт» with the rescheduled sentence, never a failed state nothing will retry.
 */
export function triageAttemptFailed(db: Db, commentId: string): boolean {
  const row = db
    .prepare(
      `SELECT tries, verdict, outcome FROM comment_attempts WHERE comment_id = ?
        ORDER BY n DESC LIMIT 1`,
    )
    .get(commentId) as { tries: number; verdict: string | null; outcome: string | null } | undefined;
  if (row === undefined || row.tries < TRIAGE_MAX_TRIES) return false;
  return row.outcome === 'held' || row.verdict === null;
}


/** 00:00 UTC of the day `nowMs` falls in. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcDayStart(nowMs: number): number {
  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

/** 00:00 UTC of the next day: when a filing's, an identity's and a network's tries reset. */
export function utcDayEnd(nowMs: number): number {
  return utcDayStart(nowMs) + DAY_MS;
}

