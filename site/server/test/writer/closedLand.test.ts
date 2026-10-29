/**
 * The writer's half of «a land after close is refused» (the owner's rule, 2026-10-28).
 *
 * The engine answers `STEP_CLOSED` on `land` when the step closed while the text was being
 * written. Since BOOK-187 the text travels in the request, so a refused landing leaves nothing
 * behind: the chapter still reads what the site served, and the pass parks with a sentence a
 * reader can read — «глава закрылась, пока текст писался — текст не опубликован». The code stays in
 * the log and in the transcript. Both the slot that had text and the empty slot are covered:
 * the rows are the evidence, and no gate hashed a text the site never published.
 */

import { describe, expect, it } from 'vitest';

import { STOP_REASONS } from '@book/shared';

import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 40;
const SENTENCE = STOP_REASONS.stepClosed;

/** The sentence the pass parks with: the `refused` stage is where a parked pass says why. */
function refusedStage(harness: Harness): string {
  const stages = listStages(harness.fixture.db, CHAPTER);
  return stages.find((stage) => stage.stage === 'refused')?.summary ?? '';
}

function revisions(harness: Harness): number {
  return (
    harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(CHAPTER) as { n: number }
  ).n;
}

/** The step closes under the writer's feet: the wall stop runs just before `land` reaches the engine. */
function closeStepBeforeLand(harness: Harness): void {
  harness.hooks.beforeCall = (name) => {
    if (name !== 'land') return;
    harness.fixture.clock.advance(harness.fixture.config.stepWallMs + 60_000);
    harness.fixture.engine.reap();
  };
}

describe('the writer takes its text back when the step closed under it', () => {
  it('leaves the chapter exactly as it was and parks with the sentence', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      // A whole-chapter filing (scope `chapter`): the pass rewrites, which is the landing under test.
      harness.fixture.engine.enqueue({ kind: 'operator', chapter: CHAPTER, intent: 'в главе 40 появляется документ о допуске', scopeHint: 'chapter' });
      harness.script.push(chapterAnswer('Глава сорок', 'новый'));
      closeStepBeforeLand(harness);

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      const step = stepRow(harness.fixture, result.stepId ?? '');
      expect(step?.outcome).toBe('escalated');
      // The note of a closed step belongs to the close; the writer's own sentence is its stage.
      expect(refusedStage(harness)).toContain(SENTENCE);
      expect(harness.logs.join('\n')).toContain('STEP_CLOSED');

      // The chapter reads what the site served before the pass: the answer was sent, not written.
      const back = harness.fixture.readChapter(CHAPTER);
      expect(back).toBe(original);
      expect(back).not.toContain('новый');

      // Nothing no gate hashed was published: the chapter keeps the revision it had.
      expect(revisions(harness)).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('removes the file when the slot was empty before the pass', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer('Глава сорок', 'новый'));
      closeStepBeforeLand(harness);

      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('parked');
      expect(refusedStage(harness)).toContain(SENTENCE);
      // The slot was empty, so it stays empty: nothing was published for a refused landing.
      expect(harness.fixture.readChapter(CHAPTER)).toBeNull();
      expect(revisions(harness)).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
