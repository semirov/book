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
 *
 * The **triage** bound — the claim, the backoffs and the refusal of a read that never happened —
 * lives beside this ledger in `triage.ts`: it is a queue, this is what the ledger says about a
 * reader's tries.
 */

import type { CommentRefusal, CommentRevise } from '@book/shared';

import { isoDay, utcDayEnd, utcDayStart } from './triageLedger.ts';

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

// The claim, the schedule, the one stored verdict and the ladder's counters live in
// `triageLedger.ts` (the arch bound); they are re-exported here, so every call site still
// imports one module for the ledger.
export * from './triageLedger.ts';

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

function count(db: Db, sql: string, ...args: Array<string | number>): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

/**
 * The retry attempt rows a filing has taken are **the same submission** (owner's rule, 2026-10-29):
 * a re-arm re-runs our machinery and is not a second thing the reader asked for, so it must not
 * spend the identity's or the network's day. The ledger row says which attempt it was — the `retry`
 * event carries its `n` — and this fragment is the one place that link is read.
 */
const NOT_A_RETRY = `AND NOT EXISTS (
    SELECT 1 FROM comment_events e
     WHERE e.comment_id = a.comment_id AND e.type = 'retry'
       AND e.meta IS NOT NULL AND json_valid(e.meta)
       AND json_extract(e.meta, '$.n') = a.n
  )`;

/** The identity's submissions this UTC day, across every filing — refusals included. */
export function identityAttemptsToday(db: Db, identityId: string, nowMs: number): number {
  return count(
    db,
    `SELECT COUNT(*) AS n FROM comment_attempts a
       JOIN comments c ON c.id = a.comment_id
      WHERE c.identity_id = ? AND a.day = ? ${NOT_A_RETRY}`,
    identityId,
    isoDay(nowMs),
  );
}

/** The network's submissions this UTC day, keyed by the stored hash — never by an address. */
export function networkAttemptsToday(db: Db, ipHash: string, nowMs: number): number {
  return count(
    db,
    `SELECT COUNT(*) AS n FROM comment_attempts a
       JOIN comments c ON c.id = a.comment_id
      WHERE c.ip_hash = ? AND a.day = ? ${NOT_A_RETRY}`,
    ipHash,
    isoDay(nowMs),
  );
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
