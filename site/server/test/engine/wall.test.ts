/**
 * BOOK-34 — the beat and the wall.
 *
 * A real pass writes 10 000–30 000 characters and then waits for the gates; that is
 * longer than `LEASE_TTL_MS` (120 s), so a lease that only the session may beat strands every
 * real step. The engine beats the leases of its open steps by itself and the **step wall**
 * (`STEP_WALL_MS`, from the step's opening — or from its reopen, BOOK-117) is the only bound on
 * growth. These tests exercise the protocol end to end — the same calls the CLI makes — not the
 * helpers.
 */

import { TOTAL_CHAPTERS, type WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { insertRevision } from '../../src/db/repo/revisions.ts';
import { closeStep } from '../../src/engine/close.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { acquireLease, releaseLease, stepWallOf } from '../../src/engine/leases.ts';
import * as store from '../../src/engine/store.ts';
import type { EngineError } from '../../src/engine/types.ts';
import { toIso } from '../../src/util/time.ts';
import { PIPELINE_MODEL, chapterText, createEngineFixture, type Fixture } from './helpers.ts';

function refusalOf(run: () => unknown): EngineError | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as EngineError;
  }
}

function leaseRow(fixture: Fixture, leaseId: string): store.LeaseRow {
  const row = store.getLease(fixture.db, leaseId);
  if (!row) throw new Error(`no lease ${leaseId}`);
  return row;
}

function wallOf(fixture: Fixture, stepId: string): number {
  const step = store.getStep(fixture.db, stepId);
  if (!step) throw new Error(`no step ${stepId}`);
  // The engine's own rule, not a second copy of it (BOOK-117: a reopen moves the wall).
  return stepWallOf(fixture.deps, step);
}

function verdict(fixture: Fixture, role: 'editor' | 'consultant'): void {
  const gate = fixture.engine.next({ role, session: `${role}-1` }) as GateAssignment | null;
  if (!gate) throw new Error(`no ${role} assignment`);
  fixture.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict: 'HOLDS',
    findings: [],
    model: PIPELINE_MODEL,
    tokensIn: 100,
    tokensOut: 10,
  });
}

/** A change on chapter 1 driven to `land` plus both verdicts — the shape a real pass leaves. */
function landedPass(fixture: Fixture): WriterAssignment {
  fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда вместо четверга' });
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац.', 'Второй абзац.']);
  fixture.engine.land(assignment.leaseId);
  verdict(fixture, 'editor');
  verdict(fixture, 'consultant');
  return assignment;
}

function chapterOneFixture(): Fixture {
  return createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
}

/** A step that exists before it is closed, as the engine inserts one (`at` is its opening). */
function addStep(
  fixture: Fixture,
  options: { id: string; chapter: number; at?: number },
): store.StepRow {
  store.insertStep(fixture.db, {
    stepId: options.id,
    cascadeId: null,
    seq: 0,
    wave: 0,
    lane: null,
    pass: 'change',
    chapter: options.chapter,
    boundary: '2',
    seamsIn: '[]',
    revBefore: 0,
    at: toIso(options.at ?? fixture.clock.now()),
  });
  const step = store.getStep(fixture.db, options.id);
  if (!step) throw new Error(`no step ${options.id}`);
  return step;
}

function leaseOf(fixture: Fixture, step: store.StepRow, session: string) {
  return acquireLease(fixture.deps, { step, session, expectedRev: 0, changeId: null });
}

/** F025's trigger: a revision of the ending whose cause is a ripple step. */
function seedCascadeRevisionOfTheEnding(fixture: Fixture): void {
  fixture.db
    .prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
       VALUES (?, 1, 'Конец', 'sha-last', 100, 1, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
    )
    .run(TOTAL_CHAPTERS);
  insertRevision(fixture.db, {
    chapter: TOTAL_CHAPTERS,
    rev: 2,
    at: '2026-10-25T09:30:00Z',
    kind: 'rewrite',
    causeKind: 'cascade',
    changeId: null,
    cascadeId: null,
    stepId: null,
    added: 0,
    changed: 1,
    removed: 0,
    snapshot: 'versions/ch42/sha-last.md',
    attributed: true,
    logNote: null,
  });
}

