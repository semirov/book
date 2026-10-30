/**
 * The owner's two rules from the second real pass (chapter 40, 2026-10-28):
 *
 *  · «a failed auxiliary call must not escalate a step whose text already landed and passed the
 *    gates» — the chapter was written, published and printed, and a `land`/gate call that timed
 *    out parked the pass anyway;
 *  · «the note in the DB must never be a code word alone» — the reader saw
 *    «машина отказала: ENGINE_TIMEOUT: …» for an intervention that had, in fact, been written.
 *
 * So this file has two halves: the pure mapping from a code to the sentence a reader gets
 * (`reasons.ts`), and a pass driven through a real engine where the *auxiliary* things — the
 * stage emitter, the transcript, a gate dispatch — fail after the landing.
 */

import { describe, expect, it } from 'vitest';

import { EngineRefusalError, type EngineClient } from '../../src/writer/client.ts';
import { runPass, type PassDeps } from '../../src/writer/pass.ts';
import {
  PassRefusal,
  failureOf,
  isTransportFailure,
  readerFallbacks,
  readerReason,
  readerSentences,
} from '../../src/writer/reasons.ts';
import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 40;

/** A machine token no note may carry: `ENGINE_TIMEOUT`, `PROVIDER_HTTP_429`, `ANSWER_REFUSAL`. */
const CODE_TOKEN = /[A-Z]{2,}_[A-Z0-9_]+/u;

const noteOf = (harness: Harness, stepId: string): string => String(stepRow(harness.fixture, stepId)?.note ?? '');

const parkedLine = (harness: Harness): string => harness.logs.find((line) => line.includes('[writer] parked')) ?? '';

