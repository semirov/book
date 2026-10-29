/**
 * A filing's derived state, from the rows that already decided it (BOOK-7, BOOK-61, BOOK-136).
 *
 * Three questions, each answered by facts and never by a second vocabulary: which gate refused
 * the row, whether a premise landed, and whether the change behind a filing came back empty.
 * They live apart from `repo.ts` because they are pure — a row in, a word out — and because the
 * storage module has to stay one screen long.
 */

import {
  holdsInternalCode,
  readerReason,
  type CommentDto,
  type CommentRefusal,
  type CommentStatus,
} from '@book/shared';

import type { CommentRow } from './repo.ts';

/** The change a comment became, for the premise's state. `repo.ts` reads it. */
export type LinkedChange = { premise: number; status: string; outcome: string | null; reason: string | null };

/**
 * The gate that refused a filing (BOOK-61): derived once, from the verdict columns only.
 *
 * A **rejected** row belongs to the gate that wrote the rejection (B1): only B sets
 * `decided_at` together with its sentence, so a row A rejected on scope keeps A's state even
 * when B later records its own verdict column, and the page never heads A's reason with B's
 * word. A held row is A's whatever B answered.
 *
 * BOOK-206: a legacy **escalated** row is not a refusal of the filing either — it is re-opened
 * by the boot migration, and until then the page is told no refusal and prints no report.
 */
export function refusalOf(row: CommentRow): CommentRefusal | null {
  if (row.status === 'quarantined') return 'held';
  if (row.status === 'rejected') {
    if (row.rights_verdict === 'REFUSED' && row.decided_at !== null) return 'rights';
    return row.audit_verdict === 'OFF' ? 'auditor' : null;
  }
  if (row.status === 'escalated') return row.rights_verdict === 'REFUSED' ? 'rights' : null;
  if (row.rights_verdict === 'REFUSED') return 'rights';
  // BOOK-206: an `OFF` verdict is a classification, not a refusal. Only a row the ladder placed
  // under a lock is «не принято» (the `rejected` branch above); an undecided row that carries an
  // `OFF` is waiting for the applier and reports no refusal at all.
  return null;
}

/** Filing states the linked change may never upgrade: the row's own word is the last one. */
export const OWN_STATES = new Set<CommentStatus>(['rejected', 'quarantined', 'superseded', 'hidden']);

/** Change states that are an attempt, not a landing — a `void` here is a failed try. */
const ATTEMPT_STATES = new Set<string>(['void', 'failed', 'escalated']);

/**
 * Did this change decide in **human words**? A `void` whose reason is a sentence is the
 * writer's refusal or a supersede; a `void` whose reason is an internal code is an attempt
 * that came back empty, and one with **no** reason at all decides nothing — the chapter's
 * text is the answer in both of those cases.
 */
export function decided(reason: string | null): boolean {
  return !holdsInternalCode(reason) && readerReason(reason) !== null;
}

/**
 * Did this premise land? The one derived fact every surface reads: the change's own answer plus
 * the book's, never a second vocabulary
 * (`ChangeDto.premiseLanded`, a filing's `applied`, a reader's own outcome).
 *
 *   1. `done` is the engine's own settlement: the first edition took it;
 *   2. a `void` whose reason is a **human sentence** is a decision — the writer refused it, it
 *      was superseded, or the chapter was written without it. A refusal always beats a landing;
 *   3. a `void`/`failed`/`escalated` whose reason is an **internal code** is a failed attempt:
 *      it decides nothing, and the chapter's text is the answer;
 *   4. otherwise the chapter's text is the answer — a premise whose chapter has an edition has
 *      entered it.
 */
export function premiseLanded(facts: {
  premise: number | boolean;
  status: string;
  reason: string | null;
  written: boolean;
}): boolean {
  if (facts.premise !== 1 && facts.premise !== true) return false;
  if (facts.status === 'done') return true;
  if (facts.status === 'void' && decided(facts.reason)) return false;
  return facts.written;
}

/**
 * A premise's public states, derived from the two facts that are actually stored: its own row
 * and whether its chapter has text.
 *
 * Order matters, and each step is one fact:
 *   1. a row that decided itself (`rejected`, `quarantined`, `superseded`, `hidden`) keeps its
 *      own word — a linked change may only leave it alone, never upgrade it;
 *   2. a premise that landed is `applied` (`premiseLanded` — a refusal beats a landing);
 *   3. a change that decided in human words is the premise's answer, even over a written
 *      chapter: the writer refused it, or it was superseded;
 *   4. what is left waits: a queued change reads as `accepted`, anything else keeps its row.
 */
export function premiseStatus(
  change: LinkedChange | undefined,
  fallback: CommentStatus,
  written: boolean,
): CommentStatus {
  if (OWN_STATES.has(fallback)) return fallback;
  if (
    change !== undefined &&
    premiseLanded({ premise: change.premise, status: change.status, reason: change.reason, written })
  ) {
    return 'applied';
  }
  if (change !== undefined && change.status === 'void' && decided(change.reason)) {
    return change.outcome === 'superseded' ? 'superseded' : 'rejected';
  }
  if (change !== undefined && change.status === 'pending') return 'accepted';
  return fallback;
}

/**
 * Is the linked change a failed attempt? The engine's `void`/`failed`/`escalated` with an
 * internal-code reason is one: the filing keeps its state and the page says the attempt
 * came back empty. A filing that landed never carries one, a human refusal is not an attempt —
 * it reaches the reader as its own sentence — and neither is a **silent** change, whose reason
 * is `null` and whose answer is the chapter's text. A filing that decided itself (`rejected`,
 * `quarantined`, `superseded`, `hidden`) said the last word: its own refusal is not an echo of
 * an attempt behind it.
 */
export function failedAttempt(change: LinkedChange | undefined, status: CommentStatus): CommentDto['attempt'] {
  if (change === undefined || status === 'applied') return null;
  if (OWN_STATES.has(status)) return null;
  if (!ATTEMPT_STATES.has(change.status)) return null;
  return holdsInternalCode(change.reason) ? 'failed' : null;
}
