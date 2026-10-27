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
import {
  getLease,
  getStep,
  extendDispatches,
  heartbeatLaneRow,
  insertLease,
  liveLeaseForStep,
  liveLeases,
  updateLease,
  type LeaseRow,
} from './store.ts';
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

function leaseRowOf(db: Db, leaseId: string): LeaseRow {
  const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId) as LeaseRow | undefined;
  if (!lease) refuse('LEASE_NOT_FOUND', 404, `no lease ${leaseId}`);
  return lease;
}

export function liveLease(deps: EngineDeps, leaseId: string): LeaseRow {
  const lease = leaseRowOf(deps.db, leaseId);
  // A step the engine has already closed answers `STEP_CLOSED` whatever its lease says. The choice
  // is **refused**, not "re-open for one gate read": the reaper closes the step and releases its
  // lease together, so "released" would hide the fact that nothing can land here any more — and
  // the writer takes the bytes it wrote back on this code (no gate hashed them).
  const step = getStep(deps.db, lease.step_id);
  if (step && step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${step.step_id} is already closed`);
  if (lease.released_at !== null) refuse('LEASE_RELEASED', 409, `lease ${leaseId} is released (${lease.release_reason})`);
  if (lease.expires_at <= toIso(deps.clock.now())) {
    refuse('LEASE_EXPIRED', 409, `lease ${leaseId} expired; poll next for a fresh assignment`);
  }
  return lease;
}

/** The wall of a step: the latest instant its lease may be pushed to (§BOOK-34). */
export function stepWallOf(deps: EngineDeps, step: StepRow): number {
  return Date.parse(step.at) + deps.config.stepWallMs;
}

export type CloseLease = { lease: LeaseRow; expired: boolean };

/**
 * BOOK-34 — the lease a *close* may act on.
 *
 * A close (`done`/`seen`/`escalate`) is the session telling the engine what its own pass
 * produced; a lease that ran out while a real model call was still running is not a different
 * fact, so an expired lease of a still-open step stays closeable. The recovery is deliberately
 * narrow: the lease must be past its TTL (the reaper may have released it as `expired` already),
 * the step must still be open, and no other live lease may own the step — otherwise a session
 * that was replaced cannot close (or steal) the step under the replacement (`LEASE_HELD`).
 * `land` and `beat` do not use this: they act on the text and on the lock, so they keep
 * requiring a live lease.
 */
export function closeableLease(deps: EngineDeps, leaseId: string): CloseLease {
  const db = deps.db;
  const lease = leaseRowOf(db, leaseId);
  const at = toIso(deps.clock.now());
  const expired = lease.expires_at <= at;
  if (lease.released_at !== null && !(expired && lease.release_reason === 'expired')) {
    refuse('LEASE_RELEASED', 409, `lease ${leaseId} is released (${lease.release_reason})`);
  }
  if (!expired) return { lease, expired: false };

  const step = getStep(db, lease.step_id);
  if (!step) refuse('LEAKED_STEP', 500, `lease ${leaseId} points at a missing step`);
  if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${step.step_id} is already closed`);
  const holder = db.prepare('SELECT * FROM leases WHERE step_id = ? AND released_at IS NULL').get(step.step_id) as
    | LeaseRow
    | undefined;
  if (holder && holder.id !== lease.id) {
    refuse('LEASE_HELD', 409, `step ${step.step_id} is leased by ${holder.session}`);
  }
  return { lease, expired: true };
}

export function beatLease(deps: EngineDeps, leaseId: string): LeaseRow {
  const lease = leaseRowOf(deps.db, leaseId);
  if (lease.released_at !== null) {
    refuse('LEASE_RELEASED', 409, `lease ${leaseId} is released (${lease.release_reason})`);
  }
  const now = deps.clock.now();
  const step = getStep(deps.db, lease.step_id);
  // BOOK-34: a manual beat may refresh the lease, never past the step wall — a step that has
  // outlived its wall is stopped by the reaper, and beating it must not postpone that. The
  // wall is checked first: past it "expired" would name the symptom, not the cause.
  const wall = step ? stepWallOf(deps, step) : now + deps.config.leaseTtlMs;
  if (wall <= now) {
    refuse('STEP_WALL', 409, `step ${lease.step_id} is past its step wall; poll next for a fresh assignment`);
  }
  if (lease.expires_at <= toIso(now)) {
    refuse('LEASE_EXPIRED', 409, `lease ${leaseId} expired; poll next for a fresh assignment`);
  }
  const expiresAt = Math.min(now + deps.config.leaseTtlMs, wall);
  updateLease(deps.db, lease.id, { heartbeat_at: toIso(now), expires_at: toIso(expiresAt) });
  return { ...lease, heartbeat_at: toIso(now), expires_at: toIso(expiresAt) };
}

/**
 * The step's latest lease, live or released — who the step last belonged to (§BOOK-34). A wall
 * stop of a step whose lease the reaper already released still has a lease to correct.
 */
export function lastLeaseOfStep(db: Db, stepId: string): LeaseRow | undefined {
  return db
    .prepare('SELECT * FROM leases WHERE step_id = ? ORDER BY acquired_at DESC, rowid DESC LIMIT 1')
    .get(stepId) as LeaseRow | undefined;
}