describe('readerReason — a sentence for the reader, the code for the log', () => {
  it('maps every code the pass can stop on to its one sentence', () => {
    expect(readerReason('PROVIDER_SHAPE', 'запасное')).toBe(readerSentences.shape);
    expect(readerReason('PROVIDER_TIMEOUT', 'запасное')).toBe(readerSentences.modelTimeout);
    expect(readerReason('PROVIDER_UNREACHABLE', 'запасное')).toBe(readerSentences.modelDown);
    expect(readerReason('PROVIDER_HTTP_429', 'запасное')).toBe(readerSentences.modelDown);
    expect(readerReason('ANSWER_TRUNCATED', 'запасное')).toBe(readerSentences.truncated);
    expect(readerReason('ANSWER_REFUSAL', 'запасное')).toBe(readerSentences.refusal);
    expect(readerReason('ANSWER_EMPTY', 'запасное')).toBe(readerSentences.answerRejected);
    expect(readerReason('ANSWER_TITLE', 'запасное')).toBe(readerSentences.answerRejected);
    expect(readerReason('ENGINE_TIMEOUT', 'запасное')).toBe(readerSentences.engineDown);
    expect(readerReason('ENGINE_UNREACHABLE', 'запасное')).toBe(readerSentences.engineDown);
  });

  it('splits one failure into the log’s detail and the reader’s code', () => {
    expect(failureOf(new PassRefusal('нет главы', 'LEASE_RELEASED'))).toEqual({
      code: 'LEASE_RELEASED',
      detail: 'нет главы',
    });
    expect(failureOf(new EngineRefusalError('ENGINE_TIMEOUT', 'the engine did not answer', 0))).toEqual({
      code: 'ENGINE_TIMEOUT',
      detail: 'машина отказала: ENGINE_TIMEOUT: the engine did not answer',
    });
    // A refusal with nothing to quote says only the code: there is no detail to print.
    expect(failureOf(new EngineRefusalError('ENGINE_REFUSED', '   ', 0)).detail).toBe('машина отказала: ENGINE_REFUSED');
    // Anything that is not an error at all still owes the log a sentence and carries no code.
    // BOOK-218: the log's sentence names the machine, never a reader's state word.
    expect(failureOf(new Error('boom'))).toEqual({ code: null, detail: 'сбой машины: Error' });
    expect(failureOf('boom')).toEqual({ code: null, detail: 'сбой машины' });
    expect(isTransportFailure({ code: 'ENGINE_UNREACHABLE', detail: '' })).toBe(true);
    expect(isTransportFailure({ code: 'PROVIDER_TIMEOUT', detail: '' })).toBe(false);
  });

  it('falls back to the caller’s sentence, and never returns a code word', () => {
    expect(readerReason('LEASE_RELEASED', readerFallbacks.stopped)).toBe(readerFallbacks.stopped);
    expect(readerReason(null, 'не удалось записать главу')).toBe('не удалось записать главу');
    // Every sentence is a sentence: bounded, no machine token, no colon-led code.
    for (const sentence of [...Object.values(readerSentences), ...Object.values(readerFallbacks)]) {
      expect(sentence.length).toBeLessThanOrEqual(200);
      expect(sentence).not.toMatch(CODE_TOKEN);
      // The one colon is the verdict's own — `не дошло: …` — never a code-led `ENGINE: …`.
      expect(sentence.match(/:/gu) ?? []).toHaveLength(1);
      expect(sentence.startsWith('не дошло:')).toBe(true);
    }
    // A verbose fallback is cut, not printed whole: a note is read on a page.
    expect(readerReason(null, 'а'.repeat(500)).length).toBe(200);
  });

  it('gives every BOOK-173 refusal a sentence, and never the code', () => {
    // The closed list of the ripple's refusals (BOOK-173 review, 8b): the engine's door, the
    // drainer's stops and the judge. A code that reaches a note is a bug, so the mapping is pinned.
    const codes = [
      'NOT_A_RIPPLE',
      'PLAN_MISSING',
      'NOT_PLANNED',
      'NEIGHBOUR_MISSING',
      'INVALID_CHAPTER',
      'WIDE_NEEDS_AUTHOR',
      'RIPPLE_REFUSED',
      'CLOSURE_UNSTABLE',
      'CLOSURE_DRIFT',
      'IRREVERSIBLE_LOST',
      'LANE_LOST',
      'JUDGE_VETO',
    ];
    for (const code of codes) {
      const sentence = readerReason(code, 'запасная фраза');
      expect(sentence).not.toBe('запасная фраза');
      expect(sentence).not.toMatch(CODE_TOKEN);
      expect(sentence).not.toContain(code);
      expect(sentence.length).toBeGreaterThan(10);
    }
  });

  it('never promises a queue: a parked pass is a stopped change (BOOK-219, audit B2/B5)', () => {
    for (const sentence of [...Object.values(readerSentences), ...Object.values(readerFallbacks)]) {
      // An escalated change is terminal (`rejected`); nothing retries it and the reader has no
      // lever — both phrases were the lie the audit named.
      expect(sentence).not.toContain('остаётся в очереди');
      expect(sentence).not.toContain('ждёт решения');
      // BOOK-218 — every stop says the edit was not rejected, and what to do next.
      expect(sentence).toContain('правка не отклонена');
      expect(sentence).toContain('нажмите «повторить»');
    }
  });
});

