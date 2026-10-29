/**
 * BOOK-158 — the attempt ledger: what one reader has already asked a model to judge.
 *
 * A **filing** is the comment row; a **revision** updates that row, so the filing id never
 * changes. Every submission a model may be asked about is an **attempt** here: the initial post
 * is `n = 1`, every revision is the next `n`. The ledger answers three questions a refusal owes
 * the reader, and it answers them from stored facts only:
 *
 *   • how many tries are left today (3 per filing per UTC day), and when they come back;
 *   • whether the refusal is still cooling down (10 minutes), so a rephrase cannot flood a model;
 *   • whether the same words about the same place have already reached a model (24 hours), so an
 *     identical resubmission costs nothing at all.
 *
 * Two more counters bound one reader and one network across all filings (5 and 15 a day): the
 * attempt ledger is the model's attention, and a refusal **does** spend there — which is exactly
 * why it must not spend the daily edit budget (`feedback/cli.ts` spends that on acceptance only).
 *
 * The hint is one line per gate, chosen from the stored verdict columns, never from the text of
 * the reason: a model can write a reason, a string test is not a verdict (`repo.ts` `refusalOf`).
 */

import { READING_RESCHEDULED_LINE, type CommentRefusal, type CommentRevise } from '@book/shared';

import type { Db } from '../db/db.ts';
import { sha256Hex } from '../util/hash.ts';

/** One filing may be submitted three times a UTC day: the post and two revisions. */
export const ATTEMPTS_PER_FILING_DAY = 3;
/** One identity may ask for five judgements a UTC day, across all of its filings. */
export const ATTEMPTS_PER_IDENTITY_DAY = 5;
/** One network may ask for fifteen — the second account behind one address is caught here. */
export const ATTEMPTS_PER_NETWORK_DAY = 15;
/** After a refusal the same filing may not be revised again for ten minutes. */
export const REFUSAL_COOLDOWN_MS = 10 * 60_000;
/** The same words about the same place, by the same reader, within a day never reach a model. */
export const IDENTICAL_WINDOW_MS = 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Where a filing sits against the text: the row's columns, plus the chapter for a premise. */
export type AnchorFields = {
  chapter: number;
  block_id: string | null;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
};

/**
 * The anchor's stable identity: the block and the three slices that were filed against it. A
 * filing with no block is its chapter's premise, so its anchor is the chapter itself — a premise
 * on chapter 8 is the same place however the words around it are typed.
 */
export function anchorSha(row: AnchorFields): string {
  if (row.block_id === null) return sha256Hex(`premise|${row.chapter}`);
  return sha256Hex([row.block_id, row.quote ?? '', row.prefix ?? '', row.suffix ?? ''].join('|'));
}

/** A row a model may be asked about: the stored text hash and the anchor it was filed against. */
export type AttemptSource = AnchorFields & { id: string; body_sha: string };

/**
 * Append the next attempt and return its `n`. The number is per filing and monotonic; the row
 * starts `submitted`, because the outcome is only known after the gate or the triage answer.
 * One transaction: two revisions racing on one filing cannot take the same `n`.
 */
export function recordAttempt(db: Db, row: AttemptSource, at: Date | string): number {
  const iso = typeof at === 'string' ? at : at.toISOString();
  const run = db.transaction((): number => {
    const next = (
      db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM comment_attempts WHERE comment_id = ?').get(row.id) as {
        n: number;
      }
    ).n;
    db.prepare(
      `INSERT INTO comment_attempts (comment_id, n, at, day, body_sha, anchor_sha, quote, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`,
    ).run(row.id, next, iso, iso.slice(0, 10), row.body_sha, anchorSha(row), row.quote);
    return next;
  });
  return run();
}

/** Close one attempt as the gate or triage decided it. Conditional: the first answer wins. */
export function setAttemptOutcome(
  db: Db,
  commentId: string,
  n: number,
  outcome: 'accepted' | 'refused' | 'held' | 'expired',
  decidedAt: string,
): boolean {
  const changed = db
    .prepare(
      `UPDATE comment_attempts SET outcome = ?, decided_at = ?
        WHERE comment_id = ? AND n = ? AND outcome = 'submitted'`,
    )
    .run(outcome, decidedAt, commentId, n).changes;
  return changed === 1;
}

/** The comment's latest attempt that still waits for an answer, or `undefined`. */
export function openAttempt(db: Db, commentId: string): { n: number } | undefined {
  return db
    .prepare(
      `SELECT n FROM comment_attempts WHERE comment_id = ? AND outcome = 'submitted' ORDER BY n DESC LIMIT 1`,
    )
    .get(commentId) as { n: number } | undefined;
}

