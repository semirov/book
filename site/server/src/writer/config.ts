/**
 * The writer's own environment (BOOK-117, `docs/writer-lane.md` §5–6). It is read here and not
 * in `server/src/config.ts`: the site boots without a model key, while the writer cannot run
 * without one, so the two have different failure moments and different owners (BOOK-62 owns the
 * server config).
 *
 * Rules this file enforces:
 *  · the model is the pipeline's (`site/config/pipeline.json`); `WRITER_MODEL` may only *restate*
 *    it — a different value is refused as `MODEL_NOT_PIPELINE`, never silently honoured, because
 *    a pass that runs on a model the pin does not price would report money that is not real;
 *  · the endpoint is the pipeline's for the same reason (`WRITER_ENDPOINT`, `ENDPOINT_NOT_PIPELINE`);
 *  · the key comes from `DEEPSEEK_API_KEY_FILE` in every environment. The plain
 *    `DEEPSEEK_API_KEY` is a local convenience only: outside production it is accepted, in
 *    production it is refused, because `--env-file` and `docker inspect` both show it;
 *  · the key value never reaches an error, a log line or a printable dump. Every message names
 *    the variable, the path is not echoed, and `redacted()` is the only shape that may be printed.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiModelOf, loadPipeline, type Pipeline } from './pipeline.ts';

/** `site/` — works from `server/src/writer` (tsx) and from `server/dist/writer` (node). */
const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DEFAULT_PIPELINE_PATH = resolve(SITE_ROOT, 'config', 'pipeline.json');
export const DEFAULT_ENGINE_TOKEN_FILE = resolve(SITE_ROOT, '.data', 'engine.token');
export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:8081';

export type WriterConfigCode = 'MODEL_NOT_PIPELINE' | 'ENDPOINT_NOT_PIPELINE' | 'KEY_MISSING' | 'CONFIG_INVALID';

export class WriterConfigError extends Error {
  readonly code: WriterConfigCode;
  readonly detail: unknown;

