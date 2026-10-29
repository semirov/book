/**
 * BOOK-219 — a lost answer is not a fact (the review of the close path, 2026-10-29).
 *
 * A `done` or a `land` whose response never arrives may have been **applied**: the close can be
 * in, the push can be out, the revision can be served. Reading such a response as a failure and
 * then taking the text back contradicts the engine's own record — the reader is told the text was
 * reverted over a chapter that is already published, and the restore fights a close that happened.
 *
 * So the rows are asked, not guessed:
 *
 *  · after a lost `land`, the chapter is read back — one that already serves the text *is* this
 *    pass's landing, and the pass closes on it;
 *  · after a lost `done`, the step is read back (`/internal/trace`): closed means closed, no
 *    restore and no «возвращён»; a close that stays unknown is never reverted either — the
 *    sentence says exactly that.
 */

import { describe, expect, it } from 'vitest';

import { listStages } from '../../src/stages/repo.ts';
import { EngineRefusalError } from '../../src/writer/client.ts';
import { readerSentences } from '../../src/writer/reasons.ts';
import { chapterAnswer, createHarness, type Harness } from './harness.ts';

const CHAPTER = 40;

function revisions(harness: Harness): Array<{ rev: number; kind: string }> {
  return harness.fixture.db
    .prepare('SELECT rev, cause_kind AS kind FROM revisions WHERE chapter = ? ORDER BY rev DESC')
    .all(CHAPTER) as Array<{ rev: number; kind: string }>;
}

function stagesOf(harness: Harness): string[] {
  return listStages(harness.fixture.db, CHAPTER).map((stage) => stage.stage);
}

function liveLease(harness: Harness): string {
  const row = harness.fixture.db
    .prepare('SELECT id FROM leases WHERE released_at IS NULL ORDER BY acquired_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  if (row === undefined) throw new Error('the fixture has no live lease');
  return row.id;
}

/** The close the writer asked for, applied engine-side: the step is closed, the push is out. */
function closeStepEngineSide(harness: Harness): void {
  harness.fixture.engine.done(liveLease(harness), {
    seams: [],
    model: harness.config.model,
    note: 'тест: закрытие прошло, ответ потерялся',
  });
}

const lost = (): EngineRefusalError =>
  new EngineRefusalError('ENGINE_UNREACHABLE', 'the engine did not answer', 0);

describe('a lost answer — the rows decide, never the missing response', () => {
  it('reads a lost `done` back: a closed step is the close, so nothing is taken back', async () => {
    const harness = await createHarness({ chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      harness.fixture.engine.enqueue({
        kind: 'operator',
        chapter: CHAPTER,
        intent: 'в главе 40 появляется документ о допуске',
      });
      const written = chapterAnswer('Глава сорок', 'новый');
      harness.script.push(written, 'HOLDS', 'HOLDS');
      let attempts = 0;
      harness.hooks.beforeCall = (name) => {
        if (name !== 'done') return;
        attempts += 1;
        if (attempts === 1) closeStepEngineSide(harness);
        throw lost();
      };

      const result = await harness.run({ lanes: ['fwd'] });

      expect(result.status).toBe('closed');
      expect(attempts).toBe(2);
      // The step is read, not guessed: the trace call is the pass's read of the closed step.
      expect(harness.engineCalls).toContain('step');
      // The close happened: the pass states the landing and the chapter keeps its text.
      expect(harness.fixture.readChapter(CHAPTER)).toContain('новый');
      expect(revisions(harness).map((row) => row.kind)).toEqual(['change', 'draft']);
      expect(harness.engineCalls).not.toContain('restore');
      expect(stagesOf(harness)).toContain('landed');
    } finally {
      await harness.close();
    }
  });

  it('leaves the text standing when the close stays unknown: a restore would argue with the push', async () => {
    const harness = await createHarness({ chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      harness.fixture.engine.enqueue({
        kind: 'operator',
        chapter: CHAPTER,
        intent: 'в главе 40 появляется документ о допуске',
      });
      harness.script.push(chapterAnswer('Глава сорок', 'новый'), 'HOLDS', 'HOLDS');
      harness.hooks.beforeCall = (name) => {
        // The engine is unreachable: neither `done` nor the read of the step answers.
        if (name !== 'done' && name !== 'step') return;
        throw lost();
      };

      const result = await harness.run({ lanes: ['fwd'] });

      expect(result.status).toBe('parked');
      // No restore: the close may have happened, and undoing it would contradict the reader's push.
      expect(harness.fixture.readChapter(CHAPTER)).toContain('новый');
      expect(harness.engineCalls).not.toContain('restore');
      expect(stagesOf(harness)).not.toContain('landed');
      expect(result.reason).toBe(readerSentences.closeUncertain);
      expect(harness.logs.join('\n')).toContain('закрытие не подтверждено');
    } finally {
      await harness.close();
    }
  });

  it('puts the text back when the read says the step is still open — the close is known missing', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      harness.fixture.engine.enqueue({
        kind: 'operator',
        chapter: CHAPTER,
        intent: 'в главе 40 появляется документ о допуске',
      });
      harness.script.push(chapterAnswer('Глава сорок', 'новый'), 'HOLDS', 'HOLDS');
      harness.hooks.beforeCall = (name) => {
        if (name !== 'done') return;
        throw lost();
      };

      const result = await harness.run({ lanes: ['fwd'] });

      expect(result.status).toBe('parked');
      // The step reads `open`: no close happened, so the invariant's undo is the honest answer.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisions(harness)[0]?.kind).toBe('restore');
      expect(result.reason).toBe(readerSentences.closeReverted);
      expect(stagesOf(harness)).not.toContain('landed');
    } finally {
      await harness.close();
    }
  });

  it('reads a lost `land` back: a chapter that already serves the text is this pass’s landing', async () => {
    const harness = await createHarness({ chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      harness.fixture.engine.enqueue({
        kind: 'operator',
        chapter: CHAPTER,
        intent: 'в главе 40 появляется документ о допуске',
      });
      const written = chapterAnswer('Глава сорок', 'новый');
      harness.script.push(written, 'HOLDS', 'HOLDS');
      harness.hooks.beforeCall = (name) => {
        if (name !== 'land') return;
        // The landing is applied and the answer is lost: the pass reads the chapter instead.
        harness.fixture.engine.land(liveLease(harness), { text: written });
        throw lost();
      };

      const result = await harness.run({ lanes: ['fwd'] });

      expect(result.status).toBe('closed');
      expect(harness.fixture.readChapter(CHAPTER)).toContain('новый');
      expect(revisions(harness).map((row) => row.kind)).toEqual(['change', 'draft']);
      expect(harness.logs.join('\n')).toContain('глава уже несёт этот текст');
      expect(stagesOf(harness)).toContain('landed');
    } finally {
      await harness.close();
    }
  });
});
