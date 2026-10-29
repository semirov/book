/**
 * The pipeline pin as the writer lane reads it (BOOK-117, `docs/writer-lane.md` §5).
 *
 * The pin itself is ADR-038's (`server/src/pipeline.ts`, `site/config/pipeline.json`): the
 * provider, the model, the endpoint and the request's output cap. The **money** is not here:
 * BOOK-114's `cost/rates.ts` is the book's one price list, and this module only puts the
 * pinned model's rate next to the file's provenance so the lane's call sites read one shape.
 * One number, one table — a second copy of a price is how a cost line starts to lie.
 */

import { rateFor } from '../cost/rates.ts';
import {
  apiModelOf as apiModelOfCore,
  loadPipeline as loadPipelineCore,
  type Pipeline as PipelinePin,
} from '../pipeline.ts';

/**
 * One call's tokens. `estimated` (BOOK-219) says the numbers were **read off the text**, because
 * the provider answered with prose and no usable `usage` object: the charge is then at or above
 * the truth (see `provider.ts`), and every surface that reports it must say so.
 */
export type PipelineUsage = { in: number; out: number; cachedIn: number; estimated?: boolean };

/** One model's rates, USD per million tokens (BOOK-114's shape). */
export type PipelineRates = { input: number; output: number; cacheRead: number };

/** The pinned model's rates, with the file's unit and provenance around them. */
export type PipelinePricing = PipelineRates & {
  currency: string;
  per: number;
  source: string;
  date: string;
};

export type Pipeline = PipelinePin & { pricing: PipelinePricing };

/**
 * The pin, loaded by the core, plus the rate the book's table gives its model. A model the
 * table cannot price is a boot refusal: a pass must never run on a price nobody set.
 */
export function loadPipeline(path: string): Pipeline {
  const pin = loadPipelineCore(path);
  const rates = rateFor(pin.model);
  if (rates === null) throw new Error(`pipeline: no rate for ${pin.model} at ${path}`);
  return { ...pin, pricing: { ...pin.pricing, ...rates } };
}

/** The wire model id, derived from the pin by the core. */
export function apiModelOf(pipeline: Pipeline): string {
  return apiModelOfCore(pipeline);
}

/**
 * This pass's money, from the book's one rate table (BOOK-173 §5).
 *
 * The provider's `prompt_tokens` is hit + miss, so cached input stays **inside** `in` and has
 * to be split before billing: the cached part is charged at `cacheRead`, the rest at `input`.
 * With `cachedIn: 0` the arithmetic is exactly today's — a number that cannot go down hides
 * whether the cache-first layout works at all.
 */
export function costUsd(pricing: PipelinePricing, usage: PipelineUsage): number {
  const cachedIn = Math.max(0, Math.min(usage.cachedIn, usage.in));
  const fresh = usage.in - cachedIn;
  const usd =
    (fresh / pricing.per) * pricing.input +
    (cachedIn / pricing.per) * pricing.cacheRead +
    (usage.out / pricing.per) * pricing.output;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
