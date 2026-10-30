/**
 * `reconcile` — the operator's sweep (ARCHITECTURE.md §6A.11, §6B.4).
 *
 * One tick of the reaper (`reap.ts`), plus the two leaks a tick cannot see: a lease still held
 * by a step that already closed, and a premise whose chapter was written outside its own first
 * pass and can never land in that edition any more. The counts it returns are the operator's
 * panel; nothing here judges prose.
 */

import { releaseLease } from './leases.ts';
import { reconcilePremises } from './premise.ts';
import { reap } from './reap.ts';
import * as store from './store.ts';
import type { EngineDeps } from './types.ts';

export function reconcileSweep(deps: EngineDeps): Record<string, unknown> {
  const { db } = deps;
  const report = reap(deps, deps.clock.now());
  const leaked = db
    .prepare(
      `SELECT l.id FROM leases l JOIN steps s ON s.step_id = l.step_id
        WHERE l.released_at IS NULL AND s.outcome IS NOT NULL`,
    )
    .all() as Array<{ id: string }>;
  for (const lease of leaked) releaseLease(db, lease.id, 'expired', deps.clock.now());
  // BOOK-7: a premise whose chapter was written outside its own first pass can never land
  // in that edition any more; it is closed with a public reason instead of waiting forever.
  const premisesSettled = reconcilePremises(deps, deps.clock.now());
  return {
    ...report,
    lane: { holder: store.readLane(db).holder },
    leakedLeases: leaked.length,
    premisesSettled,
    processing: store.countProcessing(db),
    pending: store.countPending(db),
    openSteps: store.countOpenSteps(db),
  };
}
