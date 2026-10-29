/**
 * BOOK-137 + BOOK-117 — the writer cannot land a chapter whose frame sentence moved.
 *
 * The engine refuses such a landing (`FRAME_CHANGED`) and the site refuses to publish it; the
 * lane's half is that the text never stays: nothing was written, so the chapter keeps the text
 * the site served, the pass parks with a sentence a reader can read, and the stage trail stays
 * intact — a broken frame must not cost the reader the record of what happened.
 *
 * The frame is the canonical sentence of ch01/ch42 (`@book/shared` `frameSentenceOf`), so the
 * scripted answer here is *valid prose* that opens or closes with the sentence moved by a letter:
 * nothing but the frame guard can refuse it.
 */

import { frameSentenceOf } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 1;
const SENTENCE = 'не дошло: мы не смогли проверить текст. это наша ошибка, правка не отклонена — нажмите «повторить»';

function stagesOf(harness: Harness): string[] {
  return listStages(harness.fixture.db, CHAPTER).map((stage) => stage.stage);
}

function refusedStage(harness: Harness): string {
  return listStages(harness.fixture.db, CHAPTER).find((stage) => stage.stage === 'refused')?.summary ?? '';
}

function revisions(harness: Harness): number {
  return (
    harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(CHAPTER) as { n: number }
  ).n;
}

/**
 * A chapter that opens on the frame sentence. `spaced` renders it with a doubled inner space —
 * the lane's own validator collapses whitespace (`flat`) and accepts it, while the engine's
 * guard (`ingest/frameGuard.ts`) compares characters and refuses: that gap is exactly the belt
 * this test pulls on.
 */
function withFrame(marker: string, spaced = false): string {
  const frame = frameSentenceOf(CHAPTER);
  if (frame === null) throw new Error(`chapter ${String(CHAPTER)} has no frame`);
  const rendered = spaced ? frame.replace('комнату.', 'комнату.  ') : frame;
  return `${'Глава первая'}\n\n${rendered}\n\n${chapterAnswer('', marker).split('\n\n').slice(1).join('\n\n')}`;
}

describe('a chapter whose frame moved is never landed', () => {
  it('refuses the landing, restores the pre-pass text and parks with the sentence', async () => {
    const original = withFrame('исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      harness.fixture.engine.enqueue({ kind: 'operator', chapter: CHAPTER, intent: 'в главе 65 появляется документ о допуске' });

      // The model retypes the frame with a doubled space: the lane's validator collapses it and
      // lets the answer through, so the landing itself is what has to refuse.
      const moved = (frameSentenceOf(CHAPTER) ?? '').replace('комнату.', 'комнату.  ');
      harness.script.push(`${'Глава первая'}\n\n${moved}\n\n${chapterAnswer('', 'новый').split('\n\n').slice(1).join('\n\n')}`);

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('escalated');

      // The reader's sentence, not a code word; the code is in the log.
      expect(refusedStage(harness)).toContain(SENTENCE);
      expect(harness.logs.join('\n')).toContain('FRAME_CHANGED');
      expect(refusedStage(harness)).not.toContain('FRAME_CHANGED');

      // The chapter still reads the text the site served, and nothing was published.
      const back = harness.fixture.readChapter(CHAPTER);
      expect(back).toBe(original);
      expect(back).not.toContain(moved);
      expect(revisions(harness)).toBe(1);

      // The stage trail survives the refusal: the pass says what it did and why it stopped.
      const stages = stagesOf(harness);
      expect(stages).toContain('queued');
      expect(stages).toContain('drafting');
      expect(stages.at(-1)).toBe('refused');
    } finally {
      await harness.close();
    }
  });
});
