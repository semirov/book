/**
 * A land after close is refused (the owner's rule, 2026-10-28: «either a land after close is
 * refused, or it re-opens the step for one gate read; choose, and say which»).
 *
 * The choice is **refused**: a closed step is closed, so `land` answers `STEP_CLOSED` — never
 * `LEASE_RELEASED`, because "the lock is gone" would hide the fact the writer needs (its text can
 * never land on this step) and the writer branches on the code to take the text back. Nothing is
 * published: a revision that no gate hashed would be prose nobody read.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { GateAssignment } from '../../src/engine/gates.ts';
import * as store from '../../src/engine/store.ts';
import type { EngineError } from '../../src/engine/types.ts';
import { chapterText, createEngineFixture, type Fixture } from './helpers.ts';

function refusalOf(run: () => unknown): EngineError | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as EngineError;
  }
}

function revisions(fixture: Fixture, chapter: number): number {
  return (fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(chapter) as { n: number }).n;
}

function landedPass(fixture: Fixture): WriterAssignment {
  fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда вместо четверга' });
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац.', 'Второй абзац.']);
  fixture.engine.land(assignment.leaseId);
  return assignment;
}

function verdict(fixture: Fixture, role: 'editor' | 'consultant'): void {
  const gate = fixture.engine.next({ role, session: `${role}-1` }) as GateAssignment | null;
  if (!gate) throw new Error(`no ${role} assignment`);
  fixture.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict: 'HOLDS',
    findings: [],
    model: 'deepseek/deepseek-v4-pro',
    tokensIn: 100,
    tokensOut: 10,
  });
}

function chapterOneFixture(): Fixture {
  return createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
}

describe('land on a closed step', () => {
  it('answers STEP_CLOSED after the reaper closed the step, and publishes no revision', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      const before = revisions(fixture, 1);
      const revBefore = (store.getStep(fixture.db, assignment.stepId)?.rev_after ?? 0) as number;

      fixture.clock.advance(fixture.config.stepWallMs + 60_000);
      expect(fixture.engine.reap().stepWalls).toEqual([assignment.stepId]);
      // The refusal put the chapter back: exactly one new revision (the restore) and no more.
      const afterRefusal = revisions(fixture, 1);
      expect(afterRefusal).toBe(before + 1);

      // A newer text is on disk — bytes no gate hashed, because the step is already closed.
      fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац.', 'Поздний абзац.']);
      const refusal = refusalOf(() => fixture.engine.land(assignment.leaseId));
      expect(refusal?.code).toBe('STEP_CLOSED');
      expect(refusal?.status).toBe(409);

      // Refused is refused: the revision the gate never saw is not published, and the step keeps
      // the revision it had when the reaper stopped it.
      expect(revisions(fixture, 1)).toBe(afterRefusal);
      expect(store.getStep(fixture.db, assignment.stepId)?.rev_after).toBe(revBefore);
    } finally {
      fixture.close();
    }
  });

  it('answers STEP_CLOSED after a clean close, not LEASE_RELEASED', () => {
    const fixture = chapterOneFixture();
    try {
      const assignment = landedPass(fixture);
      verdict(fixture, 'editor');
      verdict(fixture, 'consultant');
      fixture.engine.done(assignment.leaseId, { seams: [], note: 'on time', model: 'deepseek/deepseek-v4-pro' });

      const refusal = refusalOf(() => fixture.engine.land(assignment.leaseId));
      expect(refusal?.code).toBe('STEP_CLOSED');
      // The step is the fact; the lease is its symptom. The writer's revert branches on this code.
      expect(refusal?.message).toContain('already closed');
    } finally {
      fixture.close();
    }
  });
});
