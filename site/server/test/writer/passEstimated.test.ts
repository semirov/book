/**
 * BOOK-219 — the two ways a pass ends when the provider says less than the money needs: an
 * estimated close (a good answer with no `usage`) and the compensating revert (a gate that never
 * answered over text the pass had already published).
 *
 * Its own file because `pass.test.ts` is at the `arch` bound, and because these cases are one
 * story: the prod pass that parked over a live revision, and the spend it never recorded.
 */

import { describe, expect, it } from 'vitest';

import { filingStatus, type FilingChange } from '../../src/comments/filingState.ts';
import { EngineRefusalError, type EngineClient } from '../../src/writer/client.ts';
import { runPass, type PassResult } from '../../src/writer/pass.ts';
import { ProviderError } from '../../src/writer/provider.ts';
import { readerSentences } from '../../src/writer/reasons.ts';
import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 40;

const spendRow = (harness: Harness, stepId: string): Record<string, unknown> | undefined =>
  harness.fixture.db.prepare('SELECT * FROM pass_spend WHERE pass_id = ?').get(stepId) as Record<string, unknown> | undefined;

/** The filing's derived state, from the change the pass wrote (BOOK-136). */
const filingStateOf = (harness: Harness, changeId: string): string => {
  const change = harness.fixture.db
    .prepare('SELECT id, seq, premise, status, outcome, reason, chapter FROM changes WHERE id = ?')
    .get(changeId) as FilingChange | undefined;
  return String(filingStatus(change, 'accepted'));
};

/** The revisions of one chapter, newest first. */
const revisionsOf = (harness: Harness, chapter: number): Array<{ rev: number; kind: string }> =>
  harness.fixture.db
    .prepare('SELECT rev, cause_kind AS kind FROM revisions WHERE chapter = ? ORDER BY rev DESC')
    .all(chapter) as Array<{ rev: number; kind: string }>;

/**
 * A pass on a **written** chapter (so there is a revision to come back to) whose gate dies after
 * the landing. `decorate` is where a test breaks one door on top: the restore, or the reconcile.
 */
async function deadGate(
  harness: Harness,
  decorate: (engine: EngineClient) => EngineClient = (engine) => engine,
): Promise<PassResult> {
  harness.fixture.engine.enqueue({ kind: 'operator', chapter: CHAPTER, intent: 'в главе 40 появляется документ о допуске' });
  harness.script.push(chapterAnswer('Глава сорок', 'новый'));
  const answered = harness.provider;
  let calls = 0;
  return await runPass({
    config: harness.config,
    bookRoot: harness.bookRoot,
    engine: decorate(harness.client),
    now: () => harness.fixture.clock.now(),
    log: (line) => harness.logs.push(line),
    provider: async (request) => {
      calls += 1;
      // The draft lands; every gate call after it dies exactly as the prod pass did.
      if (calls > 1) throw new ProviderError('PROVIDER_SHAPE', 2);
      return answered(request);
    },
  });
}

/** One method answers a refusal, everything else is the real client. */
function refusing(method: 'restore' | 'reconcile'): (engine: EngineClient) => EngineClient {
  return (engine) =>
    new Proxy(engine, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (String(property) !== method) return (value as (...rest: unknown[]) => unknown).bind(target);
        return () => {
          throw new EngineRefusalError('ENGINE_TIMEOUT', 'the engine did not answer within 60000 ms', 0);
        };
      },
    }) as EngineClient;
}

