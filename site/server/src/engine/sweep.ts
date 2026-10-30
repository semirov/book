/**
 * `reconcile` — the operator's sweep (ARCHITECTURE.md §6A.11, §6B.4).
 *
 * One tick of the reaper (`reap.ts`), plus the two leaks a tick cannot see: a lease still held
 * by a step that already closed, and a premise whose chapter was written outside its own first
 * pass and can never land in that edition any more. The counts it returns are the operator's
 * panel; nothing here judges prose.
 */

import { releaseLease } from './leases.ts';
import { reap } from './reap.ts';
import * as store from './store.ts';
import type { EngineDeps } from './types.ts';
import { sweepZombies, zombieFailureLine } from './zombieSweep.ts';

export function reconcileSweep(deps: EngineDeps): Record<string, unknown> {
  const { db } = deps;
  const now = deps.clock.now();
  const report = reap(deps, now);
  const leaked = db
    .prepare(
      `SELECT l.id FROM leases l JOIN steps s ON s.step_id = l.step_id
        WHERE l.released_at IS NULL AND s.outcome IS NOT NULL`,
    )
    .all() as Array<{ id: string }>;
  for (const lease of leaked) releaseLease(db, lease.id, 'expired', now);
  // BOOK-235: every row neither a tick nor a premise can see on its own — an open step nobody can
  // be handed, a cascade nobody will close, a `processing` ghost, a change resting in `escalated`,
  // and a premise whose chapter was written without it (rule 0 of the sweep owns the premise pass;
  // BOOK-7's own `reconcilePremises` is the rule it applies). Without this pass the lane's guards
  // read those rows as work in flight and the queue never moves.
  const zombies = sweepZombies(deps, { now });
  for (const line of zombies.lines) deps.log?.(line);
  // A failed row is not silent either: the sweep's own gap must reach the operator's log.
  // The report keeps it in `failures`; the boot line below carries the whole structure.
  for (const failure of zombies.failures) deps.log?.(zombieFailureLine(failure.id, failure.code));
  return {
    ...report,
    lane: { holder: store.readLane(db).holder },
    leakedLeases: leaked.length,
    premisesSettled: zombies.rows.filter((row) => row.condition.startsWith('premise-')).length,
    zombies: { rows: zombies.rows, lines: zombies.lines, failures: zombies.failures },
    processing: store.countProcessing(db),
    pending: store.countPending(db),
    openSteps: store.countOpenSteps(db),
  };
}
