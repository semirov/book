/**
 * BOOK-145 — a refused answer names its check, and gets one retry that carries the reason.
 *
 * The owner's log said «ответ модели не прошёл проверку» and nothing else: a park without a
 * diagnosis. The gate's parser already knows the code; this pins that the lane prints it, that
 * the retry is asked, and that a second good answer closes the pass as usual.
 */

import { describe, expect, it } from 'vitest';

import { chapterAnswer, createHarness } from './harness.ts';

const CHAPTER = 40;

describe('a refused answer is a diagnosis, not a park', () => {
  it('retries a gate answer once, naming the check, and closes on the second answer', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = null;
      // The editor's first answer is not JSON at all: the parser refuses it.
      harness.script.push(chapterAnswer(), 'это не JSON, а проза', 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('closed');
      const refusal = harness.logs.find((line) => line.includes('ответ гейта editor отклонён'));
      expect(refusal).toBeDefined();
      // The check names itself: a code and a reason, in one line.
      expect(refusal).toContain('GATE_UNPARSED');
      // The retry is a real second ask of the model, not the same answer parsed twice.
      expect(harness.calls.length).toBe(4);
      // And the retry carried the reason back: the second gate prompt says why.
      const retry = harness.calls[2]?.messages.map((message) => message.content).join('\n') ?? '';
      expect(retry).toContain('Предыдущий ответ не разобран');
    } finally {
      await harness.close();
    }
  });

  it('marks a refusal of the work itself as the filing’s, so the queue moves on at once', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = null;
      // Both answers refuse the task: the premise is the filing, and it is what was refused.
      harness.script.push('Я не могу написать эту главу: это не моя задача.', 'Я не могу написать эту главу.');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      expect(result.filingRefused).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('parks with the reason when the retry is refused too', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = null;
      harness.script.push(chapterAnswer(), 'мусор', 'и снова мусор');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      expect(harness.logs.some((line) => line.includes('ответ гейта editor отклонён снова'))).toBe(true);
      // The note the reader sees is still a sentence; the code stayed in the log and the record.
      expect(result.reason).not.toContain('GATE_UNPARSED');
    } finally {
      await harness.close();
    }
  });
});
