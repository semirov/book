/**
 * «Повторить» — the way back from **our** failure (owner, 2026-10-29: «ещё нужно сделать кнопку
 * „повторить", если всё-таки мы не смогли отработать как надо»).
 *
 * A retry is not a revision: nothing about the reader's words changes, so there is nothing for a
 * gate to judge. What is re-armed is the **machinery** — a fresh attempt ladder on the same
 * filing, and (when a pass had already taken the filing) that same change back in the queue.
 *
 * The rule this module exists for is the one that decides whether offering the button would be a
 * **lie**. It is offered only when the last outcome was a defect on our side:
 *
 *   · `triage` — the read never answered: the calls failed, the deadline passed (`refuseTriage`
 *     settles the attempt `refused` with no verdict), or the applier met a row it could not place
 *     and the ladder ran out of tries;
 *   · `pass`   — a pass broke: the provider timed out, the answer came back off-shape or
 *     truncated, the engine did not answer, or a gate never answered at all.
 *
 * It is **not** offered — because a retry would repeat the same judgement and call it a failure —
 * when the last outcome was the book's own word: a lock (`право`, `вред`, `рамка`, `финал`), a
 * content refusal (the model or the writer said no to the work), or the book's money cap. And it
 * is not offered past `RETRY_MAX`: three re-arms is what a defect is worth, and past that the
 * filing keeps the honest sentence it already carries.
 *
 * Every answer here comes from stored facts — verdicts, statuses, a stored failure code — and
 * never from the text of a reason: a sentence can be written by a model, and a string test is not
 * a verdict (BOOK-61). Where the facts cannot tell our defect from the book's answer, the door
 * stays shut: withholding a retry is not a lie, offering one is.
 */

import { TRIAGE_MAX_TRIES, type CommentRefusal, type CommentStatus } from '@book/shared';

import type { Db } from '../db/db.ts';
import { safeJson } from '../engineState/rows.ts';
import type { FilingChange } from './filingState.ts';

/** How many times one filing may be re-armed. Past this the defect is not transient any more. */
export const RETRY_MAX = 3;

/** The refusal code the retry door answers when the button may not be offered (409). */
export const RETRY_NOT_OFFERED = 'RETRY_NOT_OFFERED';
/** The book's answer or the reader's own words were judged: a retry would be the same judgement. */
export const RETRY_REFUSED_MESSAGE = 'повторить нельзя — по этому замечанию уже сказано по существу';
/** The defect went on for three re-arms: another one would promise what we cannot do. */
export const RETRY_CAP_MESSAGE = 'повторять больше нельзя — попытки исчерпаны';

/** The column facts this rule reads off the filing — passed in, so the rule owns no query shape. */
export type FilingFacts = {
  id: string;
  status: string;
  /** The lock the refusal rests on (`rights|harm|frame|finale`), null when none did. */
  lock: string | null;
  /** `inadmissible` is the lock's own chain value (BOOK-174 §5); it is never retryable. */
  disposition: string | null;
  /** Gate B's answer: no retry is bought for a filing the law has not cleared. */
  rights_verdict: string | null;
};

/**
 * What exactly broke, as the `retry` event carries it: `triage` (the read never answered) or
 * `pass` (a pass broke). It is an operator's word in the filing's own audit trail — no reader
 * surface prints it.
 */
export type RetryBecause = 'triage' | 'pass';

/** Why the door is shut. Internal: the route logs it, the reader reads one public sentence. */
export type RetryClosed = 'cap' | 'state' | 'refusal' | 'rights' | 'not-ours';

export type RetryFacts = {
  row: FilingFacts;
  /** The filing's **derived** status — the same word the DTO prints. */
  status: CommentStatus;
  /** The gate that refused it, from the stored verdicts (`repo.ts` `refusalOf`). */
  refusal: CommentRefusal | null;
  /** The change the state is read from (`decisiveChange`), when a change exists at all. */
  change: FilingChange | undefined;
  /** Did that change land the reader's text? Then there is nothing left to retry. */
  landed: boolean;
};

