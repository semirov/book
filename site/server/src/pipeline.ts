/**
 * The pipeline's model pin (ADR-038, BOOK-62).
 *
 * One file names the model that writes and gates the book, so "prod is Pro" is a fact a
 * reader of the log can check instead of a comment. `config.ts` calls `loadPipeline` at boot,
 * and a bad file stops both processes: a deployment that rolls back is cheaper than a
 * pipeline that runs on a model nobody named.
 *
 * The API model id is **derived**, never declared: `model` must be `<provider>/<apiModel>`, so
 * a second literal cannot drift from the first. There is no secret in this file, so every
 * message may name the path and the problem, and never a value that could be a key.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

/** `<provider>/<apiModel>` — the provider prefix is what makes the derivation sound. */
const MODEL_ID = /^([a-z0-9-]+)\/([a-z0-9.\-]+)$/u;

const pricingSchema = z.strictObject({
  currency: z.string().min(1),
  /** The unit the prices are quoted in: `per` tokens. */
  per: z.number().int().positive(),
  input: z.number().positive(),
  output: z.number().positive(),
  cacheRead: z.number().positive(),
  source: z.string().min(1),
  date: z.string().min(1),
});

/**
 * Strict on purpose: a typo (`modelId`, `inputPrice`) fails the boot instead of leaving a
 * field at a default. A default price would make a cost report lie quietly.
 */
const pipelineSchema = z
  .strictObject({
    provider: z.string().regex(/^[a-z0-9-]+$/u),
    model: z.string().regex(MODEL_ID),
    endpoint: z.string().url(),
    /**
     * The model's own output cap, sent with every request. The provider's default is small
     * enough that a reasoning model spends it on `reasoning_content` and returns empty content
     * with `finish_reason: "length"` — a 200 that says nothing (BOOK-62, measured 2026-10-27).
     */
    maxOutputTokens: z.number().int().positive(),
    pricing: pricingSchema,
  })
  .superRefine((pipeline, ctx) => {
    // The regex above guarantees exactly one `/`; the segment before it is the provider, and it
    // must be the declared one — otherwise the derived request id would name another model.
    const [stated] = pipeline.model.split('/');
    if (stated !== pipeline.provider) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: `model must be prefixed with the provider "${pipeline.provider}"`,
      });
    }
  });

export type Pipeline = z.infer<typeof pipelineSchema> & { apiModel: string };

/**
 * The request's model id: `<provider>/<apiModel>` asks the provider for `<apiModel>`.
 * `max_tokens` is the pinned output cap from the file, never a sampling override.
 */
export function apiModelOf(pipeline: Pick<Pipeline, 'provider' | 'model'>): string {
  return pipeline.model.slice(pipeline.provider.length + 1);
}

/** Read, parse and derive: the one reader of `config/pipeline.json`. */
export function loadPipeline(path: string): Pipeline {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`pipeline: cannot read the file at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`pipeline: invalid JSON at ${path}`);
  }
  const result = pipelineSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ');
    throw new Error(`pipeline: ${details} at ${path}`);
  }
  return { ...result.data, apiModel: apiModelOf(result.data) };
}