describe('runPass — BOOK-219: an estimated close and the compensating revert', () => {
  it('closes when the gates answer without usage, and the ledger says the money is an estimate', async () => {
    const harness = await createHarness();
    try {
      const changeId = harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      // The draft is measured; every gate answer arrives with prose and no usage at all.
      harness.script.push(chapterAnswer(), { text: 'HOLDS', usage: { estimated: true } }, { text: 'HOLDS', usage: { estimated: true } });

      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('closed');
      const stepId = result.stepId ?? '';

      // AC4: the ordinary close works — one revision, `done`, the filing applied.
      expect(revisionsOf(harness, CHAPTER)).toHaveLength(1);
      expect(stepRow(harness.fixture, stepId)?.outcome).toBe('rewritten');
      expect(harness.fixture.db.prepare('SELECT status, outcome FROM changes WHERE id = ?').get(changeId)).toEqual({
        status: 'done',
        outcome: 'applied',
      });
      expect(filingStateOf(harness, changeId)).toBe('applied');

      // AC2: priced, and named as an estimate — never `priced = 0`, never zero dollars.
      const spend = spendRow(harness, stepId);
      expect(spend).toMatchObject({ priced: 1, provenance: 'pipeline-estimated' });
      expect(Number(spend?.usd)).toBeGreaterThan(0);
      // The stage prints the number it has, with the mark that says how it was read.
      const landed = listStages(harness.fixture.db, CHAPTER).at(-1);
      expect(landed?.stage).toBe('landed');
      expect(landed?.summary).toContain('≈$');
    } finally {
      await harness.close();
    }
  });

  it('puts the chapter back when the gate dies after the landing, and parks saying so', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      const result = await deadGate(harness);
      expect(result.status).toBe('parked');
      const stepId = result.stepId ?? '';
      // The text is the pre-pass text again, and the way back is a revision of its own.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      const revisions = revisionsOf(harness, CHAPTER);
      // Base 1, the pass's landing 2, and the restore that put the base back as revision 3.
      expect(revisions.map((row) => row.rev)).toEqual([3, 2, 1]);
      expect(revisions[0]?.kind).toBe('restore');
      // The reader is told the text went back, and the filing is not applied.
      expect(result.reason).toBe(readerSentences.reverted);
      expect(stepRow(harness.fixture, stepId)?.note).toBe(readerSentences.reverted);
      const change = harness.fixture.db
        .prepare('SELECT id, status FROM changes WHERE chapter = ? AND premise = 0')
        .get(CHAPTER) as { id: string; status: string };
      expect(change.status).toBe('escalated');
      expect(filingStateOf(harness, change.id)).not.toBe('applied');
      // No `landed` stage: the pass did not leave a publication behind.
      expect(listStages(harness.fixture.db, CHAPTER).some((stage) => stage.stage === 'landed')).toBe(false);
      expect(listStages(harness.fixture.db, CHAPTER).at(-1)?.stage).toBe('refused');
      // The code stays in the log, never in the note (the owner's rule).
      expect(harness.logs.join('\n')).toContain('PROVIDER_SHAPE');
    } finally {
      await harness.close();
    }
  });

  it('reports the prompt of a failed call as money: a park after a paid request is not zero', async () => {
    const harness = await createHarness({ chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      const result = await deadGate(harness);

      expect(result.status).toBe('parked');
      const ledger = spendRow(harness, result.stepId ?? '');
      // The draft's measured tokens, plus the estimated prompt of the two calls that threw.
      expect(Number(ledger?.usd)).toBeGreaterThan(0);
      expect(Number(ledger?.tokens_in)).toBeGreaterThan(1_000);
      expect(ledger).toMatchObject({ priced: 1, provenance: 'pipeline-estimated' });
    } finally {
      await harness.close();
    }
  });

  it('says the text stands unverified when the way back itself fails, and names the revision', async () => {
    const harness = await createHarness({ chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      const result = await deadGate(harness, refusing('restore'));

      expect(result.status).toBe('parked');
      // The chapter still carries the pass's landing — nobody put it back — and the note says so.
      expect(harness.fixture.readChapter(CHAPTER)).toContain('новый');
      expect(result.reason).toBe(readerSentences.unverified);
      expect(stepRow(harness.fixture, result.stepId ?? '')?.note).toBe(readerSentences.unverified);
      // The revision it stands at is in the detail (the log and the transcript), never the note.
      const detail = harness.logs.filter((line) => line.includes('[writer] parked')).join('\n');
      expect(detail).toContain('откат не выполнен');
      expect(detail).toContain('текст стоит на ревизии 2');
      expect(stepRow(harness.fixture, result.stepId ?? '')?.note).not.toContain('ревизи');
    } finally {
      await harness.close();
    }
  });

  it('refuses a way back that returned another revision: the text is not proved, so it stands', async () => {
    const harness = await createHarness({ chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      const wrong = (engine: EngineClient): EngineClient =>
        new Proxy(engine, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;
            if (typeof value !== 'function') return value;
            if (String(property) !== 'restore') return (value as (...rest: unknown[]) => unknown).bind(target);
            // A restore that answers with the wrong text: the sha is not the pre-pass one.
            return async (_chapter: number, rev?: number): Promise<unknown> => ({
              rev: (rev ?? 0) + 1,
              sha: 'f'.repeat(64),
              previousRev: rev ?? 0,
            });
          },
        }) as EngineClient;
      const result = await deadGate(harness, wrong);

      expect(result.status).toBe('parked');
      expect(result.reason).toBe(readerSentences.unverified);
      expect(harness.logs.filter((line) => line.includes('[writer] parked')).join('\n')).toContain('откат вернул не ту редакцию');
    } finally {
      await harness.close();
    }
  });

  it('keeps the revert when only the reconcile mark is refused: the text is back either way', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      const result = await deadGate(harness, refusing('reconcile'));

      expect(result.status).toBe('parked');
      expect(result.reason).toBe(readerSentences.reverted);
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(harness.logs.join('\n')).toContain('сверка отката не отмечена');
    } finally {
      await harness.close();
    }
  });

  it('does not undo a resumed step’s text: it is not this run’s landing', async () => {
    const harness = await createHarness();
    try {
      // A previous run landed this step's text and died at the gate; the row is open, `landed`.
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      const assignment = harness.assignment(CHAPTER);
      harness.fixture.engine.start(assignment.leaseId);
      harness.fixture.writeChapter(CHAPTER, chapterAnswer());
      harness.fixture.engine.land(assignment.leaseId);
      const landed = harness.fixture.readChapter(CHAPTER);

      const result = await harness.run({ lanes: ['fwd'] });

      expect(result.status).toBe('parked');
      // The text is where the earlier landing put it: no restore, no second revision.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(landed);
      expect(revisionsOf(harness, CHAPTER).map((row) => row.kind)).toEqual(['draft']);
      expect(harness.engineCalls).not.toContain('restore');
      expect(harness.logs.join('\n')).toContain('откат не нужен');
      // And the reader is still not told the queue is the whole story: the text stands, and the
      // close never confirmed it.
      expect(result.reason).toBe(readerSentences.closeStanding);
    } finally {
      await harness.close();
    }
  });
});
