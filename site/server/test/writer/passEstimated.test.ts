/**
 * BOOK-219 — the two ways a pass ends when the provider says less than the money needs: an
 * estimated close (a good answer with no `usage`) and the way back for a pass that published.
 *
 * BOOK-222 moved the ordinary case out of the second story: a pass lands a **candidate**, so an
 * exit without `done` serves nothing and there is nothing to put back (the served chapter and its
 * revision are untouched). The way back is still the net for an engine from **before** BOOK-222 —
 * one that publishes at `land` — and those cells say so out loud (`publishingLand`).
 *
 * Its own file because `pass.test.ts` is at the `arch` bound, and because these cases are one
 * story: the prod pass that parked over a live revision, and the spend it never recorded.
 */

import { describe, expect, it } from 'vitest';

import { filingStatus, type FilingChange } from '../../src/comments/filingState.ts';
import { EngineRefusalError, type EngineClient } from '../../src/writer/client.ts';
import { runPass, type PassResult } from '../../src/writer/pass.ts';
import { ProviderError } from '../../src/writer/provider.ts';
import { readerFallbacks, readerSentences } from '../../src/writer/reasons.ts';
import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

/**
 * The seam these tests prove is the close and the way back, so they write a whole chapter:
 * `WRITER_MODE_DEFAULT=rewrite` is the owner's switch, and the patch default has its own
 * files (`patchPass.test.ts`, `noOpPass.test.ts`).
 */
const REWRITE = { env: { WRITER_MODE_DEFAULT: 'rewrite' } };

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

/**
 * An engine from **before** BOOK-222: it does not know `provisional` and publishes at `land`.
 * That build is the one case in which a pass still has a served text of its own to take back, and
 * `putBack` is the safety net for it — so the way back's own branches are proved here, on that
 * engine, rather than dropped from the suite with the model that made them rare.
 */
function publishingLand(engine: EngineClient): EngineClient {
  return new Proxy(engine, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (String(property) !== 'land') return (value as (...rest: unknown[]) => unknown).bind(target);
      return (leaseId: string, input: { provisional?: boolean } = {}) =>
        (value as (...rest: unknown[]) => unknown).call(target, leaseId, { ...input, provisional: false });
    },
  }) as EngineClient;
}

