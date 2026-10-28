/**
 * The gate window is a reading budget (the owner's rule, 2026-10-28: «the gate window must be a
 * real budget — at least 20 minutes, configurable by env»).
 *
 * The measured pass on prod: chapter 1 wrote 24 912 characters, then the editor read the chapter
 * for minutes; the five-minute dispatch expired under it and the reaper escalated a healthy pass
 * (`escalated:gate_timeout`, `model NULL`, 0 tokens). So these tests hold two facts apart:
 *
 *  · a dispatch younger than the window survives a reap tick, and the engine's own beat extends a
 *    live one (an expired one belongs to the reaper — the lease rule, applied to a reader);
 *  · past the window the reaper escalates with a sentence an operator can read, in the step note
 *    and in the change's reason, and the minutes come from the config, never from a constant.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { GateAssignment } from '../../src/engine/gates.ts';
import * as store from '../../src/engine/store.ts';
import { toIso } from '../../src/util/time.ts';
import { chapterText, createEngineFixture, type Fixture } from './helpers.ts';

/** The sentence the reaper writes, built from the window it actually ran with. */
const sentenceOf = (minutes: number): string => `гейт не ответил за ${String(minutes)} мин — проход остановлен`;

function fixtureWith(gateTtlMs?: string): Fixture {
  return createEngineFixture({
    chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) },
    ...(gateTtlMs === undefined ? {} : { env: { GATE_TTL_MS: gateTtlMs } }),
  });
}

/** A change on chapter 1 driven to `land`; nothing is closed, so the gates are asked next. */
function landedStep(fixture: Fixture): WriterAssignment {
  fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда вместо четверга' });
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац.', 'Второй абзац.']);
  fixture.engine.land(assignment.leaseId);
  return assignment;
}

function dispatchEditor(fixture: Fixture, session = 'editor-1'): GateAssignment {
  const gate = fixture.engine.next({ role: 'editor', session }) as GateAssignment | null;
  if (!gate) throw new Error('the editor was handed no dispatch');
  return gate;
}

function dispatchOf(fixture: Fixture, stepId: string): store.DispatchRow | undefined {
  return store.getDispatch(fixture.db, stepId, 'editor');
}

/** The engine's own tick as `heartbeat()` runs it: the beat only, no reaper. */
function heartbeat(fixture: Fixture, ms: number): void {
  fixture.clock.advance(ms);
  fixture.engine.heartbeat();
}

describe('the gate window (GATE_TTL_MS) is a budget for reading', () => {
  it('ships 20 minutes and keeps a younger dispatch through a reap tick', () => {
    const fixture = fixtureWith();
    try {
      expect(fixture.config.gateTtlMs).toBe(1_200_000);
      const assignment = landedStep(fixture);
      dispatchEditor(fixture);

      // Nineteen minutes of a slow but healthy read, beaten by the engine as a real step is.
      for (let elapsed = 0; elapsed < 19 * 60_000; elapsed += 20_000) heartbeat(fixture, 20_000);

      expect(fixture.engine.reap().gateTimeouts).toEqual([]);
      expect(dispatchOf(fixture, assignment.stepId)).toBeDefined();
      expect(store.getStep(fixture.db, assignment.stepId)?.outcome).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('escalates a dispatch past the window with a sentence, never a code', () => {
    const fixture = fixtureWith();
    try {
      const assignment = landedStep(fixture);
      dispatchEditor(fixture);

      fixture.clock.advance(fixture.config.gateTtlMs + 1_000);
      const report = fixture.engine.reap();
      expect(report.gateTimeouts).toEqual([assignment.stepId]);

      const step = store.getStep(fixture.db, assignment.stepId);
      expect(step?.outcome).toBe('escalated');
      expect(step?.note).toBe(sentenceOf(20));
      // Neither a config name nor a machine code: an operator reads a sentence, the payload a code.
      expect(step?.note).not.toContain('_');
      expect(step?.note).not.toContain('GATE_TTL_MS');

      const change = fixture.db.prepare('SELECT status, outcome, reason FROM changes').get() as {
        status: string;
        outcome: string;
        reason: string;
      };
      expect(change.status).toBe('escalated');
      expect(change.outcome).toBe('gate_timeout');
      expect(change.reason).toBe(sentenceOf(20));
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('gate_timeout');
      expect(dispatchOf(fixture, assignment.stepId)).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it('reads the minutes from the config: a 15-minute window says so', () => {
    const fixture = fixtureWith('900000');
    try {
      expect(fixture.config.gateTtlMs).toBe(900_000);
      const assignment = landedStep(fixture);
      dispatchEditor(fixture);

      fixture.clock.advance(900_000 + 1_000);
      expect(fixture.engine.reap().gateTimeouts).toEqual([assignment.stepId]);
      expect(store.getStep(fixture.db, assignment.stepId)?.note).toBe(sentenceOf(15));
    } finally {
      fixture.close();
    }
  });

  it('extends a live dispatch on the beat and never revives an expired one', () => {
    const fixture = fixtureWith();
    try {
      const assignment = landedStep(fixture);
      dispatchEditor(fixture);
      const before = dispatchOf(fixture, assignment.stepId)?.expires_at ?? '';

      heartbeat(fixture, 60_000);
      const beaten = dispatchOf(fixture, assignment.stepId);
      expect(beaten?.expires_at).toBe(toIso(fixture.clock.now() + fixture.config.gateTtlMs));
      expect((beaten?.expires_at ?? '') > before).toBe(true);

      // Past the window the reaper owns the row: a beat moves no expiry it did not make.
      fixture.clock.advance(fixture.config.gateTtlMs + 1_000);
      const expiredAt = dispatchOf(fixture, assignment.stepId)?.expires_at;
      fixture.engine.heartbeat();
      expect(dispatchOf(fixture, assignment.stepId)?.expires_at).toBe(expiredAt);

      expect(fixture.engine.reap().gateTimeouts).toEqual([assignment.stepId]);
      expect(store.getStep(fixture.db, assignment.stepId)?.outcome).toBe('escalated');
    } finally {
      fixture.close();
    }
  });
});
