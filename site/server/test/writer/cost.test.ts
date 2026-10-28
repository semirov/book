/**
 * The writer's money (BOOK-173 §5): cache-aware, and two prices with one guard.
 *
 * `costUsd` splits the provider's `prompt_tokens` (hit + miss) before billing; with no cache it
 * must reproduce today's number exactly, because a number that changes silently is a number
 * nobody can compare. The estimate keeps the rewrite figure as the **guard** and adds the patch
 * figure for the money line only: an in-pass escalation can never cross an unforeseen cap.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { costUsd, loadPipeline } from '../../src/writer/pipeline.ts';
import { estimatePassUsd, PATCH_CHARS_PER_TOKEN, REASONING_ALLOWANCE } from '../../src/writer/estimate.ts';
import { SITE_ROOT } from './harness.ts';

const pricing = loadPipeline(join(SITE_ROOT, 'config', 'pipeline.json')).pricing;
const PER = pricing.per;

/** Today's arithmetic, written out: the number a pass was charged before BOOK-173. */
function uncached(inTokens: number, outTokens: number): number {
  return (inTokens / PER) * pricing.input + (outTokens / PER) * pricing.output;
}

describe('costUsd — the cache split', () => {
  it('is today’s number when nothing was cached', () => {
    for (const [inTokens, outTokens] of [
      [8_000, 9_000],
      [257_625, 38_187],
      [0, 0],
    ] as const) {
      const expected = Math.round(uncached(inTokens, outTokens) * 1_000_000) / 1_000_000;
      expect(costUsd(pricing, { in: inTokens, out: outTokens, cachedIn: 0 })).toBe(expected);
    }
    // The design's own case: 257 625 in / 38 187 out, no cache discount → $0.2456.
    expect(costUsd(pricing, { in: 257_625, out: 38_187, cachedIn: 0 })).toBeCloseTo(0.2456, 4);
  });

  it('charges the cached part at the cache rate and the rest at the input rate', () => {
    const cached = costUsd(pricing, { in: 10_000, out: 0, cachedIn: 4_000 });
    const expected = (6_000 / PER) * pricing.input + (4_000 / PER) * pricing.cacheRead;
    expect(cached).toBeCloseTo(expected, 9);
    // The design's 60 % hit: the same call drops from $0.2456 to about $0.1470.
    const sixtyPercent = costUsd(pricing, { in: 257_625, out: 38_187, cachedIn: 154_575 });
    expect(sixtyPercent).toBeCloseTo(0.147, 3);
    expect(sixtyPercent).toBeLessThan(0.2456);
  });

  it('never bills more cache than input, and never a negative share', () => {
    const over = costUsd(pricing, { in: 1_000, out: 0, cachedIn: 5_000 });
    const all = costUsd(pricing, { in: 1_000, out: 0, cachedIn: 1_000 });
    expect(over).toBe(all);
    expect(costUsd(pricing, { in: 1_000, out: 0, cachedIn: -50 })).toBeCloseTo((1_000 / PER) * pricing.input, 9);
  });

  it('rounds to six decimals, not to a nicer story', () => {
    const value = costUsd(pricing, { in: 7, out: 3, cachedIn: 2 });
    expect(value).toBe(Math.round(value * 1_000_000) / 1_000_000);
  });
});

describe('estimatePassUsd — two prices, one guard', () => {
  it('uses the rewrite figure as the guard, whatever the patch figure says', () => {
    const base = estimatePassUsd({ pricing, promptChars: 20_000, continueMax: 1, mode: 'patch' });
    expect(base.usd).toBe(base.usdRewrite);
    const cheapPatch = estimatePassUsd({ pricing, promptChars: 20_000, continueMax: 1, mode: 'patch', reasoningAllowance: 0 });
    expect(cheapPatch.usdPatch).toBeLessThan(base.usdPatch);
    expect(cheapPatch.usd).toBe(base.usd);
    expect(cheapPatch.usdRewrite).toBe(base.usdRewrite);
  });

  it('prices the patch from the real prompt, the assumed edits and the reasoning allowance', () => {
    const promptChars = 20_000;
    const estimate = estimatePassUsd({ pricing, promptChars, patchEdits: 3, patchNewChars: 200, reasoningAllowance: 5_000 });
    const patchIn = Math.ceil(promptChars / PATCH_CHARS_PER_TOKEN);
    const patchOut = Math.ceil((3 * 200) / PATCH_CHARS_PER_TOKEN) + 5_000;
    const raw = costUsd(pricing, { in: patchIn, out: patchOut, cachedIn: 0 });
    expect(estimate.usdPatch).toBeCloseTo(raw, 4);
    expect(estimate.assumptions.patchTokensIn).toBe(patchIn);
    expect(estimate.assumptions.patchTokensOut).toBe(patchOut);
    expect(estimate.assumptions.reasoningAllowance).toBe(5_000);
    expect(REASONING_ALLOWANCE).toBe(8_000);
  });

  it('carries the mode it was asked about, and null before the assignment is known', () => {
    expect(estimatePassUsd({ pricing, promptChars: 1_000, mode: 'patch' }).mode).toBe('patch');
    expect(estimatePassUsd({ pricing, promptChars: 1_000, mode: 'rewrite' }).mode).toBe('rewrite');
    expect(estimatePassUsd({ pricing, promptChars: 1_000 }).mode).toBeNull();
  });

  it('always estimates the patch below the rewrite for a chapter-sized prompt', () => {
    for (const promptChars of [10_000, 40_000, 70_000]) {
      const estimate = estimatePassUsd({ pricing, promptChars, continueMax: 2 });
      expect(estimate.usdPatch, String(promptChars)).toBeLessThan(estimate.usdRewrite);
    }
  });
});