// ── BOOK-206 (ADR-045 §2): the claim, the schedule and the one stored verdict ─────────────

/** Calls bought for one attempt before it is a visible defect instead of a retry. */
export const TRIAGE_MAX_TRIES = 3;

/** One provider call's cap: the writer's `WRITER_TIMEOUT_MS` default (`writer/config.ts`, 420 s). */
export const TRIAGE_CALL_TIMEOUT_MS = 420_000;

/**
 * The claim's lease: **two** call caps plus a margin (900 s). `writer/provider.ts` retries a
 * broken call once, so one triage call can take 2 × 420 s and still be live; a 600 s lease let a
 * restarted writer claim the same attempt under a running call and buy it twice (BOOK-206 M2).
 */
export const TRIAGE_CLAIM_TTL_MS = 2 * TRIAGE_CALL_TIMEOUT_MS + 60_000;

/** The backoff a failed call sets, by the try that failed: 60 s → 10 min → 6 h. */
export const TRIAGE_BACKOFF_MS: readonly number[] = [60_000, 600_000, 6 * 60 * 60_000];

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

/** The backoff for the try that just failed; `null` at the cap (no fourth call today). */
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
};

export function readAttempt(db: Db, commentId: string, n: number): AttemptVerdict | undefined {
  return db
    .prepare(
      `SELECT n, outcome, tries, verdict, verdict_at, next_at, claim_by
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
      `SELECT n, outcome, tries, verdict, verdict_at, next_at, claim_by
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

/** The comment columns a state is read from; a locked row has no identity of its own. */
export type AttemptComment = {
  id: string;
  identity_id: string;
  ip_hash: string;
  status: string;
  decided_at: string | null;
};

export type AttemptBlock = 'cooldown' | 'attempts' | 'identity' | 'network';

export type AttemptState = {
  /** Attempts of this filing in the current UTC day. */
  attemptsToday: number;
  attemptsLeft: number;
  /** The end of the refusal's cooling window; null while the row is not refused. */
  cooldownUntil: string | null;
  closedToday: boolean;
  /** Next 00:00 UTC: when the day's tries, the identity's and the network's come back. */
  reopenAt: string;
  identityToday: number;
  networkToday: number;
  allowed: boolean;
  blocked: AttemptBlock | null;
};

/** 00:00 UTC of the day `nowMs` falls in. */
export function utcDayStart(nowMs: number): number {
  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

/** 00:00 UTC of the next day: when a filing's, an identity's and a network's tries reset. */
export function utcDayEnd(nowMs: number): number {
  return utcDayStart(nowMs) + DAY_MS;
}

function count(db: Db, sql: string, ...args: Array<string | number>): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

/** The identity's attempts this UTC day, across every filing — refusals included. */
export function identityAttemptsToday(db: Db, identityId: string, nowMs: number): number {
  return count(
    db,
    `SELECT COUNT(*) AS n FROM comment_attempts a
       JOIN comments c ON c.id = a.comment_id
      WHERE c.identity_id = ? AND a.day = ?`,
    identityId,
    isoDay(nowMs),
  );
}

/** The network's attempts this UTC day, keyed by the stored hash — never by an address. */
export function networkAttemptsToday(db: Db, ipHash: string, nowMs: number): number {
  return count(
    db,
    `SELECT COUNT(*) AS n FROM comment_attempts a
       JOIN comments c ON c.id = a.comment_id
      WHERE c.ip_hash = ? AND a.day = ?`,
    ipHash,
    isoDay(nowMs),
  );
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Everything a refusal owes the reader, from the row and the ledger alone.
 *
 * `allowed` means «a revision would be judged»: the row is refused, the cooldown has passed and
 * every counter has a slot. A row in any other state is simply not revisable — `blocked` names a
 * limit only when a limit is what stands in the way, so the page never invents a reason.
 */
export function attemptState(db: Db, comment: AttemptComment, nowMs: number): AttemptState {
  const start = utcDayStart(nowMs);
  const attemptsToday = count(
    db,
    'SELECT COUNT(*) AS n FROM comment_attempts WHERE comment_id = ? AND at >= ?',
    comment.id,
    new Date(start).toISOString(),
  );
  const identityToday = identityAttemptsToday(db, comment.identity_id, nowMs);
  const networkToday = networkAttemptsToday(db, comment.ip_hash, nowMs);
  const attemptsLeft = Math.max(0, ATTEMPTS_PER_FILING_DAY - attemptsToday);
  const closedToday = attemptsLeft === 0;
  const reopenAt = new Date(utcDayEnd(nowMs)).toISOString();

  const decidedMs = comment.decided_at === null ? Number.NaN : Date.parse(comment.decided_at);
  // BOOK-206: a refusal under a lock is the only state the reader may rework. The removed fifth
  // state is gone from this door too — a legacy `escalated` row is re-opened by the boot
  // migration, and until then it waits like any undecided row.
  const reworkable = comment.status === 'rejected';
  const cooldownUntil =
    reworkable && Number.isFinite(decidedMs)
      ? new Date(decidedMs + REFUSAL_COOLDOWN_MS).toISOString()
      : null;

  let blocked: AttemptBlock | null = null;
  if (reworkable) {
    if (cooldownUntil !== null && nowMs < Date.parse(cooldownUntil)) blocked = 'cooldown';
    else if (closedToday) blocked = 'attempts';
    else if (identityToday >= ATTEMPTS_PER_IDENTITY_DAY) blocked = 'identity';
    else if (networkToday >= ATTEMPTS_PER_NETWORK_DAY) blocked = 'network';
  }

  return {
    attemptsToday,
    attemptsLeft,
    cooldownUntil,
    closedToday,
    reopenAt,
    identityToday,
    networkToday,
    allowed: reworkable && blocked === null,
    blocked,
  };
}

/** The DTO's `revise`: the state, named the way the page reads it. */
export function reviseState(db: Db, comment: AttemptComment, nowMs: number): CommentRevise {
  const state = attemptState(db, comment, nowMs);
  return {
    allowed: state.allowed,
    at: state.cooldownUntil,
    attemptsLeft: state.attemptsLeft,
    closed: state.closedToday,
    blocked: state.blocked,
  };
}

/**
 * The `revise` a filing that no gate refused carries: the door was never open, so there is
 * nothing to count. Returning it without touching the ledger is what keeps a public list of
 * accepted rows at one query per row instead of four — the counts are read only for a row a
 * revision could actually reopen.
 */
export function unrevisedState(): CommentRevise {
  return { allowed: false, at: null, attemptsLeft: ATTEMPTS_PER_FILING_DAY, closed: false, blocked: null };
}

/**
 * Have these words, about this place, already reached a model from this reader within a day?
 * Every outcome counts, a refusal included: the point is the model's attention, not the verdict.
 */
export function identicalAttempt(
  db: Db,
  identityId: string,
  bodySha: string,
  anchorHash: string,
  nowMs: number,
): boolean {
  const since = new Date(nowMs - IDENTICAL_WINDOW_MS).toISOString();
  const row = db
    .prepare(
      `SELECT 1 AS one FROM comment_attempts a
         JOIN comments c ON c.id = a.comment_id
        WHERE c.identity_id = ? AND a.body_sha = ? AND a.anchor_sha = ? AND a.at >= ?
        LIMIT 1`,
    )
    .get(identityId, bodySha, anchorHash, since);
  return row !== undefined;
}

/** The stored verdict columns a hint is chosen from — never the text of the reason. */
export type RefusalFacts = {
  status: string;
  refusal: CommentRefusal | null;
  rights_rule: string | null;
};

export const HINT_RIGHTS_QUOTE = 'приведите название и дату источника цитаты';
export const HINT_RIGHTS_PARAPHRASE = 'перескажите своими словами, без чужой формулировки';
export const HINT_RIGHTS_OTHER = 'подтвердите право на текст или перескажите своими словами';
export const HINT_AUDITOR = 'сформулируйте одно событие этой главы, которого ещё нет в тексте';
export const HINT_HELD = 'уберите из текста указания в адрес машины';
export const HINT_GENERIC = 'переформулируйте так, чтобы это было одним событием этой главы';
/** A one-line hint is read beside the refusal; past this it is a paragraph, not a hint. */
export const HINT_MAX_CHARS = 160;

/**
 * The actionable line a refused filing is owed: one sentence, chosen from the gate that refused
 * it and, for the rights gate, from the rule that did. It never repeats the rule id and never
 * says «попробуйте иначе» — a generic hint is the one thing this must not be.
 */
export function refusalHint(facts: RefusalFacts): string | null {
  if (facts.refusal === 'held') return HINT_HELD;
  if (facts.status !== 'rejected') return null;
  if (facts.refusal === 'rights') {
    if (facts.rights_rule === 'RIGHTS-QUOTE') return HINT_RIGHTS_QUOTE;
    if (facts.rights_rule === 'RIGHTS-PARAPHRASE') return HINT_RIGHTS_PARAPHRASE;
    return HINT_RIGHTS_OTHER;
  }
  if (facts.refusal === 'auditor') return HINT_AUDITOR;
  return HINT_GENERIC;
}
