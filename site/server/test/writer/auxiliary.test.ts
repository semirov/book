/**
 * The owner's two rules from the second real pass (chapter 40, 2026-10-28):
 *
 *  · «a failed auxiliary call must not escalate a step whose text already landed and passed the
 *    gates» — the chapter was written, published and printed, and a `land`/gate call that timed
 *    out parked the pass anyway;
 *  · «the note in the DB must never be a code word alone» — the reader saw
 *    «движок отказал: ENGINE_TIMEOUT: …» for an intervention that had, in fact, been written.
 *
 * So this file has two halves: the pure mapping from a code to the sentence a reader gets
 * (`reasons.ts`), and a pass driven through a real engine where the *auxiliary* things — the
 * stage emitter, the transcript, a gate dispatch — fail after the landing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
      detail: 'движок отказал: ENGINE_TIMEOUT: the engine did not answer',
    });
    // A refusal with nothing to quote says only the code: there is no detail to print.
    expect(failureOf(new EngineRefusalError('ENGINE_REFUSED', '   ', 0)).detail).toBe('движок отказал: ENGINE_REFUSED');
    // Anything that is not an error at all still owes the log a sentence and carries no code.
    expect(failureOf(new Error('boom'))).toEqual({ code: null, detail: 'сбой прохода: Error' });
    expect(failureOf('boom')).toEqual({ code: null, detail: 'сбой прохода' });
    expect(isTransportFailure({ code: 'ENGINE_UNREACHABLE', detail: '' })).toBe(true);
    expect(isTransportFailure({ code: 'PROVIDER_TIMEOUT', detail: '' })).toBe(false);
  });

  it('falls back to the caller’s sentence, and never returns a code word', () => {
    expect(readerReason('LEASE_RELEASED', 'проход остановлен — заявка остаётся в очереди')).toContain('проход остановлен');
    expect(readerReason(null, 'не удалось записать главу')).toBe('не удалось записать главу');
    // Every sentence is a sentence: bounded, no machine token, no colon-led code.
    for (const sentence of [...Object.values(readerSentences), ...Object.values(readerFallbacks)]) {
      expect(sentence.length).toBeLessThanOrEqual(200);
      expect(sentence).not.toMatch(CODE_TOKEN);
      expect(sentence).not.toContain(':');
    }
    // A verbose fallback is cut, not printed whole: a note is read on a page.
    expect(readerReason(null, 'а'.repeat(500)).length).toBe(200);
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
        dataDir: harness.dataDir,
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

  it('closes when the transcript cannot be written', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      // `writer/transcripts` is a file, so the directory cannot be made: a full disk, in one line.
      mkdirSync(join(harness.dataDir, 'writer'), { recursive: true });
      writeFileSync(join(harness.dataDir, 'writer', 'transcripts'), 'not a directory', 'utf8');

      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('closed');
      expect(harness.logs).toContain('[writer] transcript not written');
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('rewritten');
    } finally {
      await harness.close();
    }
  });

  it('parks a landed step only because the engine refuses to close it, and says so in words', async () => {
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
      // The landed step was offered for closing before anything was escalated.
      expect(harness.engineCalls).toContain('done');
      expect(harness.engineCalls).toContain('escalate');
      const note = noteOf(harness, result.stepId ?? '');
      expect(note).toBe(readerSentences.engineDown);
      expect(note).not.toMatch(CODE_TOKEN);
      expect(note).not.toContain(':');
      // The code and its detail are in the log, which is where an operator looks.
      expect(parkedLine(harness)).toContain('ENGINE_TIMEOUT');
      expect(parkedLine(harness)).toContain('did not answer within 60000 ms');
      // The reader's intervention was written into the book, so it is applied, not dropped.
      const change = harness.fixture.db
        .prepare('SELECT status, outcome FROM changes WHERE id = ?')
        .get(changeId);
      expect(change).toEqual({ status: 'done', outcome: 'applied' });
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
});