export type RetryOffer = {
  retryable: boolean;
  /** Why not, when not (`null` while the door is open). Internal: the route logs it, never sends it. */
  closed: RetryClosed | null;
  /** What the `retry` event will record as `because`; `null` while the door is shut. */
  because: RetryBecause | null;
};

/**
 * May the reader press «повторить»? One derivation, read by the DTO (the button) and by the door
 * (the answer), so the page and the endpoint cannot disagree about the same row.
 *
 * The cheap stored facts answer first and the attempt ledger is asked last: a filing that landed,
 * waits in the lane or was refused under a lock cannot be retried whatever the ledger says, and a
 * public page of twenty rows must not read twenty logs to learn that.
 */
export function retryOffer(db: Db, facts: RetryFacts): RetryOffer {
  const shut = (closed: RetryClosed): RetryOffer => ({
    retryable: false,
    closed,
    because: null,
  });
  const open = (because: RetryBecause): RetryOffer => ({ retryable: true, closed: null, because });
  /** The last question, once everything else has answered «a retry could be honest». */
  const capped = (because: RetryBecause): RetryOffer =>
    retryCount(db, facts.row.id) >= RETRY_MAX ? shut('cap') : open(because);

  // A gate refused it — `held`, `rights`, `auditor`, or the chain's lock. The reader's wording was
  // judged and answered; re-running the machinery would repeat the same verdict.
  if (facts.refusal !== null) return shut('refusal');
  if (facts.row.lock !== null || facts.row.disposition === 'inadmissible') return shut('refusal');
  // The door to a model is shut by the law, not by us: nothing to re-arm until Gate B answers.
  if (facts.row.rights_verdict !== 'CLEAR') return shut('rights');
  // The text is in the book: there is no failure behind it and nothing to read again.
  if (facts.landed) return shut('state');

  const change = facts.change;
  if (change !== undefined) {
    // A premise waits for its chapter's first pass, not for a retry; a change already armed is
    // the reader's business with the lane, not a defect to re-run.
    if (change.premise === 1) return shut('state');
    if (change.status === 'pending' || change.status === 'processing') return shut('state');
    if (facts.status !== 'rejected') return shut('state');
    return stopIsOurs(db, change) ? capped('pass') : shut('not-ours');
  }

  // No change: the filing never became text, so the read itself is what failed or did not happen.
  if (facts.status !== 'new' && facts.status !== 'rejected') return shut('state');
  const read = readState(db, facts.row.id);
  if (read === 'inflight') return shut('state');
  return read === 'ours' ? capped('triage') : shut('not-ours');
}