export function releaseLease(
  db: Db,
  leaseId: string,
  reason: 'done' | 'holds' | 'expired' | 'expired-close' | 'escalated' | 'failed',
  nowMs: number,
): void {
  db.prepare('UPDATE leases SET released_at = ?, release_reason = ? WHERE id = ? AND released_at IS NULL').run(
    toIso(nowMs),
    reason,
    leaseId,
  );
}

/**
 * BOOK-34 — release the lease of a step whose close arrived after its expiry, and say so.
 * A close after expiry is not a clean `done`: the release reads `expired-close`, and when the
 * reaper had already released the lease as `expired`, that earlier reason is corrected here —
 * the later close is the fact about how the step ended.
 */
export function releaseForExpiredClose(
  db: Db,
  live: LeaseRow | undefined,
  expiredLeaseId: string | null | undefined,
  nowMs: number,
): void {
  if (live) {
    releaseLease(db, live.id, 'expired-close', nowMs);
    return;
  }
  if (expiredLeaseId) {
    db.prepare("UPDATE leases SET release_reason = 'expired-close' WHERE id = ? AND release_reason = 'expired'").run(
      expiredLeaseId,
    );
  }
}

export type CloseStepLease = { lease: LeaseRow; step: StepRow; expired: boolean };

/**
 * The lease a close attributes to: the expired lease the caller names, or the step's live one.
 * A live lease that is *not* the named expired lease means the step was taken over since the
 * session last looked, so the close is refused (`LEASE_HELD`) rather than booked against a
 * lease that is not its own.
 */
export function leaseForClose(
  db: Db,
  stepId: string,
  expiredLeaseId: string | null | undefined,
): { lease: LeaseRow | undefined; live: LeaseRow | undefined } {
  const live = liveLeaseForStep(db, stepId);
  if (!expiredLeaseId) return { lease: live, live };
  if (live && live.id !== expiredLeaseId) {
    refuse('LEASE_HELD', 409, `step ${stepId} is leased by ${live.session}`);
  }
  const expired = getLease(db, expiredLeaseId);
  if (!expired) refuse('LEASE_NOT_FOUND', 404, `no lease ${expiredLeaseId}`);
  return { lease: expired, live };
}

/**
 * The step a close acts on: still open, with the lease it closes — live, or expired but its
 * own and unclaimed by anyone else (`closeableLease`).
 */
export function openStepForClose(deps: EngineDeps, leaseId: string): CloseStepLease {
  const { lease, expired } = closeableLease(deps, leaseId);
  const step = getStep(deps.db, lease.step_id);
  if (!step) refuse('STEP_NOT_FOUND', 404, `no step ${lease.step_id}`);
  if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${step.step_id} is already closed`);
  return { lease, step, expired };
}

/**
 * BOOK-34 — the engine beats the leases of its open steps by itself.
 *
 * A real pass (20 000–30 000 characters, then the editor and the consultant on real model
 * calls) takes longer than `LEASE_TTL_MS`: a lease that only a session can beat strands every
 * real step. So the engine's own tick refreshes each open step's lease, and session latency is
 * not a failure mode any more. The extension is bounded by the step wall: the expiry is never
 * pushed past `steps.at` (the step's opening) + STEP_WALL_MS, so the wall — not the beat — is the only
 * unbounded-growth guard, and the reaper escalates a step that reaches it.
 */
export function beatOpenSteps(deps: EngineDeps, at: number): void {
  const atIso = toIso(at);
  for (const lease of liveLeases(deps.db)) {
    // An expiry that has already passed is the reaper's business, not a beat's: extending it
    // here would hide a stalled step from the attempt ladder and the wall.
    if (lease.expires_at <= atIso) continue;
    const step = getStep(deps.db, lease.step_id);
    if (!step || step.outcome !== null) continue;
    const wall = stepWallOf(deps, step);
    if (wall <= at) continue; // the reaper owns this step now: it escalates past the wall
    const expiresAt = Math.min(at + deps.config.leaseTtlMs, wall);
    updateLease(deps.db, lease.id, {
      heartbeat_at: atIso,
      expires_at: toIso(expiresAt),
    });
    // The gate window is a reading budget, not a five-minute guess: an editor reading the real
    // chapter for minutes must not lose its dispatch while the step it serves is still open.
    extendDispatches(deps.db, step.step_id, atIso, toIso(Math.min(at + deps.config.gateTtlMs, wall)));
    if (lease.change_id) heartbeatLaneRow(deps.db, lease.change_id, atIso);
  }
}

/**
 * A wall stop owns the step's lease: the step says `escalated`, so its release says the same —
 * a lease the reaper had already released as `expired` must not make the step look like a
 * dead session's leftover (§BOOK-34).
 */
export function stampEscalatedRelease(db: Db, leaseId: string): void {
  db.prepare(
    "UPDATE leases SET release_reason = 'escalated' WHERE id = ? AND released_at IS NOT NULL AND release_reason = 'expired'",
  ).run(leaseId);
}

export function stepOfLease(db: Db, leaseId: string): StepRow {
  const lease = leaseRowOf(db, leaseId);
  const step = getStep(db, lease.step_id);
  if (!step) refuse('LEAKED_STEP', 500, `lease ${leaseId} points at a missing step`);
  return step;
}
