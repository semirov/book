/**
 * The pass's own price (`docs/writer-lane.md` §6): what `estimatePassUsd` assumes, and that its
 * arithmetic is the rate table's — the same `costUsd` the ledger charges with. A number that the
 * guard trusts must be pinned here, or "the estimate said it fits" is a claim nobody checked.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHAPTER_CHARS } from '@book/shared';

import { costUsd, loadPipeline } from '../../src/writer/pipeline.ts';
import { CHARS_PER_TOKEN, canonChars, estimatePassUsd } from '../../src/writer/estimate.ts';
import { buildWriterPrompt } from '../../src/writer/prompt.ts';
import { BOOK_ROOT, SITE_ROOT } from './harness.ts';

const pipeline = loadPipeline(join(SITE_ROOT, 'config', 'pipeline.json'));
const pricing = pipeline.pricing;

/** The hand arithmetic, written out: what the estimate must reproduce, call by call. */
function handWorked(promptChars: number, continueMax: number) {
  const promptTokens = Math.ceil(promptChars / 2.3);
  const gateTokens = Math.ceil((promptChars + CHAPTER_CHARS.target) / 2.3);
  const outPerWriting = Math.ceil((CHAPTER_CHARS.min * 1.15) / 2.3);
  const writingCalls = 1 + continueMax + 1;
  const gateCalls = 4;
  return {
    writingCalls,
    gateCalls,
    tokensIn: writingCalls * promptTokens + gateCalls * gateTokens,
    tokensOut: writingCalls * outPerWriting + gateCalls * 400,
  };
}

describe('estimatePassUsd — one pass, priced before it runs', () => {
  it('carries the measured characters-per-token constant, and the measurement is in the file', () => {
    expect(CHARS_PER_TOKEN).toBe(2.3);
    // The constant is measured, not assumed: the file states the measurement it came from.
    const source = readFileSync(join(SITE_ROOT, 'server', 'src', 'writer', 'estimate.ts'), 'utf8');
    expect(source).toContain('1 599');
    expect(source).toContain('686');
  });

  it('prices a built 10 547-character prompt with two continuations, call by call', () => {
    const estimate = estimatePassUsd({ pricing, promptChars: 10_547, continueMax: 2 });
    const hand = handWorked(10_547, 2);

    expect(estimate.assumptions).toMatchObject({
      charsPerToken: 2.3,
      promptChars: 10_547,
      continueMax: 2,
      writingCalls: hand.writingCalls,
      gateCalls: hand.gateCalls,
    });
    expect(estimate.tokensIn).toBe(hand.tokensIn);
    expect(estimate.tokensOut).toBe(hand.tokensOut);
    expect(estimate.calls).toBe(hand.writingCalls + hand.gateCalls);

    // The money is the pipeline's arithmetic, rounded up to the cent.
    const raw = costUsd(pricing, { in: hand.tokensIn, out: hand.tokensOut, cachedIn: 0 });
    expect(estimate.usd).toBe(Math.ceil(raw * 100) / 100);

    // And a hand-computed floor: the completion tokens alone at the pin, from the band the
    // estimate reads (`CHAPTER_CHARS.min`, 10 000 since BOOK-160) — never a second number.
    const outputOnly = (hand.tokensOut * pricing.output) / pricing.per;
    expect(outputOnly).toBeCloseTo(0.0428, 3);
    expect(estimate.usd).toBeGreaterThanOrEqual(outputOnly);
  });

  it('never prices an unbuilt pass below the same pass built from the real prompt', () => {
    const built = buildWriterPrompt({
      bookRoot: BOOK_ROOT,
      assignment: { chapter: 40, pass: 'draft', intent: null, interventionKind: null, premise: null, expectation: null },
    });
    const promptChars = built.system.length + built.user.length;
    const fromPrompt = estimatePassUsd({ pricing, promptChars, continueMax: 2 });
    const fromCanon = estimatePassUsd({ pricing, bookRoot: BOOK_ROOT, continueMax: 2 });

    expect(fromCanon.usd).toBeGreaterThanOrEqual(fromPrompt.usd);
    // The allowance is two full chapters: a written neighbour is at most `CHAPTER_CHARS.max`.
    expect(fromCanon.assumptions.promptChars).toBe(canonChars(BOOK_ROOT) + 2 * CHAPTER_CHARS.max);
    expect(fromCanon.assumptions.promptChars).toBeGreaterThan(promptChars);
  });

  it('rounds up to the cent, never down', () => {
    for (const promptChars of [1, 2_000, 10_547, 69_255, 120_000]) {
      const estimate = estimatePassUsd({ pricing, promptChars });
      const raw = costUsd(pricing, { in: estimate.tokensIn, out: estimate.tokensOut, cachedIn: 0 });
      expect(estimate.usd).toBeGreaterThanOrEqual(raw);
      expect(estimate.usd - raw).toBeLessThan(0.01);
      // Whole cents: a fraction left over would mean the rounding had gone missing.
      expect(Math.abs(estimate.usd * 100 - Math.round(estimate.usd * 100))).toBeLessThan(1e-6);
    }
  });

  it('refuses to estimate from nothing: no prompt and no book is not a price', () => {
    expect(() => estimatePassUsd({ pricing })).toThrow(/нет ни промпта, ни книги/u);
    expect(() => estimatePassUsd({ pricing, bookRoot: join(SITE_ROOT, '.data', 'no-such-book') })).toThrow(/оценка не собрана/u);
  });
});
