/**
 * The queue's own bound (owner's correction, 2026-10-29): «нет, сроков не надо — только конечное
 * количество попыток».
 *
 * A change the lane cannot take is **re-issued and counted**. Every claim attempt that produced no
 * step — the lane held by another change, a pass in flight, a claim that lost its race, a lease the
 * caps refused — increments `changes.attempts` here, and the sixth ends the change through the one
 * refusal sink: `void · dropped`, the sentence «заявка не дошла до главы за 6 попыток», and the
 * filing behind it `rejected`. No hour and no operator decide it.
 *
 * A paused day is a wait with a bound, so its re-issue counts too. A stopped book is not a count at
 * all: it is refused at once, with no attempt spent (`engine/reap.ts`).
 */

import { QUEUE_MAX_ATTEMPTS, queueAttemptsLine } from '@book/shared';

import { appendChangeEvent } from '../history/log.ts';
import { refuseChange } from './refuse.ts';
import * as store from './store.ts';
import type { EngineDeps } from './types.ts';

export type ClaimAttempts = {
  /** Count one claim that produced no step; at the bound, drop the change and its filing. */
  missed(change: store.ChangeRow, at: number): void;
  /** A paused day: the oldest waiting filing's re-issue counts, and nothing else moves. */
  paused(at: number): void;
};

export function createClaimAttempts(deps: EngineDeps): ClaimAttempts {
  const { db } = deps;

  function missed(change: store.ChangeRow, at: number): void {
    const bumped = db
      .prepare(`UPDATE changes SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'`)
      .run(change.id).changes;
    if (bumped !== 1) return;
    const attempts = store.getChange(db, change.id)?.attempts ?? change.attempts + 1;
    appendChangeEvent(db, change.id, 'released', { attempts, claim: true }, at);
    if (attempts < QUEUE_MAX_ATTEMPTS) return;
    refuseChange(deps, {
      changeId: change.id,
      because: queueAttemptsLine(QUEUE_MAX_ATTEMPTS),
      cause: 'escalated:gate_timeout',
      now: at,
    });
  }

  function paused(at: number): void {
    const waiting = store.listPending(db)[0];
    if (waiting !== undefined) missed(waiting, at);
  }

  return { missed, paused };
}
