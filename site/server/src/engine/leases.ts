/**
 * Leases (ARCHITECTURE.md §6A.11, ADR-017).
 *
 * A lease is the only way a session may write: time-bounded, chapter-exclusive, and
 * carrying the step it serves. It is a lock that dies — a crashed session cannot block a
 * chapter forever — and the unique index on the live target makes "two sessions cannot
 * write the same chapter" a database fact rather than a convention.
 */

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { newLeaseId } from '../util/ulid.ts';
import type { StepRow } from './store.ts';
import { getStep, insertLease, liveLeases, updateLease, type LeaseRow } from './store.ts';
import { isWritten } from './text.ts';
import { refuse, type EngineDeps } from './types.ts';

export type AcquireInput = {
  step: StepRow;
  session: string;
  expectedRev: number;
  changeId: string | null;
};

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/u.test(message);
}

/** Live dispatches are gate processes in flight and count against the process bound (§6A.3). */
function liveDispatchCount(db: Db, nowIso: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM gate_dispatches WHERE expires_at > ?').get(nowIso) as {
      n: number;
    }
  ).n;
}

export function acquireLease(deps: EngineDeps, input: AcquireInput): LeaseRow {
  const { db, config } = deps;
  const now = deps.clock.now();
  const at = toIso(now);
  const step = input.step;

  if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${step.step_id} is already closed`);
  if (step.lease_id !== null) {
    const existing = liveLeases(db).find((lease) => lease.id === step.lease_id);
    if (existing) refuse('LEASE_HELD', 409, `step ${step.step_id} is leased by ${existing.session}`);
  }

  if (step.pass === 'cascade' && step.chapter === 67) {
    // C3 / ADR-024: the ending is never rewritten by a ripple.
    refuse('ENDING_FROZEN', 409, 'chapter 67 is never rewritten by a cascade');
  }
  if (step.pass === 'cascade' && step.chapter !== null && !isWritten(deps.bookRoot, step.chapter)) {
    // C1: a ripple may not walk into an empty slot.
    refuse('NEIGHBOUR_MISSING', 409, `глава ${step.chapter} ещё не написана`);
  }

  const live = liveLeases(db);
  const rippleLive = live.filter((lease) => lease.kind === 'change' || lease.kind === 'cascade').length;
  if ((step.pass === 'change' || step.pass === 'cascade') && rippleLive >= config.maxConcurrentSteps) {
    refuse('STEP_CAP', 409, `at most ${config.maxConcurrentSteps} ripple steps may be in flight (§6A.3)`);
  }
  const processes = live.length + liveDispatchCount(db, at);
  if (processes >= config.maxConcurrentProcesses) {
    refuse('PROCESS_CAP', 409, `at most ${config.maxConcurrentProcesses} model processes may be in flight`);
  }
  const id = newLeaseId(now);
  try {
    insertLease(db, {
      id,
      stepId: step.step_id,
      changeId: input.changeId,
      cascadeId: step.cascade_id,
      lane: step.lane,
      chapter: step.chapter,
      isFront: step.pass === 'front' ? 1 : 0,
      kind: step.pass,
      session: input.session,
      expectedRev: input.expectedRev,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: toIso(now + config.leaseTtlMs),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      refuse('LEASE_HELD', 409, `chapter ${step.chapter ?? 'front'} already has a live lease`);
    }
    throw error;
  }

  return db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as LeaseRow;
}

export function liveLease(deps: EngineDeps, leaseId: string): LeaseRow {
  const lease = deps.db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId) as LeaseRow | undefined;
  if (!lease) refuse('LEASE_NOT_FOUND', 404, `no lease ${leaseId}`);
  if (lease.released_at !== null) refuse('LEASE_RELEASED', 409, `lease ${leaseId} is released (${lease.release_reason})`);
  if (lease.expires_at <= toIso(deps.clock.now())) {
    refuse('LEASE_EXPIRED', 409, `lease ${leaseId} expired; poll next for a fresh assignment`);
  }
  return lease;
}

export function beatLease(deps: EngineDeps, leaseId: string): LeaseRow {
  const lease = liveLease(deps, leaseId);
  const now = deps.clock.now();
  updateLease(deps.db, lease.id, {
    heartbeat_at: toIso(now),
    expires_at: toIso(now + deps.config.leaseTtlMs),
  });
  return { ...lease, heartbeat_at: toIso(now), expires_at: toIso(now + deps.config.leaseTtlMs) };
}

export function releaseLease(
  db: Db,
  leaseId: string,
  reason: 'done' | 'holds' | 'expired' | 'escalated' | 'failed',
  nowMs: number,
): void {
  db.prepare('UPDATE leases SET released_at = ?, release_reason = ? WHERE id = ? AND released_at IS NULL').run(
    toIso(nowMs),
    reason,
    leaseId,
  );
}

export function stepOfLease(db: Db, leaseId: string): StepRow {
  const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId) as LeaseRow | undefined;
  if (!lease) refuse('LEASE_NOT_FOUND', 404, `no lease ${leaseId}`);
  const step = getStep(db, lease.step_id);
  if (!step) refuse('LEAKED_STEP', 500, `lease ${leaseId} points at a missing step`);
  return step;
}
