/**
 * What a parked pass says about itself, end to end (`docs/writer-lane.md` §1, §5–§6).
 *
 * The first real production pass parked on `PROVIDER_SHAPE` after its revision landed, and the
 * owner's premise was dropped as if the writer had refused it. These are the two causes a park
 * now carries — `failed` for a broken call, `refused` only for the model's own refusal — plus the
 * gate's own budget, which is a thinking call's and not the writing call's.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PassDeps } from '../../src/writer/pass.ts';
import { runPass } from '../../src/writer/pass.ts';
import { ProviderError } from '../../src/writer/provider.ts';
import { readerSentences } from '../../src/writer/reasons.ts';
import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 65;

const changeRow = (harness: Harness, id: string): Record<string, unknown> | undefined =>
  harness.fixture.db.prepare('SELECT status, outcome, reason FROM changes WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;

describe('a parked pass tells a broken call from a refusal', () => {
  it('parks a failed gate call as `failed`, and the premise of the written chapter stays applied', async () => {
    const harness = await createHarness();
    try {
      const changeId = harness.premised(CHAPTER, 'в главе 65 появляется документ о допуске');
      harness.script.push(chapterAnswer());
      const answered = harness.provider;
      let calls = 0;
      // The gate's re-ask is the call that dies: the revision is on disk and landed by then.
      const deps: PassDeps = {
        config: harness.config,
        bookRoot: harness.bookRoot,
        dataDir: harness.dataDir,
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
      expect(result.reason).toContain('PROVIDER_SHAPE');
      // The chapter the broken pass wrote is the first edition the premise entered.
      expect(existsSync(join(harness.bookRoot, 'manuscript', 'ch65.md'))).toBe(true);
      expect(changeRow(harness, changeId)).toEqual({
        status: 'done',
        outcome: 'applied',
        reason: 'вошло в первую редакцию главы 65',
      });
      // The step is still an escalation — the pass broke — and one stage carries the sentence.
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('escalated');
      expect(listStages(harness.fixture.db, CHAPTER).at(-1)?.stage).toBe('refused');
    } finally {
      await harness.close();
    }
  });

  it('parks the model’s own refusal as `refused`, and the premise is dropped with that note', async () => {
    const harness = await createHarness();
    try {
      const changeId = harness.premised(CHAPTER, 'в главе 65 появляется документ о допуске');
      harness.script.push('Извините, я не могу написать эту главу.', 'Извините, я не могу.');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      expect(result.reason).toContain('ANSWER_REFUSAL');
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
      harness.premised(CHAPTER, 'в главе 65 появляется документ о допуске');
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
