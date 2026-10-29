/**
 * BOOK-206 (ADR-045 §2, §4, §5) — the triage bound: one claim, one ladder of attempts, two sinks.
 *
 * A **filing** is the comment row; the thing a model is asked to read is an **attempt**
 * (`attempts.ts` writes it). This module is the queue that needs no broker: every question the
 * engine asks about a read in flight — may it be claimed, when is it due, how wide is it read —
 * is a conditional UPDATE or a query over `comment_attempts`.
 *
 * The owner's correction of 2026-10-29 («нет, сроков не надо — только конечное количество
 * попыток») is the whole rule: **no timer decides a filing's state.** A read ends in one of two
 * sinks — an answer (`verdict`) or a refusal (`refuseTriage`) — and the refusal is reached by the
 * counter alone:
 *
 *   · attempts 1–3 read the filing at its narrow rung;
 *   · the **third** failure widens the reading — the next rung of the ladder is accepted instead
 *     of the narrower one, and the row records it (`widened = 'as-document'`, `widening_note`);
 *   · attempts 4–5 read under that widening;
 *   · attempt 6 is **desperate**: the ladder's floor rung is applied by the coded rule
 *     (`feedback/disposition.ts`), with no model at all, and the row says `desperate`;
 *   · only when the floor cannot apply does the sixth failure refuse the filing.
 *
 * Backoff and the claim lease remain — a pace between attempts and a liveness guard for a call in
 * flight — but neither of them ever moves a filing to a sink.
 */

import { TRIAGE_MAX_TRIES, TRIAGE_REFUSED_LINE } from '@book/shared';

import type { Db } from '../db/db.ts';

export { TRIAGE_MAX_TRIES };

// ── BOOK-206 (ADR-045 §2): the claim, the schedule and the one stored verdict ─────────────

/**
 * The model's share of the six attempts: 1..5. The sixth is the engine's own coded floor and
 * buys no call, so the counter the ledger holds (`tries`) never passes this number.
 */
export const TRIAGE_MODEL_TRIES = TRIAGE_MAX_TRIES - 1;

/** The attempt after which the reading is widened: the third failure (the fourth claim). */
export const TRIAGE_WIDEN_AFTER = 3;

/** One provider call's cap: the writer's `WRITER_TIMEOUT_MS` default (`writer/config.ts`, 420 s). */
export const TRIAGE_CALL_TIMEOUT_MS = 420_000;

/**
 * The claim's lease: **two** call caps plus a margin (900 s). `writer/provider.ts` retries a
 * broken call once, so one triage call can take 2 × 420 s and still be live; a 600 s lease let a
 * restarted writer claim the same attempt under a running call and buy it twice (BOOK-206 M2).
 * It is a liveness guard for the call, never a decision about the filing.
 */
export const TRIAGE_CLAIM_TTL_MS = 2 * TRIAGE_CALL_TIMEOUT_MS + 60_000;

/**
 * The backoff a failed call sets, by the try that failed: 60 s → 5 min → 20 min → 40 min. The
 * ladder is short on purpose — a reader waiting on their own text is not a queue to be nursed.
 * A failed try below the model cap only moves `next_at`; it never decides anything.
 */
export const TRIAGE_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 20 * 60_000, 40 * 60_000];

/**
 * The widening the record keeps: the code from the book's one vocabulary (`widenedWord()`,
 * `shared/liveWords.ts`) — the reading is asked to be read as a document, not at the narrow rung
 * it insisted on — plus the note an operator reads. It is stored on the attempt row, so the
 * widening is a fact of the ledger and not a variable of whichever process made the claim.
 */
