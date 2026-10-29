/**
 * BOOK-DOC-84 #17 — `filing:update`: one reader's filing, narrated where it changes.
 *
 * The state table's class A rows are the reason this file exists: a filing held by Gate A, the
 * attempt counter, a refusal, an expiry and the paperwork branch's `registered` were facts only
 * a refetch could learn. The frame carries the filing's own row — its chapter, its state, its
 * tries left and the change it became — so the thread and the trail print the change at once.
 *
 * The builder takes the transition (the caller knows which write it just made) and reads the
 * counters from the ledger, so a frame can never promise a number the ledger does not hold.
 */

import type { FilingState, FilingUpdatePayload } from '@book/shared';

import type { Db } from '../db/db.ts';
import { attemptCounts } from '../comments/attempts.ts';

export type FilingEmit = (type: 'filing:update', data: FilingUpdatePayload) => void;

export type FilingTransition = {
  commentId: string;
  chapter: number;
  state: FilingState;
  changeId?: string | null;
  /** ms epoch of the write; the caller's own clock, never a later read. */
  at: number;
};

/** The frame for one transition of one filing, from the row's own ledger. */
export function filingUpdatePayload(db: Db, transition: FilingTransition): FilingUpdatePayload {
  const counts = attemptCounts(db, transition.commentId, transition.at);
  return {
    commentId: transition.commentId,
    chapter: transition.chapter,
    state: transition.state,
    attempts: counts.attempts,
    attemptsLeft: counts.attemptsLeft,
    changeId: transition.changeId ?? null,
    at: transition.at,
  };
}

/** Emit it. A caller that has no emitter (the CLI, a test with no socket) passes none. */
export function emitFilingUpdate(
  db: Db,
  emit: FilingEmit | null | undefined,
  transition: FilingTransition,
): void {
  if (emit === undefined || emit === null) return;
  emit('filing:update', filingUpdatePayload(db, transition));
}
