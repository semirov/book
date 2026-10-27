/**
 * The lane's own reader of `site/config/pipeline.json` (ADR-038 §4).
 *
 * It does not import the server build: the lane is plain `.mjs`, outside every gate, and a
 * server rebuild must not be a precondition of a live run. What it does share with the server
 * is the *file* — one source, read by both, so the lane cannot test a model prod does not run.
 *
 * Fail-closed: a missing field, a model not prefixed by its provider, or a non-positive price
 * is `PIPELINE_INVALID` and no call is made. There is no default and no fallback.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `site/` — the lane sits one level under it (`site/model-lane/`). */
export const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The book repository (the checkout): `manuscript/`, `process/`, `concept/`, `style/`, `outline/`. */
export const BOOK_ROOT = resolve(SITE_ROOT, '..');
export const PIPELINE_PATH = join(SITE_ROOT, 'config', 'pipeline.json');

const MODEL_ID = /^([a-z0-9-]+)\/([a-z0-9.\-]+)$/u;

export class LaneError extends Error {
  /**
   * `exitCode` follows ADR-038 §4: 2 = the lane could not run (key, provider, corpus, prompt,
   * scratch), 1 = a result that does not match or a pass that did not close. Default is 2.
   */
  constructor(code, message, exitCode = 2) {
    super(message);
    this.name = 'LaneError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function invalid(problem) {
  throw new LaneError('PIPELINE_INVALID', `pipeline: ${problem} at ${PIPELINE_PATH}`);
}

const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const filled = (value) => typeof value === 'string' && value.trim().length > 0;

/** Read the pin. `path` exists for the dry run's own negative check; production uses the default. */
export function readPipeline(path = PIPELINE_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    invalid(`cannot read the file (${path === PIPELINE_PATH ? 'default path' : path})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid('invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('the file must be an object');
  const { provider, model, endpoint, maxOutputTokens, pricing } = parsed;
  if (!filled(provider) || !filled(model)) invalid('provider and model are required');
  const match = MODEL_ID.exec(model.trim());
  if (match === null) invalid('model must be <provider>/<apiModel>');
  if (match[1] !== provider.trim()) invalid(`model is not prefixed with the provider "${provider.trim()}"`);
  if (!filled(endpoint) || !endpoint.trim().startsWith('https://')) invalid('endpoint must be an https URL');
  // The output cap is sent as `max_tokens`: without it the provider's default is eaten by
  // reasoning and a real answer comes back empty with `finish_reason: "length"`.
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    invalid('maxOutputTokens must be a positive integer');
  }
  if (pricing === null || typeof pricing !== 'object' || Array.isArray(pricing)) invalid('pricing is required');
  for (const key of ['input', 'output', 'cacheRead']) {
    if (!positive(pricing[key])) invalid(`pricing.${key} must be greater than zero`);
  }
  if (!positive(pricing.per)) invalid('pricing.per must be greater than zero');
  if (!filled(pricing.currency) || !filled(pricing.source) || !filled(pricing.date)) {
    invalid('pricing.currency, pricing.source and pricing.date are required');
  }
  return {
    provider: provider.trim(),
    model: model.trim(),
    apiModel: match[2],
    endpoint: endpoint.trim(),
    maxOutputTokens,
    pricing: {
      currency: pricing.currency.trim(),
      per: pricing.per,
      input: pricing.input,
      output: pricing.output,
      cacheRead: pricing.cacheRead,
      source: pricing.source.trim(),
      date: pricing.date.trim(),
    },
  };
}
