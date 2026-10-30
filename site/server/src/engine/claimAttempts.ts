/**
 * The queue's own bound (owner's correction, 2026-10-29): «нет, сроков не надо — только конечное
 * количество попыток».
 *
 * A change the lane cannot take is **re-issued and counted** — but only a claim that actually
 * **reached** the change. A poll that finds the lane held by another change, a pass already in
 * flight, an open ripple or the change's own open step is not an attempt of this change: nothing
 * was asked of the engine and nothing was refused, so `changes.attempts` does not move. What
 * counts is a claim the engine reached and could not turn into a step — the ripple or process cap
 * refused the lease, or the lease was already held — and the sixth of those ends the change
 * through the one refusal sink: `void · dropped`, the sentence «заявка не дошла до главы за 6
 * попыток», and the filing behind it `rejected`. No hour and no operator decide it.
 *
 * A paused day is a wait with a bound, and its bound is the day itself: a claim that meets the
 * pause spends nothing here (the counter does not move), and the change waits for 00:00 UTC.
 * A stopped book is not a count at all: it is refused at once, with no attempt spent
 * (`engine/reap.ts`).
 */

import { QUEUE_MAX_ATTEMPTS, queueAttemptsLine } from '@book/shared';

import { appendChangeEvent } from '../history/log.ts';
import { refuseChange } from './refuse.ts';
import * as store from './store.ts';
import type { EngineDeps } from './types.ts';

export type ClaimAttempts = {
  /** Count one claim that reached the change and produced no step; at the bound, drop it. */
  missed(change: store.ChangeRow, at: number): void;
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

  return { missed };
}
