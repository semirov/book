/**
 * BOOK-145 — a step the engine takes away is a normal event, never a park.
 *
 * A step wall, a released lease, a step the engine closed itself: the lane says so in one line,
 * asks for the next assignment at once (`status: 'gone'`, exit 0) and never escalates a step
 * that is not its own — a second park there would tell the reader a false story.
 *
 * BOOK-219 adds the other half: a run that **landed** takes its own text back before it answers
 * `gone`. The wall closed the step and nobody else holds this pass's `preRev`, so a revision left
 * behind would stay served with no gate and no owner — `gone` on its own is only the answer when
 * the way back finds nothing of ours.
 */

import { describe, expect, it } from 'vitest';

import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness } from './harness.ts';

const CHAPTER = 40;

describe('a dead step', () => {
  it('answers `gone` when the lease is released under the pass, without a second park', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = null;
      // The engine closes the step while the pass is between calls: the next beat is refused
      // with LEASE_RELEASED, which is the shape of a step wall in the log.
      harness.hooks.beforeCall = (name) => {
        if (name !== 'beat') return;
        harness.hooks.beforeCall = undefined;
        const lease = harness.fixture.db
          .prepare('SELECT id FROM leases WHERE released_at IS NULL ORDER BY acquired_at DESC LIMIT 1')
          .get() as { id: string } | undefined;
        if (lease !== undefined) harness.fixture.engine.escalate(lease.id, 'тест: шаг снят движком');
      };
      harness.script.push(chapterAnswer());
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('gone');
      // The owner's line, verbatim: a scheduling event, not a prose event.
      expect(harness.logs.some((line) => line.includes('lease released by the engine — taking the next filing'))).toBe(
        true,
      );
      // No park, no escalate: the engine already closed the step.
      expect(harness.engineCalls).not.toContain('escalate');
      expect(harness.logs.some((line) => line.startsWith('[writer] parked'))).toBe(false);
      // No park sentence reached the record: the pass never claimed a failure.
      expect(result.reason).toBe('lease released by the engine — taking the next filing');
    } finally {
      await harness.close();
    }
  });

  it('puts the landed text back when the step wall closes the step after the draft', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      harness.fixture.engine.enqueue({
        kind: 'operator',
        chapter: CHAPTER,
        intent: 'в главе 40 появляется документ о допуске',
      });
      harness.script.push(chapterAnswer('Глава сорок', 'новый'));
      // The wall stops the step between the landing and the editor's answer — the reaper's own
      // close (`escalated:gate_timeout`), the lease released under a revision already served.
      let beats = 0;
      harness.hooks.beforeCall = (name) => {
        if (name !== 'beat') return;
        beats += 1;
        if (beats !== 2) return;
        harness.fixture.clock.advance(harness.fixture.config.stepWallMs + 60_000);
        harness.fixture.engine.reap();
      };

      const result = await harness.run({ lanes: ['fwd'] });

      expect(result.status).toBe('gone');
      // BOOK-219: the text this run published goes back to what the site served before the pass.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      const revisions = harness.fixture.db
        .prepare('SELECT rev, cause_kind AS kind FROM revisions WHERE chapter = ? ORDER BY rev DESC')
        .all(CHAPTER) as Array<{ rev: number; kind: string }>;
      // Base 1, the pass's own landing 2, and the restore that put the base back as revision 3.
      expect(revisions.map((row) => row.kind)).toEqual(['restore', 'change', 'draft']);
      expect(harness.engineCalls).toContain('restore');
      // A `gone` step never claims a landing: no stage, no push, no second park sentence.
      expect(listStages(harness.fixture.db, CHAPTER).some((stage) => stage.stage === 'landed')).toBe(false);
      expect(harness.engineCalls).not.toContain('escalate');
      expect(result.reason).toBe('lease released by the engine — taking the next filing');
    } finally {
      await harness.close();
    }
  });
});