/** The engine's own tick, exactly as `engine.ts` runs it: reap first, then beat. */
function tick(fixture: Fixture, ms: number): ReturnType<typeof fixture.engine.reap> {
  fixture.clock.advance(ms);
  const report = fixture.engine.reap();
  fixture.engine.heartbeat();
  return report;
}

describe('the engine beats an open step by itself (BOOK-34)', () => {
  it('refreshes the lease of an open step on its own tick, without a session beat', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      const first = leaseRow(fixture, assignment.leaseId);
      expect(first.expires_at).toBe(toIso(fixture.clock.now() + fixture.config.leaseTtlMs));

      // Two thirds of the TTL passes with nobody beating: the gate sessions are thinking.
      fixture.clock.advance(Math.round(fixture.config.leaseTtlMs * 0.66));
      fixture.engine.heartbeat();
      const beaten = leaseRow(fixture, assignment.leaseId);
      expect(beaten.released_at).toBeNull();
      expect(beaten.expires_at).toBe(toIso(fixture.clock.now() + fixture.config.leaseTtlMs));
      expect(beaten.expires_at > first.expires_at).toBe(true);

      // A real pass is far longer than one TTL; the tick keeps the step open the whole way.
      for (let i = 0; i < 10; i += 1) tick(fixture, 101_000);
      expect(leaseRow(fixture, assignment.leaseId).released_at).toBeNull();
      expect(store.getStep(fixture.db, assignment.stepId)?.outcome).toBeNull();

      const done = fixture.engine.done(assignment.leaseId, { seams: [], note: 'auto-beaten', model: PIPELINE_MODEL });
      expect(done.outcome).toBe('rewritten');
      expect(leaseRow(fixture, assignment.leaseId).release_reason).toBe('done');
    } finally {
      fixture.close();
    }
  });

  it('leaves an already-expired lease to the reaper instead of extending it', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      const before = leaseRow(fixture, assignment.leaseId).expires_at;

      fixture.engine.heartbeat();
      const after = leaseRow(fixture, assignment.leaseId);
      expect(after.expires_at).toBe(before);
      expect(after.released_at).toBeNull(); // a beat is not a reaper

      expect(fixture.engine.reap().expiredLeases).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('stops extending at the wall, then the reaper escalates the step and releases the lease', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      const wallAt = wallOf(fixture, assignment.stepId);
      const wallIso = toIso(wallAt);

      let latest = leaseRow(fixture, assignment.leaseId).expires_at;
      let report = fixture.engine.reap();
      for (let t = 0; t <= fixture.config.stepWallMs + 60_000; t += 15_000) {
        report = tick(fixture, 15_000);
        latest = leaseRow(fixture, assignment.leaseId).expires_at;
        // The beat never pushes the expiry past the wall, however healthy the session looks.
        expect(latest <= wallIso).toBe(true);
        if (report.stepWalls.length > 0) break;
      }

      expect(report.stepWalls).toEqual([assignment.stepId]);
      const step = store.getStep(fixture.db, assignment.stepId);
      expect(step?.outcome).toBe('escalated');
      expect(step?.note).toContain('отведённое время');

      const lease = leaseRow(fixture, assignment.leaseId);
      expect(lease.released_at).not.toBeNull();
      expect(lease.release_reason).toBe('escalated');

      const change = fixture.db.prepare('SELECT status, outcome, reason FROM changes').get() as {
        status: string;
        outcome: string;
        reason: string;
      };
      expect(change.status).toBe('escalated');
      expect(change.outcome).toBe('gate_timeout');
      expect(change.reason).toContain('отведённое время');
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('gate_timeout');

      // A walled step is stopped, never re-issued: the next poll never hands it out again.
      const reissued = fixture.engine.next({ for: 'fwd', session: 'writer-2' }) as WriterAssignment | null;
      expect(reissued?.stepId).not.toBe(assignment.stepId);
      expect(store.getStep(fixture.db, assignment.stepId)?.outcome).toBe('escalated');
    } finally {
      fixture.close();
    }
  });

  it('escalates a step past the wall while its lease is alive, and leaves one just under it', () => {
    const fixture = chapterOneFixture();
    try {
      const live = addStep(fixture, {
        id: 'stp_live',
        chapter: 1,
        at: fixture.clock.now() - fixture.config.stepWallMs + 60_000,
      });
      const lease = leaseOf(fixture, live, 'w-live');
      // Just under the wall: the engine beats the lease itself, so nothing happens.
      expect(tick(fixture, 30_000).stepWalls).toEqual([]);
      expect(store.getStep(fixture.db, 'stp_live')?.outcome).toBeNull();
      expect(leaseRow(fixture, lease.id).released_at).toBeNull();

      // Past it: the same live, beaten lease does not save the step.
      expect(tick(fixture, 31_000).stepWalls).toEqual(['stp_live']);
      const closed = store.getStep(fixture.db, 'stp_live');
      expect(closed?.outcome).toBe('escalated');
      expect(leaseRow(fixture, lease.id).release_reason).toBe('escalated');
      // The note is a sentence an operator can read — never a config constant.
      expect(closed?.note).not.toContain('_');
      expect(closed?.note).toContain('отведённое время');
    } finally {
      fixture.close();
    }
  });

  it('refuses a manual beat past the wall and never lets one push the expiry beyond it', () => {
    const fixture = chapterOneFixture();
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда вместо четверга' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      const wallAt = wallOf(fixture, assignment.stepId);
      const wallIso = toIso(wallAt);

      while (fixture.clock.now() + fixture.config.leaseTtlMs < wallAt) {
        fixture.clock.advance(fixture.config.leaseTtlMs - 1_000);
        fixture.engine.beat(assignment.leaseId);
        expect(leaseRow(fixture, assignment.leaseId).expires_at <= wallIso).toBe(true);
      }
      fixture.clock.advance(wallAt - fixture.clock.now());
      expect(leaseRow(fixture, assignment.leaseId).expires_at <= wallIso).toBe(true);

      const refusal = refusalOf(() => fixture.engine.beat(assignment.leaseId));
      expect(refusal?.code).toBe('STEP_WALL');
      expect(refusal?.status).toBe(409);
    } finally {
      fixture.close();
    }
  });

  it('keeps one outcome: a close after the wall stop is refused, the step stays escalated', () => {
    const fixture = chapterOneFixture();
    try {
      const now = fixture.clock.now();
      const step = addStep(fixture, { id: 'stp_stop', chapter: 1, at: now - fixture.config.stepWallMs - 60_000 });
      const lease = leaseOf(fixture, step, 'w1');
      fixture.clock.advance(60_000);
      expect(fixture.engine.reap().stepWalls).toEqual(['stp_stop']);

      expect(refusalOf(() => fixture.engine.done(lease.id, { seams: [], model: PIPELINE_MODEL }))?.code).toBe('LEASE_RELEASED');
      expect(refusalOf(() => fixture.engine.escalate(lease.id, 'не беру'))?.code).toBe('LEASE_RELEASED');
      expect(store.getStep(fixture.db, 'stp_stop')?.outcome).toBe('escalated');
      const closes = fixture.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'step.closed' AND step_id = ?")
        .get('stp_stop') as { n: number };
      expect(closes.n).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('stamps a wall stop over a lease the reaper had already released as `expired`', () => {
    const fixture = chapterOneFixture();
    try {
      const step = addStep(fixture, { id: 'stp_late', chapter: 1 });
      const lease = leaseOf(fixture, step, 'w1');
      // The lease runs out before the wall: the reaper releases it and re-issues the step.
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      fixture.engine.reap();
      expect(leaseRow(fixture, lease.id).release_reason).toBe('expired');

      fixture.clock.advance(fixture.config.stepWallMs);
      expect(fixture.engine.reap().stepWalls).toEqual(['stp_late']);
      // One story, not two: the step says `escalated`, so its release says the same.
      expect(leaseRow(fixture, lease.id).release_reason).toBe('escalated');
      expect(store.getStep(fixture.db, 'stp_late')?.outcome).toBe('escalated');
    } finally {
      fixture.close();
    }
  });

  it('does not let one failing wall close stop the rest of the tick', () => {
    const fixture = chapterOneFixture();
    try {
      // F025 makes every step close refuse; the wall sweep must report it, not wedge the tick.
      seedCascadeRevisionOfTheEnding(fixture);
      const now = fixture.clock.now();
      const walled = addStep(fixture, { id: 'stp_walled', chapter: 1, at: now - fixture.config.stepWallMs - 60_000 });
      const other = addStep(fixture, { id: 'stp_other', chapter: 2, at: now });
      leaseOf(fixture, walled, 'w-wall');
      const otherLease = leaseOf(fixture, other, 'w-other');

      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      const report = fixture.engine.reap();

      expect(report.stepWalls).toEqual([]);
      expect(report.stepWallFailures).toEqual([{ stepId: 'stp_walled', code: 'ENDING_FROZEN' }]);
      // The lease pass still ran: both expired leases were released, both steps re-issued.
      expect(report.expiredLeases).toBe(2);
      expect(leaseRow(fixture, otherLease.id).released_at).not.toBeNull();
      expect(store.getStep(fixture.db, 'stp_walled')?.outcome).toBeNull();
    } finally {
      fixture.close();
    }
  });
});

describe('a close after expiry (BOOK-34)', () => {
  it('accepts done on an expired lease of its own open step and records `expired-close`', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      // The 2026-10-27 shape: the lease runs out while the gates think, the reaper releases it
      // as `expired` and re-issues the step — and only then does the writer report.
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      const report = fixture.engine.reap();
      expect(report.expiredLeases).toBe(1);
      expect(leaseRow(fixture, assignment.leaseId).release_reason).toBe('expired');

      const done = fixture.engine.done(assignment.leaseId, { seams: [], note: 'late but honest', model: PIPELINE_MODEL });
      expect(done.outcome).toBe('rewritten');
      expect(leaseRow(fixture, assignment.leaseId).release_reason).toBe('expired-close');
      // Attribution is the lease that did the work, not whatever lease the step had later.
      expect(store.getStep(fixture.db, assignment.stepId)?.lease_id).toBe(assignment.leaseId);

      const closed = fixture.db
        .prepare("SELECT payload FROM events WHERE kind = 'step.closed' AND step_id = ?")
        .get(assignment.stepId) as { payload: string };
      expect(JSON.parse(closed.payload)).toMatchObject({ outcome: 'rewritten', expiredClose: true });
    } finally {
      fixture.close();
    }
  });

  it('accepts a close on a lease that expired but was not reaped yet', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      const seen = fixture.engine.seen(assignment.leaseId, 'read, nothing to change', { model: PIPELINE_MODEL });
      expect(seen.stepId).toBe(assignment.stepId);
      expect(leaseRow(fixture, assignment.leaseId).release_reason).toBe('expired-close');
    } finally {
      fixture.close();
    }
  });

  it('refuses an expired-lease close when another live lease now owns the step', () => {
    const fixture = chapterOneFixture();
    try {
      const stale = landedPass(fixture);
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      fixture.engine.reap();

      const fresh = fixture.engine.next({ for: 'fwd', session: 'writer-2' }) as WriterAssignment;
      expect(fresh.stepId).toBe(stale.stepId);
      expect(fresh.leaseId).not.toBe(stale.leaseId);

      const refusal = refusalOf(() => fixture.engine.done(stale.leaseId, { seams: [], note: 'stale session', model: PIPELINE_MODEL }));
      expect(refusal?.code).toBe('LEASE_HELD');
      expect(refusal?.status).toBe(409);
      expect(refusal?.message).toContain('writer-2');

      const escalation = refusalOf(() => fixture.engine.escalate(stale.leaseId, 'не беру'));
      expect(escalation?.code).toBe('LEASE_HELD');

      // The step is still the live session's to close.
      const done = fixture.engine.done(fresh.leaseId, { seams: [], note: 'the real holder', model: PIPELINE_MODEL });
      expect(done.stepId).toBe(stale.stepId);
      expect(leaseRow(fixture, fresh.leaseId).release_reason).toBe('done');
    } finally {
      fixture.close();
    }
  });

  it('keeps land and beat on a live lease only', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);

      expect(refusalOf(() => fixture.engine.beat(assignment.leaseId))?.code).toBe('LEASE_EXPIRED');
      expect(refusalOf(() => fixture.engine.land(assignment.leaseId))?.code).toBe('LEASE_EXPIRED');
    } finally {
      fixture.close();
    }
  });

  it('refuses a close attributed to an expired lease while another live lease owns the step', () => {
    const fixture = chapterOneFixture();
    try {
      // The race the service cannot see: the lease was released and the step re-taken between
      // the session's last look and its close. `closeStep` is the last guard.
      const stale = leaseOf(fixture, addStep(fixture, { id: 'stp_race', chapter: 1 }), 'w1');
      releaseLease(fixture.db, stale.id, 'expired', fixture.clock.now());
      const step = store.getStep(fixture.db, 'stp_race');
      if (!step) throw new Error('no step stp_race');
      const fresh = leaseOf(fixture, step, 'w2');

      const refusal = refusalOf(() =>
        closeStep(
          fixture.deps,
          'stp_race',
          {
            outcome: 'escalated',
            seamsOut: [],
            note: null,
            model: null,
            tokensIn: 0,
            tokensOut: 0,
            escalation: 'escalated:origin',
            expiredLeaseId: stale.id,
          },
          fixture.clock.now(),
        ),
      );
      expect(refusal?.code).toBe('LEASE_HELD');
      expect(refusal?.message).toContain('w2');
      expect(leaseRow(fixture, fresh.id).released_at).toBeNull();
      expect(store.getStep(fixture.db, 'stp_race')?.outcome).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('still refuses a lease released for another reason, and an unknown lease', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      fixture.engine.done(assignment.leaseId, { seams: [], note: 'on time', model: PIPELINE_MODEL });
      expect(refusalOf(() => fixture.engine.done(assignment.leaseId, { seams: [], note: 'twice', model: PIPELINE_MODEL }))?.code).toBe(
        'LEASE_RELEASED',
      );
      expect(refusalOf(() => fixture.engine.done('lea_missing', { seams: [], model: PIPELINE_MODEL }))?.code).toBe('LEASE_NOT_FOUND');

      // A close that names a lease nobody ever issued is a caller bug, not an anonymous close.
      const bare = addStep(fixture, { id: 'stp_bare', chapter: 2 });
      expect(
        refusalOf(() =>
          closeStep(
            fixture.deps,
            bare.step_id,
            {
              outcome: 'holds',
              seamsOut: [],
              note: null,
              model: null,
              tokensIn: 0,
              tokensOut: 0,
              expiredLeaseId: 'lea_missing',
            },
            fixture.clock.now(),
          ),
        )?.code,
      ).toBe('LEASE_NOT_FOUND');
    } finally {
      fixture.close();
    }
  });
});