  constructor(code: WriterConfigCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'WriterConfigError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** Everything the writer may print about itself: no key, no key value, no key path. */
export type WriterConfigRedacted = {
  provider: string;
  model: string;
  apiModel: string;
  endpoint: string;
  pipelinePath: string;
  keySource: 'file' | 'env';
  timeoutMs: number;
  /** The writing call's cap (`draft`/`repair`/`continue`). */
  maxTokensPerCall: number;
  /** The gate call's cap: a verdict is a thinking call, not a short one. */
  gateTokens: number;
  maxTokensPerPass: number;
  continueMax: number;
  dailyTokens: number;
  maxPassesPerDay: number;
  pauseMs: number;
  engineUrl: string;
  /** The engine's own cap, per request (`WRITER_ENGINE_TIMEOUT_MS`). */
  engineTimeoutMs: number;
  engineTokenFile: string;
  session: string;
};

export type WriterConfig = WriterConfigRedacted & {
  /** The key itself. Non-enumerable, so `JSON.stringify`/spread/`inspect` cannot leak it. */
  readonly apiKey: string;
  readonly pipeline: Pipeline;
  redacted(): WriterConfigRedacted;
};

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new WriterConfigError('CONFIG_INVALID', `${name} must be an integer, at least ${String(min)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new WriterConfigError('CONFIG_INVALID', `${name} must be an integer, at least ${String(min)}`);
  }
  return value;
}

function text(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = (env[name] ?? '').trim();
  return raw.length === 0 ? fallback : raw;
}

/**
 * The key, from its file; the plain variable only outside production. The messages carry the
 * variable name and never the value or the path (a path is not a secret, but it is a hint about
 * where the secret lives, and no message needs it).
 */
function readKey(env: NodeJS.ProcessEnv, production: boolean): { key: string; source: 'file' | 'env' } {
  const file = (env.DEEPSEEK_API_KEY_FILE ?? '').trim();
  if (file.length > 0) {
    let value: string;
    try {
      value = readFileSync(file, 'utf8').trim();
    } catch {
      throw new WriterConfigError('KEY_MISSING', 'DEEPSEEK_API_KEY_FILE cannot be read');
    }
    if (value.length === 0) {
      throw new WriterConfigError('KEY_MISSING', 'DEEPSEEK_API_KEY_FILE is empty');
    }
    return { key: value, source: 'file' };
  }
  const plain = (env.DEEPSEEK_API_KEY ?? '').trim();
  if (plain.length > 0) {
    if (production) {
      throw new WriterConfigError(
        'KEY_MISSING',
        'DEEPSEEK_API_KEY must come from DEEPSEEK_API_KEY_FILE in production, never from a plain value',
      );
    }
    return { key: plain, source: 'env' };
  }
  throw new WriterConfigError('KEY_MISSING', 'no model key: set DEEPSEEK_API_KEY_FILE');
}

export function loadWriterConfig(env: NodeJS.ProcessEnv = process.env): WriterConfig {
  const production = (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const pipelinePath = text(env, 'PIPELINE_PATH', DEFAULT_PIPELINE_PATH);
  const pipeline = loadPipeline(pipelinePath);
  const apiModel = apiModelOf(pipeline);

  // A restatement is a check, not a choice: the pin is the source of truth.
  const declaredModel = (env.WRITER_MODEL ?? '').trim();
  if (declaredModel.length > 0 && declaredModel !== pipeline.model) {
    throw new WriterConfigError(
      'MODEL_NOT_PIPELINE',
      'WRITER_MODEL does not restate pipeline.model; the pipeline pin is the only model',
      { declared: declaredModel, expected: pipeline.model },
    );
  }
  const declaredEndpoint = (env.WRITER_ENDPOINT ?? '').trim();
  if (declaredEndpoint.length > 0 && declaredEndpoint !== pipeline.endpoint) {
    throw new WriterConfigError(
      'ENDPOINT_NOT_PIPELINE',
      'WRITER_ENDPOINT does not restate pipeline.endpoint',
      { declared: declaredEndpoint, expected: pipeline.endpoint },
    );
  }
  const { key, source } = readKey(env, production);

  const engineUrl = text(env, 'WRITER_ENGINE_URL', DEFAULT_ENGINE_URL);
  if (!/^https?:\/\/\S+$/u.test(engineUrl)) {
    throw new WriterConfigError('CONFIG_INVALID', 'WRITER_ENGINE_URL must be an http(s) URL');
  }

  const redacted: WriterConfigRedacted = {
    provider: pipeline.provider,
    model: pipeline.model,
    apiModel,
    endpoint: pipeline.endpoint,
    pipelinePath,
    keySource: source,
    timeoutMs: integer(env, 'WRITER_TIMEOUT_MS', 420_000, 1),
    // Two written calls, two caps. The writing call's cap bounds the chapter; the gate call's cap
    // bounds a verdict, and a verdict is a thinking call: measured on the first real pass
    // (chapter 65), a 1 027-character editor answer cost 24 254 in / 10 161 out and a
    // 740-character consultant answer 11 350 in / 19 097 out — nearly all of it reasoning before
    // the first word of the answer. On the revised chapter (22 691 characters) the editor's
    // reasoning alone ran past the old 16 000 cap, the stream ended with empty content and the
    // provider reported it, correctly, as PROVIDER_SHAPE. Both caps are runaway guards, not
    // budgets: money is the bound ($10 a day, `budget.ts`).
    maxTokensPerCall: integer(env, 'WRITER_MAX_TOKENS_PER_CALL', 64_000, 1),
    gateTokens: integer(env, 'WRITER_GATE_TOKENS', 64_000, 1),
    // The per-pass guard is the sum of what one pass can legitimately spend: a real pass with a
    // revision and both gates measured 53 739 in / 60 102 out, and a second gate round on a
    // bigger chapter has to fit too. A runaway guard, never the bound.
    maxTokensPerPass: integer(env, 'WRITER_MAX_TOKENS_PER_PASS', 200_000, 1),
    continueMax: integer(env, 'WRITER_CONTINUE_MAX', 2, 0),
    dailyTokens: integer(env, 'WRITER_DAILY_TOKENS', 1_500_000, 1),
    maxPassesPerDay: integer(env, 'WRITER_MAX_PASSES_PER_DAY', 4, 1),
    pauseMs: integer(env, 'WRITER_PAUSE_MS', 900_000, 0),
    engineUrl,
    // The engine's own cap, and 60 s rather than the old 10: the engine is local but it is busy,
    // and on the measured pass (chapter 65) `land` outran 10 s *after* the chapter had landed and
    // been published — the pass was closed as a timeout over a chapter that was already written.
    engineTimeoutMs: integer(env, 'WRITER_ENGINE_TIMEOUT_MS', 60_000, 1_000),
    engineTokenFile: resolve(SITE_ROOT, text(env, 'ENGINE_TOKEN_FILE', DEFAULT_ENGINE_TOKEN_FILE)),
    session: text(env, 'WRITER_SESSION', 'writer'),
  };

  const config: WriterConfig = { ...redacted, pipeline, apiKey: key, redacted: () => redacted };
  // The key is a value the writer uses, never a field anything prints: non-enumerable keeps it
  // out of `JSON.stringify`, object spread and a default `util.inspect`.
  Object.defineProperty(config, 'apiKey', { value: key, enumerable: false, writable: false, configurable: false });
  return config;
}