/** How many retries this filing has already taken — the `retry` events are the ledger. */
function retryCount(db: Db, commentId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE comment_id = ? AND type = 'retry'`)
      .get(commentId) as { n: number }
  ).n;
}

/** Where the filing's newest submission stands: answered, still being read, or broken on us. */
type ReadState = 'answered' | 'inflight' | 'ours';

/**
 * The read, from the attempt ledger alone.
 *
 * A **verdict** is the book's answer, whatever it says: the defect rule has nothing to offer
 * there. Without one, the row is either still being read (below the cap, a claim still live) or
 * broken on our side — `refused` is `refuseTriage`'s sink (the calls failed, the deadline passed),
 * and `held`/`submitted` at the tries cap is the applier's own defect (`triageAttemptFailed`).
 *
 * The cap is `TRIAGE_MAX_TRIES` from the shared copy, not a number private to this rule: the
 * ladder's length is the queue's fact, and a second count here could drift from it.
 */
function readState(db: Db, commentId: string): ReadState {
  const row = db
    .prepare(
      `SELECT outcome, tries, verdict FROM comment_attempts WHERE comment_id = ? ORDER BY n DESC LIMIT 1`,
    )
    .get(commentId) as { outcome: string | null; tries: number; verdict: string | null } | undefined;
  if (row === undefined) return 'answered';
  // `refused` first: an answer the applier could not place keeps its verdict on the row (the
  // record keeps what was read) and is still our failure — the filing never reached a sink on
  // its merits. A lock refusal has no verdict and is shut earlier by its disposition.
  if (row.outcome === 'refused') return 'ours';
  if (row.verdict !== null) return 'answered';
  if (row.outcome === 'held' || row.outcome === 'submitted') {
    return row.tries >= TRIAGE_MAX_TRIES ? 'ours' : 'inflight';
  }
  return 'answered';
}

/**
 * A stopped **change**: did our machinery break, or did the book answer?
 *
 * The book's own money cap is a verdict about the day (`budget`), never a defect. Past that the
 * pass's own receipt decides: `pass_transcripts` stores the failure code of the row that ended the
 * pass, and that code is a machine word (`PROVIDER_TIMEOUT`, `ANSWER_REFUSAL`, `FRAME_CHANGED`) —
 * a classification, not a sentence. Only when no receipt exists (a wall, a lost session, the
 * queue's deadline — stops the engine owns and the writer never saw) does the cascade's own word
 * answer, and then only a gate that never answered is ours.
 */
function stopIsOurs(db: Db, change: FilingChange): boolean {
  if (change.outcome === 'budget') return false;
  const code = passFailureCode(db, change.id);
  if (code !== null) return ourFailureCode(code);
  return cascadeOutcome(db, change.id) === 'escalated:gate_timeout';
}

/**
 * The failure codes that are **our** defect: a provider call, an answer that did not parse or
 * arrived cut short, an engine that never answered. The book's own answers are excluded by name —
 * a refusal to write (`ANSWER_REFUSAL`) and the two locks that stop a pass (`RIGHTS_*`,
 * `FRAME_CHANGED`) — because a retry of those would repeat a judgement we already have.
 */
const NOT_OURS = new Set([
  'ANSWER_REFUSAL',
  'FRAME_CHANGED',
  'RIGHTS_REQUIRED',
  'RIGHTS_NOT_REQUIRED',
  'STEP_CLOSED',
  'BUDGET',
  'TEXT_STUCK',
]);

export function ourFailureCode(raw: string | null): boolean {
  if (raw === null) return false;
  const code = raw.trim().toUpperCase();
  if (NOT_OURS.has(code) || code.startsWith('RIGHTS_') || code.startsWith('FRAME_') || code.startsWith('BUDGET_')) {
    return false;
  }
  return (
    code.startsWith('PROVIDER_') ||
    code.startsWith('ANSWER_') ||
    code.startsWith('ENGINE_') ||
    code === 'DB_BUSY'
  );
}

/** The last failure code a pass of this change recorded, or `null` when no receipt exists. */
function passFailureCode(db: Db, changeId: string): string | null {
  const row = db
    .prepare(
      `SELECT t.content_redacted AS content
         FROM pass_transcripts t
         JOIN steps s ON s.step_id = t.pass_id
         LEFT JOIN leases l ON l.step_id = s.step_id
         LEFT JOIN cascades c ON c.id = s.cascade_id
        WHERE l.change_id = ? OR c.change_id = ?
        ORDER BY t.pass_id DESC, t.seq DESC
        LIMIT 1`,
    )
    .get(changeId, changeId) as { content: string } | undefined;
  if (row === undefined) return null;
  const facts = safeJson<{ failure?: unknown }>(row.content);
  return typeof facts?.failure === 'string' ? facts.failure : null;
}

/** The word the cascade that stopped this change closed with (`escalated:gate_timeout`, …). */
function cascadeOutcome(db: Db, changeId: string): string | null {
  const row = db
    .prepare(`SELECT c.outcome AS outcome FROM cascades c JOIN changes ch ON ch.cascade_id = c.id WHERE ch.id = ?`)
    .get(changeId) as { outcome: string | null } | undefined;
  return row?.outcome ?? null;
}
