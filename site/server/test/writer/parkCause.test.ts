/**
 * What a parked pass says about itself, end to end (`docs/writer-lane.md` §1, §5–§6).
 *
 * The first real production pass parked on `PROVIDER_SHAPE` after its revision landed, and the
 * owner's premise was dropped as if the writer had refused it. These are the two causes a park
 * now carries — `failed` for a broken call, `refused` only for the model's own refusal — plus the
 * gate's own budget, which is a thinking call's and not the writing call's.
 *
 * BOOK-219 shares this scenario: a first write cannot be put back, so the park has to say the
 * text stands unverified (`readerSentences.unverified`) instead of claiming a queue place — a
 * parked pass escalates the change, and an escalated change is terminal.
 *
 * BOOK-222 moved the first sentence of that story: the first write is a **candidate** now, so a
 * broken pass publishes nothing at all — the park says our check did not arrive, and the premise
 * stays queued for the pass that answers for it. The `refused` cause (the model's own no) is
 * unchanged: it is a refusal of the filing and ends it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PassDeps } from '../../src/writer/pass.ts';
import { runPass } from '../../src/writer/pass.ts';
import { ProviderError } from '../../src/writer/provider.ts';
import { readerFallbacks, readerSentences } from '../../src/writer/reasons.ts';
import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 40;

const changeRow = (harness: Harness, id: string): Record<string, unknown> | undefined =>
  harness.fixture.db.prepare('SELECT status, outcome, reason FROM changes WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;

describe('a parked pass tells a broken call from a refusal', () => {
  it('parks a failed gate call as `failed`, and leaves the first write unpublished', async () => {
    const harness = await createHarness();
    try {
      const changeId = harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer());
      const answered = harness.provider;
      let calls = 0;
      // The gate's re-ask is the call that dies: the candidate is on the step by then.
      const deps: PassDeps = {
        config: harness.config,
        bookRoot: harness.bookRoot,
        engine: harness.client,
        now: () => harness.fixture.clock.now(),
        log: (line) => harness.logs.push(line),
        chapter: CHAPTER,
        provider: async (request) => {
          calls += 1;
          if (calls > 1) throw new ProviderError('PROVIDER_SHAPE', 1);
          return answered(request);
        },
      };
      const result = await runPass(deps);

      expect(result.status).toBe('parked');
      // BOOK-222: the text the broken pass wrote was a **candidate** — nothing was served, so the
      // sentence says our check did not arrive, never that a text stands in the book.
      expect(result.reason).toBe(readerFallbacks.gate);
      expect(harness.logs.some((line) => line.includes('PROVIDER_SHAPE'))).toBe(true);
      // The chapter the broken pass wrote never entered the book: no rows, no revision.
      expect(harness.fixture.readChapter(CHAPTER)).toBeNull();
      expect(
        harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(CHAPTER),
      ).toEqual({ n: 0 });
      expect(existsSync(join(harness.bookRoot, 'manuscript'))).toBe(false);
      // The premise is still queued: nothing was published, so no first edition took it.
      expect(changeRow(harness, changeId)).toEqual({ status: 'pending', reason: null, outcome: null });
      // The step is still an escalation — the pass broke — and one stage carries the sentence.
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('escalated');
      expect(stepRow(harness.fixture, result.stepId ?? '')?.candidate_sha).toBeNull();
      expect(listStages(harness.fixture.db, CHAPTER).at(-1)?.stage).toBe('refused');
    } finally {
      await harness.close();
    }
  });

  it('parks the model’s own refusal as `refused`, and the premise is dropped with that note', async () => {
    const harness = await createHarness();
    try {
      const changeId = harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push('Извините, я не могу написать эту главу.', 'Извините, я не могу.');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      expect(result.reason).toBe(readerSentences.refusal);
      const row = changeRow(harness, changeId);
      expect(row).toMatchObject({ status: 'void', outcome: 'dropped' });
      // The reader reads a sentence; the code it came from is in the log and the transcript.
      expect(String(row?.reason)).toBe(readerSentences.refusal);
      expect(harness.logs.some((line) => line.includes('parked ANSWER_REFUSAL'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('asks a gate for the gate budget and the writer for the writing budget', async () => {
    const harness = await createHarness({ env: { WRITER_MAX_TOKENS_PER_CALL: '8000', WRITER_GATE_TOKENS: '16000' } });
    try {
      harness.premised(CHAPTER, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('closed');
      // The draft, then the two gates: a verdict is a thinking call, not a short one.
      expect(harness.calls.map((call) => call.maxTokens)).toEqual([8_000, 16_000, 16_000]);
      expect(harness.config.maxTokensPerPass).toBe(200_000);
    } finally {
      await harness.close();
    }
  });
});
