/**
 * BOOK-220 §11.3 — «повторить»: when the failure was **ours**, and when it may not be offered.
 *
 * The word exists for the three failures a reader cannot mend by writing better: the reading's
 * attempts are spent, the provider answered off-shape or did not answer at all, or a pass was
 * rolled back. It is never offered for a lock (право, вред, рамка, финал), for a refusal of the
 * content or for the budget cap — those are decisions, and a repeat would be a lie about them.
 *
 * Nothing here fetches: the classified facts ride the frames (`filing:reading`,
 * `filing:update`, `comment:decision`, the change's decided line), and the row's own DTO is the
 * fallback when the page was not there when they arrived. An unknown class is `none`: the
 * reader is never asked to repeat an act the page cannot name.
 */

import type { CommentDecisionPayload, CommentDto, FilingUpdatePayload, LiveReading } from '@book/shared';

import type { ChangeLine } from './clientState.ts';
import { REVISE_EXHAUSTED } from './revise.ts';

/** The record's word for the act, and the line it prints while the filings are re-queued. */
export const RETRY_WORD = 'повторить';
export const RETRY_STARTED = 'повторяем с начала';
/** The endpoint is another branch's: an answer of 404 is said out loud, never claimed as success. */
export const RETRY_UNAVAILABLE = 'повтор недоступен';

export type RetryOffer =
  | { kind: 'none' }
  | { kind: 'word' }
  /** The cap is spent: the word is gone, and the line says what is left (the next day's tries). */
  | { kind: 'spent'; line: string };

const NONE: RetryOffer = { kind: 'none' };

/**
 * The change outcomes that are our failure: a pass that came back empty (`failed`) and a gate
 * that never answered, so the pass put the chapter back (`escalated:gate_timeout`). The reader's
 * lock, the content refusal and the budget are not in this set, and neither is a landing.
 */
const OUR_OUTCOMES: ReadonlySet<string> = new Set(['failed', 'escalated:gate_timeout']);

/** The decided frame's own outcome, or `null` when the page holds no decision for the change. */
function outcomeOf(line: ChangeLine | null): string | null {
  if (line === null || line.kind !== 'decided') return null;
  return line.payload.cascade?.outcome ?? line.payload.outcome;
}

/** A row that is settled, hidden or held is not a failure of ours to repeat. */
function settled(comment: Pick<CommentDto, 'status' | 'applied'>): boolean {
  if (comment.applied !== null && comment.applied !== undefined) return true;
  switch (comment.status) {
    case 'applied':
    case 'registered':
    case 'superseded':
    case 'hidden':
    case 'quarantined':
      return true;
    default:
      return false;
  }
}

/** The tries the server says are left: the frame first, the row's own `revise` second. */
function triesLeft(
  comment: Pick<CommentDto, 'revise'>,
  update: FilingUpdatePayload | null,
): number | null {
  const left = update?.attemptsLeft ?? comment.revise?.attemptsLeft;
  return typeof left === 'number' && Number.isFinite(left) ? left : null;
}

/**
 * What the record owes a filing's failure, from the frames and the row alone.
 *
 *   • `none` — no failure, a lock, a refusal, a landing, or a class the page cannot name;
 *   • `word` — our failure with a try left: one tap re-queues the same filing;
 *   • `spent` — the cap is spent: no word, and the honest line in its place.
 */
export function retryOffer(input: {
  comment: Pick<CommentDto, 'id' | 'status' | 'refusal' | 'attempt' | 'applied' | 'revise'> | null;
  /** The change's last line, as `changeLineOf` reads it. */
  change: ChangeLine | null;
  reading: LiveReading | null;
  update: FilingUpdatePayload | null;
  decision: CommentDecisionPayload | null;
}): RetryOffer {
  const { comment, reading, update } = input;
  if (comment === null) return NONE;
  // A decision is the last word, and it is not ours to overturn.
  if (comment.refusal !== null && comment.refusal !== undefined) return NONE;
  if (settled(comment)) return NONE;
  const decision = input.decision;
  if (decision !== null && decision.id === comment.id && decision.status === 'applied') return NONE;

  const left = triesLeft(comment, update);
  const spent = left === 0 || comment.revise?.closed === true;
  const failedReading =
    reading !== null && reading.commentId === comment.id && reading.phase === 'failed'
      ? reading.attempt >= reading.maxAttempts || spent
      : false;

  const outcome = outcomeOf(input.change);
  if (outcome !== null) {
    if (!OUR_OUTCOMES.has(outcome)) return NONE;
    return failedReading || spent ? { kind: 'spent', line: REVISE_EXHAUSTED } : { kind: 'word' };
  }
  // No decided frame on the page: the row's own facts answer, and an unnamed class answers none.
  if (reading !== null && reading.commentId === comment.id && reading.phase === 'failed') {
    return failedReading ? { kind: 'spent', line: REVISE_EXHAUSTED } : { kind: 'word' };
  }
  if (comment.attempt === 'failed') {
    return spent ? { kind: 'spent', line: REVISE_EXHAUSTED } : { kind: 'word' };
  }
  if (spent) return { kind: 'spent', line: REVISE_EXHAUSTED };
  return NONE;
}