describe('runPass — BOOK-219: an estimated close and the compensating revert', () => {
  it('closes when the gates answer without usage, and the ledger says the money is an estimate', async () => {
    const harness = await createHarness(REWRITE);
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

  it('leaves the served chapter and its revision untouched when the gate dies after the candidate, and parks saying so', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      const result = await deadGate(harness);
      expect(result.status).toBe('parked');
      const stepId = result.stepId ?? '';
      // BOOK-222: the pass's text was a **candidate** — the gate's death served nothing, so the
      // chapter is the text it had, at the revision it had, and there is nothing to put back.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      const revisions = revisionsOf(harness, CHAPTER);
      expect(revisions.map((row) => row.rev)).toEqual([1]);
      expect(revisions.map((row) => row.kind)).toEqual(['draft']);
      // No way back is asked for, and no line of the log claims one (the log is where `putBack`
      // says what it did — a restore or its refusal would carry the word).
      expect(harness.logs.join('\n')).not.toContain('откат');
      // The candidate dies with the step; the note is ours, and never the machine's detail.
      expect(stepRow(harness.fixture, stepId)?.outcome).toBe('escalated');
      expect(stepRow(harness.fixture, stepId)?.candidate_sha).toBeNull();
      expect(result.code).toBe('PROVIDER_SHAPE');
      expect(result.reason).toBe(readerFallbacks.gate);
      expect(stepRow(harness.fixture, stepId)?.note).toBe(readerFallbacks.gate);
      const change = harness.fixture.db
        .prepare('SELECT id, status FROM changes WHERE chapter = ? AND premise = 0')
        .get(CHAPTER) as { id: string; status: string };
      // BOOK-219: a stopped pass ends the change `void · dropped`, never `escalated`.
      expect(change.status).toBe('void');
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
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
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
    // An engine from before BOOK-222 still publishes at `land`: that is the one case with a text
    // of ours to take back, and the way back's own failure is what this cell proves.
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      const result = await deadGate(harness, (engine) => refusing('restore')(publishingLand(engine)));

      expect(result.status).toBe('parked');
      // The text was published (this engine knows no candidate) and the writer cannot prove its
      // own way back, so the note says exactly that; the engine's own refusal is what returns the
      // text, as it always did — one restore revision, and no `новый` in the chapter.
      expect(harness.fixture.readChapter(CHAPTER)).not.toContain('новый');
      expect(revisionsOf(harness, CHAPTER)[0]?.kind).toBe('restore');
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
    // The old engine again: a published landing is the only text a way back may be refused for.
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      const wrong = (engine: EngineClient): EngineClient =>
        new Proxy(publishingLand(engine), {
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
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      const result = await deadGate(harness, (engine) => refusing('reconcile')(publishingLand(engine)));

      expect(result.status).toBe('parked');
      expect(result.reason).toBe(readerSentences.reverted);
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(harness.logs.join('\n')).toContain('сверка отката не отмечена');
    } finally {
      await harness.close();
    }
  });

  it('leaves a resumed step’s re-landing unpublished: the served chapter and its revision are untouched', async () => {
    const harness = await createHarness(REWRITE);
    try {
      // A previous run landed this step's text and died at the gate; the row is open, `landed`.
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      const assignment = harness.assignment(CHAPTER);
      harness.fixture.engine.start(assignment.leaseId);
      harness.fixture.writeChapter(CHAPTER, chapterAnswer('Глава сорок', 'первый прогон'));
      harness.fixture.engine.land(assignment.leaseId);
      const base = harness.fixture.readChapter(CHAPTER);
      const baseRev = revisionsOf(harness, CHAPTER)[0]?.rev;

      // The gate asks for a revision, so this run re-lands — as a candidate, like any landing.
      harness.script.push(
        'GAP\nblocker · глава 40, «служебный абзац» · повтор вместо прозы · переписать абзац',
        chapterAnswer('Глава сорок', 'правка'),
        'HOLDS',
        'HOLDS',
      );
      harness.hooks.beforeCall = (name) => {
        if (name !== 'done') return;
        throw new EngineRefusalError('VERDICTS_REQUIRED', 'the step has no verdicts', 409);
      };

      const result = await harness.run({ lanes: ['fwd'] });

      expect(result.status).toBe('parked');
      // BOOK-222: a resumed pass holds its own text as a candidate too, so a refused close serves
      // nothing: the chapter still reads the revision the resumed step stood at, and no restore —
      // the site's own revision and the pass's candidate cannot be confused.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(base);
      expect(revisionsOf(harness, CHAPTER).map((row) => row.rev)).toEqual([baseRev]);
      expect(harness.engineCalls).not.toContain('restore');
      // The candidate was dropped with the step, and the earlier landing is what the step served.
      const step = stepRow(harness.fixture, result.stepId ?? '');
      expect(step?.candidate_sha).toBeNull();
      expect(step?.candidate_text).toBeNull();
      expect(step?.landed_sha).not.toBeNull();
      expect(result.reason).toBe(readerSentences.closeStanding);
    } finally {
      await harness.close();
    }
  });

  it('does not undo a resumed step’s text: it is not this run’s landing', async () => {
    const harness = await createHarness(REWRITE);
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
      expect(harness.logs.join('\n')).toContain('нечего возвращать: этот проход ничего не опубликовал');
      // And the reader is still not told the queue is the whole story: the text stands, and the
      // close never confirmed it.
      expect(result.reason).toBe(readerSentences.closeStanding);
    } finally {
      await harness.close();
    }
  });
});
