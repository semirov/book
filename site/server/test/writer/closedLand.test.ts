/**
 * The writer's half of «a land after close is refused» (the owner's rule, 2026-10-28).
 *
 * The engine answers `STEP_CLOSED` on `land` when the step closed while the text was being
 * written, and the bytes then on disk were never hashed by a gate — so the pass puts its pre-pass
 * snapshot back (or removes a file the slot never had) and parks with a sentence a reader can
 * read: «шаг закрылся, пока текст писался — текст возвращён к прежнему». The code stays in the
 * log and in the transcript. Both the slot that had text and the empty slot are covered, byte for
 * byte: a revert nobody verified is a claim, not a fact.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listStages } from '../../src/stages/repo.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 40;
const SENTENCE = 'шаг закрылся, пока текст писался — текст возвращён к прежнему';

function chapterFile(harness: Harness): string {
  return join(harness.bookRoot, 'manuscript', `ch${String(CHAPTER)}.md`);
}

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
  it('restores the pre-pass snapshot byte for byte and parks with the sentence', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      harness.ingest(CHAPTER);
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
      expect(harness.logs.join('\n')).not.toContain('land STEP_CLOSED: снимок до прохода не найден');

      // Byte for byte: what a gate read before the close is what the manuscript holds again.
      expect(existsSync(chapterFile(harness))).toBe(true);
      const back = readFileSync(chapterFile(harness), 'utf8');
      expect(back).toBe(original);
      expect(sha256Hex(back)).toBe(sha256Hex(original));
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
      // The slot was empty, so the pass leaves it empty: the snapshot says `absent`.
      expect(existsSync(chapterFile(harness))).toBe(false);
      expect(revisions(harness)).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