describe('runPass — a landed step survives its auxiliary calls', () => {
  it('closes when the stage emitter throws on every call', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const calls: string[] = [];
      // Every stage of the pass fails: the store is gone, and the pass must not care.
      const engine = new Proxy(harness.client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function') return value;
          const name = String(property);
          return (...args: unknown[]): unknown => {
            calls.push(name);
            if (name === 'stage') throw new Error('the stage store is gone');
            return (value as (...rest: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as EngineClient;
      const deps: PassDeps = {
        config: harness.config,
        bookRoot: harness.bookRoot,
        engine,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => harness.logs.push(line),
        chapter: CHAPTER,
      };
      const result = await runPass(deps);

      expect(result.status).toBe('closed');
      expect(calls).toContain('done');
      // No stage was stored — and that is a log line, not a parked pass.
      expect(harness.logs.some((line) => line.includes('stage queued not stored'))).toBe(true);
      expect(listStages(harness.fixture.db, CHAPTER)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('closes when the transcript cannot be stored, and says so in one line', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      // BOOK-187 AC7: the receipt is a row now — the store is what can go away, and it must not
      // turn a published chapter into a parked pass.
      const engine = new Proxy(harness.client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function') return value;
          if (property !== 'transcript') return (value as (...rest: unknown[]) => unknown).bind(target);
          return (): never => {
            throw new EngineRefusalError('ENGINE_TIMEOUT', 'the engine did not answer within 60000 ms', 0);
          };
        },
      }) as EngineClient;

      const result = await runPass({
        config: harness.config,
        bookRoot: harness.bookRoot,
        engine,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => harness.logs.push(line),
        chapter: CHAPTER,
      });

      expect(result.status).toBe('closed');
      expect(harness.logs).toContain('[writer] transcript not stored: ENGINE_TIMEOUT');
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('rewritten');
      // Nothing was invented: the failed store left the table as it was.
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM pass_transcripts').get()).toEqual({ n: 0 });
    } finally {
      await harness.close();
    }
  });

  it('parks a first write the gate never answered, and says the text is ours to retry', async () => {
    const harness = await createHarness();
    try {
      const changeId = harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS');
      let dispatches = 0;
      harness.hooks.beforeCall = (name) => {
        if (name !== 'nextGate') return;
        dispatches += 1;
        // The editor's dispatch answers; the consultant's — and the retry Fix 1 allows — do not.
        if (dispatches >= 2) {
          throw new EngineRefusalError('ENGINE_TIMEOUT', 'the engine did not answer within 60000 ms', 0);
        }
      };

      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      // BOOK-222: the first write is a **candidate**, so a gate that never answers serves nothing —
      // the chapter the reader has is the chapter he had, and the note says only what went wrong:
      // our check did not arrive. The close is still tried (it is what would publish the candidate)
      // and the engine refuses it, because the verdict the dead gate owed is not there.
      expect(harness.engineCalls).toContain('done');
      expect(result.code).toBe('ENGINE_TIMEOUT');
      expect(harness.engineCalls).toContain('escalate');
      expect(harness.engineCalls).not.toContain('restore');
      expect(harness.fixture.readChapter(CHAPTER)).toBeNull();
      expect(
        harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(CHAPTER),
      ).toEqual({ n: 0 });
      const note = noteOf(harness, result.stepId ?? '');
      expect(note).toBe(readerFallbacks.gate);
      expect(note).not.toMatch(CODE_TOKEN);
      expect(note.match(/:/gu) ?? []).toHaveLength(1);
      // The code and its detail are in the log, which is where an operator looks.
      expect(parkedLine(harness)).toContain('ENGINE_TIMEOUT');
      expect(parkedLine(harness)).toContain('did not answer within 60000 ms');
      // Nothing was published, so nothing entered a first edition: the premise is still queued for
      // the pass that answers for it — the filing is not judged, and not spent either.
      const change = harness.fixture.db
        .prepare('SELECT status, outcome FROM changes WHERE id = ?')
        .get(changeId);
      expect(change).toEqual({ status: 'pending', outcome: null });
    } finally {
      await harness.close();
    }
  });

  it('reports `closed` when `done` answers STEP_CLOSED: the step is closed either way', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      harness.hooks.beforeCall = (name) => {
        // The reaper got there first: the close the pass asks for has already happened.
        if (name === 'done') throw new EngineRefusalError('STEP_CLOSED', 'step stp_x is already closed', 409);
      };

      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('closed');
      expect(result.stepId).toBe(listStages(harness.fixture.db, CHAPTER)[0]?.passId);
      expect(harness.engineCalls).toContain('done');
      expect(harness.engineCalls).not.toContain('escalate');
    } finally {
      await harness.close();
    }
  });

  it('parks with a sentence when the close itself is refused after the gates answered', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      // Every verdict is in, and the engine still refuses the close: the pass says why, in words.
      harness.hooks.beforeCall = (name) => {
        if (name === 'done') throw new EngineRefusalError('RIGHTS_REQUIRED', 'право на текст не подтверждено', 409);
      };

      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      // BOOK-219: the sentence says what happened to the text — the close never confirmed it, so
      // the new revision stands without a close, and the filing waits for a person.
      expect(result.reason).toBe(readerSentences.closeStanding);
      expect(parkedLine(harness)).toContain('RIGHTS_REQUIRED');
      expect(listStages(harness.fixture.db, CHAPTER).at(-1)?.stage).toBe('refused');
    } finally {
      await harness.close();
    }
  });
});
