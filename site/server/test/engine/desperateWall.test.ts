/**
 * BOOK-220 M2 — the desperate dispatch's wall (BOOK-DOC-84 §10.7/§10.8).
 *
 * A desperate step is a dispatch, not work: with a lease its bound runs from the attempt's own
 * lease, and **without** one — a writer that is down, or was killed before claiming — the wait
 * was unbounded: the reaper `continue`d before its wall check and the second loop only walks
 * `expiredLeases`, so the step stayed open for ever. These tests are the wall the design page
 * promises: a bounded wait, one `step:closed`-shaped close `interrupted`, and a fresh dispatch
 * left alone. The suite lives beside `wall.test.ts` (which is at the arch bound).
 */

import { describe, expect, it } from 'vitest';

import { appendEvent } from '../../src/history/log.ts';
import * as store from '../../src/engine/store.ts';
import { toIso } from '../../src/util/time.ts';
import { chapterText, createEngineFixture, type Fixture } from './helpers.ts';

function chapterOneFixture(): Fixture {
  return createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
}

/** A step that exists before it is closed, as the engine inserts one (`at` is its opening). */
function addStep(fixture: Fixture, options: { id: string; chapter: number; at?: number }): store.StepRow {
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

/** The engine's own tick: reap first, then beat (as `engine.ts` runs it). */
function tick(fixture: Fixture, ms: number): ReturnType<typeof fixture.engine.reap> {
  fixture.clock.advance(ms);
  const report = fixture.engine.reap();
  fixture.engine.heartbeat();
  return report;
}

const markDesperate = (fixture: Fixture, stepId: string): void => {
  fixture.db.prepare('UPDATE steps SET desperate = 1 WHERE step_id = ?').run(stepId);
};

describe('a desperate dispatch nobody claimed is bounded (BOOK-220 M2)', () => {
  it('closes it `interrupted` once, and leaves a fresh one alone', () => {
    const fixture = chapterOneFixture();
    try {
      // The bound is the dispatch's own wall — `DESPERATE_WAIT_FACTOR` × the attempt's bound
      // (5 × 180 s = one `WRITER_PAUSE_MS`) — from the step's own opening when it was seeded
      // already desperate and no `step.opened` dispatch exists for it.
      const wall = 5 * fixture.config.desperateDeadlineMs;
      const at = fixture.clock.now();
      const stale = addStep(fixture, { id: 'stp_orphan', chapter: 1, at: at - wall - 60_000 });
      markDesperate(fixture, stale.step_id);
      const fresh = addStep(fixture, { id: 'stp_fresh', chapter: 2, at });
      markDesperate(fixture, fresh.step_id);

      const report = fixture.engine.reap();
      // The wall §10.7 promises: the wait is bounded even with the writer down.
      expect(report.stepWalls).toEqual(['stp_orphan']);
      const closed = store.getStep(fixture.db, 'stp_orphan');
      expect(closed?.outcome).toBe('interrupted');
      expect(closed?.note).toContain('не дождалась сессии');
      // A fresh dispatch is left alone: a session may still claim it.
      expect(store.getStep(fixture.db, 'stp_fresh')?.outcome).toBeNull();

      const closes = fixture.db
        .prepare("SELECT payload FROM events WHERE kind = 'step.closed' AND step_id = ?")
        .all('stp_orphan') as Array<{ payload: string }>;
      expect(closes).toHaveLength(1);
      expect(JSON.parse(closes[0]!.payload)).toMatchObject({ outcome: 'interrupted', unclaimed: true });

      // One tick, one close: the next sweep finds nothing open and says nothing twice.
      expect(tick(fixture, 60_000).stepWalls).toEqual([]);
      expect(
        fixture.db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'step.closed' AND step_id = ?")
          .get('stp_orphan'),
      ).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });

  it('bounds the wait from the desperate dispatch, not from the step’s first opening', () => {
    const fixture = chapterOneFixture();
    try {
      // A real ladder's step was opened hours ago; its desperate dispatch is recent. The bound
      // runs from the dispatch (the `step.opened` the reaper wrote), so the sixth is not closed
      // before a session can claim it.
      const now = fixture.clock.now();
      const step = addStep(fixture, { id: 'stp_dispatch', chapter: 1, at: now - 5 * 60 * 60_000 });
      markDesperate(fixture, step.step_id);
      appendEvent(
        fixture.db,
        {
          kind: 'step.opened',
          stepId: step.step_id,
          chapter: 1,
          payload: { pass: 'change', reissued: true, desperate: true },
        },
        now - 60_000,
      );

      expect(fixture.engine.reap().stepWalls).toEqual([]);
      expect(store.getStep(fixture.db, 'stp_dispatch')?.outcome).toBeNull();

      // Past 5 × 180 s from the dispatch: no session came, the wait is over.
      expect(tick(fixture, 5 * fixture.config.desperateDeadlineMs).stepWalls).toEqual(['stp_dispatch']);
      expect(store.getStep(fixture.db, 'stp_dispatch')?.outcome).toBe('interrupted');
    } finally {
      fixture.close();
    }
  });
});
