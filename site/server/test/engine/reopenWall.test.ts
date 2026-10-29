/**
 * BOOK-117 — a reopen is a fresh window for the step wall too.
 *
 * The prod case (2026-10-29): a step opened at 09:10 was re-opened to be closed with the
 * verdicts it earned, and the reaper walled it 45 minutes after its *opening* — the reopen door
 * could not close anything older than the wall. So the wall is measured from
 * `MAX(at, reopened_at)`: the re-opened step gets a window of its own, and is still walled when
 * that window is spent. `at` never moves — it is the step's opening, not a second opening.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import * as store from '../../src/engine/store.ts';
import { toIso } from '../../src/util/time.ts';
import { createEngineFixture, type Fixture } from './helpers.ts';

/** Two hours: `STEP_WALL_MS` is 45 minutes, so a wall measured from the opening has passed. */
const PAST_THE_WALL = 2 * 60 * 60 * 1000;

/** A chapter drafted, landed and escalated — the only state `reopen` accepts. */
function landedThenEscalated(fixture: Fixture): WriterAssignment {
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(assignment.chapter as number, 'Начало', ['Тестовый абзац главы.', 'Второй абзац.']);
  fixture.engine.land(assignment.leaseId);
  fixture.engine.escalate(assignment.leaseId, 'гейт прав не ответил');
  return assignment;
}

function stepRow(fixture: Fixture, stepId: string): Record<string, unknown> {
  const row = fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(stepId) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) throw new Error(`no step ${stepId}`);
  return row;
}

describe('reopen — the step wall of a fresh window', () => {
  it('does not wall a step opened two hours ago and reopened now', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landedThenEscalated(fixture);
      // Measured from its opening, this step's wall is long gone: before the reopen stamped a
      // window of its own there was no way to close it at all.
      fixture.clock.advance(PAST_THE_WALL);
      const reopenedAt = toIso(fixture.clock.now());
      fixture.engine.reopen(assignment.stepId, 'BOOK-117: закрыть вердиктами, которые он заслужил');
      expect(stepRow(fixture, assignment.stepId).reopened_at).toBe(reopenedAt);

      const report = fixture.engine.reap();
      expect(report.stepWalls).not.toContain(assignment.stepId);
      expect(report.stepWallFailures).toEqual([]);
      expect(stepRow(fixture, assignment.stepId).outcome).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('walls a step whose reopen is itself past the wall', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landedThenEscalated(fixture);
      const reopenedAt = toIso(fixture.clock.now());
      fixture.engine.reopen(assignment.stepId, 'BOOK-117: закрыть вердиктами, которые он заслужил');
      // Two hours spent in the window the reopen opened: the wall is back, and the stop is the
      // same stop — a reopen is a window, not an exemption.
      fixture.clock.advance(PAST_THE_WALL);

      const report = fixture.engine.reap();
      expect(report.stepWalls).toContain(assignment.stepId);
      const step = stepRow(fixture, assignment.stepId);
      expect(step.outcome).toBe('escalated');
      expect(step.reopened_at).toBe(reopenedAt);
      expect(String(step.note)).toContain('не закрылась за отведённое время');
    } finally {
      fixture.close();
    }
  });

  it('keeps `listOpenSteps` in opening order, never in reopen order', () => {
    const fixture = createEngineFixture();
    try {
      const base = fixture.clock.now();
      for (const [id, at] of [
        ['stp_order_later', base],
        ['stp_order_earlier', base - 60_000],
      ] as const) {
        store.insertStep(fixture.db, {
          stepId: id,
          cascadeId: null,
          seq: id === 'stp_order_later' ? 0 : 1,
          wave: 0,
          lane: null,
          pass: 'change',
          chapter: 1,
          boundary: '2',
          seamsIn: '[]',
          revBefore: 0,
          at: toIso(at),
        });
      }
      // The later opening carries the earlier reopen: order still follows the opening, so the
      // reaper walks the queue in the order the steps were opened.
      store.updateStep(fixture.db, 'stp_order_later', { reopened_at: toIso(base - 120_000) });
      store.updateStep(fixture.db, 'stp_order_earlier', { reopened_at: toIso(base + 120_000) });

      expect(store.listOpenSteps(fixture.db).map((step) => step.step_id)).toEqual([
        'stp_order_earlier',
        'stp_order_later',
      ]);
    } finally {
      fixture.close();
    }
  });
});