export const WIDENED_RUNG = 'as-document';
/** The next rung of the ladder the widened reading accepts: `through_paper`, the paper it can be. */
export const WIDENED_NEXT_RUNG = 'through_paper';
export const WIDENING_NOTE = `third failed read — the next rung of the ladder (${WIDENED_NEXT_RUNG}) is accepted`;

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
 * attempt is `submitted`, unread, has model tries left, is not backing off and is claimed by
 * nobody — this is a query, not a queue. The rights door comes first (`rights_verdict = 'CLEAR'`):
 * no read is bought for a row Gate B has not cleared (BOOK-61).
 *
 * Nothing is excluded here silently: an attempt past the model cap is the engine's own desperate
 * attempt (`filingTriage.ts`), so the row leaves this query by the counter, not by a hidden `tries`.
 *
 * A filing whose change is already in the lane is not a filing to read again: a retry re-arms the
 * **change** (owner's rule, 2026-10-29) and the row reads `new` once more, so without this line one
 * submission would be read twice and could become two changes.
 */
export function dueTriage(db: Db, now: string, limit = 8): DueTriage[] {
  return db
    .prepare(
      `SELECT c.id AS commentId, a.n AS n, c.chapter AS chapter, a.tries AS tries,
              a.claim_until AS claimUntil
         FROM comments c
         JOIN comment_attempts a ON a.comment_id = c.id
        WHERE c.status = 'new' AND c.disposition IS NULL
          AND c.rights_verdict = 'CLEAR'
          AND NOT EXISTS (
            SELECT 1 FROM changes ch
             WHERE ch.source_comment = c.id AND ch.status IN ('pending', 'processing')
          )
          AND a.n = (SELECT MAX(n) FROM comment_attempts WHERE comment_id = c.id)
          AND a.outcome = 'submitted'
          AND a.verdict IS NULL
          AND a.desperate = 0
          AND a.tries < ?
          AND (a.next_at IS NULL OR a.next_at <= ?)
          AND (a.claim_until IS NULL OR a.claim_until <= ?)
        ORDER BY c.created_at, c.id
        LIMIT ?`,
    )
    .all(TRIAGE_MODEL_TRIES, now, now, limit) as DueTriage[];
}

/**
 * Claim one due attempt: one writer moves `claim_until` past now and counts the try, and
 * `changes = 1` is the proof this caller owns the call. A second writer — or a restarted process
 * whose claim outlived it — loses the race and buys nothing.
 *
 * The widening is applied here rather than only in the failure report: a claim that is the fourth
 * try (or later) is by definition the one after the third failure, however the earlier claims
 * ended — a writer that died after `next` twice never reported a `fail` either. One conditional
 * UPDATE, so the row is the only place the widening is decided.
 */
export function claimTriage(
  db: Db,
  input: { commentId: string; n: number; session: string; now: string; ttlMs?: number },
): boolean {
  const until = new Date(Date.parse(input.now) + (input.ttlMs ?? TRIAGE_CLAIM_TTL_MS)).toISOString();
  const changed = db
    .prepare(
      `UPDATE comment_attempts
          SET claim_by = ?, claim_until = ?, tries = tries + 1,
              widened = CASE WHEN tries + 1 > ? AND widened IS NULL THEN ? ELSE widened END,
              widening_note = CASE WHEN tries + 1 > ? AND widening_note IS NULL THEN ? ELSE widening_note END
        WHERE comment_id = ? AND n = ? AND outcome = 'submitted'
          AND (claim_until IS NULL OR claim_until <= ?)`,
    )
    .run(
      input.session,
      until,
      TRIAGE_WIDEN_AFTER,
      WIDENED_RUNG,
      TRIAGE_WIDEN_AFTER,
      WIDENING_NOTE,
      input.commentId,
      input.n,
      input.now,
    ).changes;
  return changed === 1;
}

/**
 * Record the widening on the attempt row, once: the third failure is the moment the reading stops
 * being narrow, and the row says so before the fourth claim is made.
 */
export function widenReading(db: Db, input: { commentId: string; n: number }): boolean {
  return (
    db
      .prepare(
        `UPDATE comment_attempts SET widened = ?, widening_note = ?
          WHERE comment_id = ? AND n = ? AND widened IS NULL AND outcome = 'submitted'`,
      )
      .run(WIDENED_RUNG, WIDENING_NOTE, input.commentId, input.n).changes === 1
  );
}

/**
 * Schedule the next try and give the claim back: the backoff is the wait, and a claim left
 * standing would make a 60 s retry wait out the whole claim lease instead.
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

/** One attempt the engine's coded rule must end, and why the sweep found it. */
export type EndedTriage = { commentId: string; n: number; tries: number; claimUntil: string | null };

/**
 * The rows the model can no longer answer: the latest attempt still waits for a verdict, every
 * model try is spent, and no claim is live. These are the sixth attempts in waiting — a writer
 * refused to call five times, five claims died with their processes, or an older build left the
 * row at its cap. No clock is read: the counter alone puts them here.
 *
 * A live claim is skipped — a call in flight is never cut — and its own lease bounds how long
 * that can hold the sweep off. That lease decides only *when the engine may look*, never that
 * the filing has ended.
 */
export function desperateTriage(db: Db, now: string, limit = 8): EndedTriage[] {
  return db
    .prepare(
      `SELECT c.id AS commentId, a.n AS n, a.tries AS tries, a.claim_until AS claimUntil
         FROM comments c
         JOIN comment_attempts a ON a.comment_id = c.id
        WHERE c.status = 'new' AND c.disposition IS NULL
          AND c.rights_verdict = 'CLEAR'
          AND a.n = (SELECT MAX(n) FROM comment_attempts WHERE comment_id = c.id)
          AND a.outcome = 'submitted'
          AND a.verdict IS NULL
          AND (a.tries >= ? OR a.desperate = 1)
          AND (a.claim_until IS NULL OR a.claim_until <= ?)
        ORDER BY c.created_at, c.id
        LIMIT ?`,
    )
    .all(TRIAGE_MODEL_TRIES, now, limit) as EndedTriage[];
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

/**
 * The backoff for the try that just failed. `null` at the model cap: the engine's desperate floor
 * follows at once (`filingTriage.ts`) instead of waiting out a pace nobody is left to spend.
 */
export function triageBackoffMs(tries: number): number | null {
  if (tries >= TRIAGE_MODEL_TRIES) return null;
  const ladder = TRIAGE_BACKOFF_MS;
  const index = Math.min(Math.max(tries, 1), ladder.length) - 1;
  return ladder[index] ?? null;
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
  /** The widening code (`'as-document'`) once the reading was widened at the third failure. */
  widened: string | null;
  widening_note: string | null;
  /** 1 when the sixth attempt was the engine's own coded floor. */
  desperate: number;
};

export function readAttempt(db: Db, commentId: string, n: number): AttemptVerdict | undefined {
  return db
    .prepare(
      `SELECT n, outcome, tries, verdict, verdict_at, next_at, claim_by, widened, widening_note, desperate
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
      `SELECT n, outcome, tries, verdict, verdict_at, next_at, claim_by, widened, widening_note, desperate
         FROM comment_attempts WHERE comment_id = ? ORDER BY n DESC LIMIT 1`,
    )
    .get(commentId) as AttemptVerdict | undefined;
}
