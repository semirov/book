/**
 * One OpenAI-compatible chat call for the graph extractor (BOOK-185, BOOK-DOC-77 §2).
 *
 * The exchange is the writer's, minus the writer: `POST` to the pinned endpoint with the pinned
 * wire model, the messages, `max_tokens` and `stream: true` with usage in the stream — and **no
 * sampling overrides**. A temperature here would make two runs of the same chapter disagree, and
 * the whole point of the graph is that the same revision replays the same answer.
 *
 * Why the stream and not a plain body: measured against this endpoint, a long non-streaming answer
 * is reset ~20 s in, while the same request as SSE completes (`writer/provider.ts` records the
 * measurement). The answer is assembled from `choices[0].delta.content` frames, the provider's own
 * `finish_reason`, and the final usage frame.
 *
 * The shape is the provider's, the retry is ours: transport failures, `429` and `5xx` are retried
 * **once**, after a fixed backoff. A `4xx` is final — a bad key or a bad request does not become a
 * second request — and so is a stream that broke **after content arrived**: re-running a half-read
 * generation doubles the cost and the reset usually repeats. `finish_reason: "length"` is returned,
 * not thrown: the model's answer was cut at the cap, and it is the gate's job to refuse it. The
 * caller (`parseAnswer`) sees a truncated object and says so.
 *
 * The key: `DEEPSEEK_API_KEY_FILE` in every environment, and it must be owner-only (`0600` or
 * stricter) — a mode that lets another user on the box read the book's model key is refused, not
 * warned about. The plain `DEEPSEEK_API_KEY` is a local convenience and is refused in production,
 * because `--env-file` and `docker inspect` both show it. No message names the key or its path.
 *
 * Pure and injectable: the transport is a parameter, so the tests need no network, and this file
 * writes nothing.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiModelOf, loadPipeline, type Pipeline } from '../pipeline.ts';

/** `site/` — works from `server/src/graph` (tsx) and from `server/dist/graph` (node). */
const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DEFAULT_PIPELINE_PATH = resolve(SITE_ROOT, 'config', 'pipeline.json');
/**
 * The extractor's own timeout: one chapter's answer, not a whole pass.
 *
 * Measured on the real run: a full chapter's JSON — every carrier with its sentence — streams for
 * minutes, and the reasoning model may emit nothing readable for the first few. At 180 s a whole
 * chapter of chapter 4/6 timed out with zero bytes, twice; at 420 s (the writer's own guard) the
 * same chapter lands. The timeout is not part of the question's identity: the same request is
 * asked either way, so a slower answer is a slower answer, never a different one.
 */
export const DEFAULT_TIMEOUT_MS = 420_000;
/** `GRAPH_TIMEOUT_MS` overrides it for one run (a slow provider, a debugging session). */
export function timeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.GRAPH_TIMEOUT_MS ?? '').trim();
  if (raw === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}
const DEFAULT_BACKOFF_MS = 500;

export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** `fetch` (or a test double): the only seam this module has to the outside. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ModelConfig = {
  endpoint: string;
  /** The wire model id: `apiModelOf(pipeline)`, never the `<provider>/<model>` pin. */
  model: string;
  maxOutputTokens: number;
  /** The key itself. Non-enumerable: `JSON.stringify` and object spread cannot print it. */
  readonly apiKey: string;
  keySource: 'file' | 'env';
};

export type ModelConfigCode = 'KEY_MISSING' | 'KEY_MODE' | 'CONFIG_INVALID';

export class ModelConfigError extends Error {
  readonly code: ModelConfigCode;

  constructor(code: ModelConfigCode, message: string) {
    // The message names a variable and a rule — never a key, never the key's path.
    super(`${code}: ${message}`);
    this.name = 'ModelConfigError';
    this.code = code;
  }
}

export type CallCode =
  | 'MODEL_TIMEOUT'
  | 'MODEL_UNREACHABLE'
  | `MODEL_HTTP_${number}`
  | 'MODEL_SHAPE';

export class ModelError extends Error {
  readonly code: CallCode;
  readonly attempts: number;

  constructor(code: CallCode, attempts: number) {
    // Status and code only: the response body is provider text at best and a leaked credential
    // at worst, and nothing here needs it.
    super(`model: ${code}`);
    this.name = 'ModelError';
    this.code = code;
    this.attempts = attempts;
  }
}

/** The usage the cost line and `extraction_runs` need; no zeros invented for a missing frame. */
export type ModelUsage = { in: number; out: number; cached: number };

export type ModelResult = {
  text: string;
  /** The model the provider reported, or the pinned one when the stream omitted it. */
  model: string;
  usage: ModelUsage;
  latencyMs: number;
  /** `stop`, `length`, … verbatim; `null` when the provider reported none. */
  finishReason: string | null;
  attempts: number;
};

export type CompleteRequest = {
  messages: readonly ModelMessage[];
  /** Overrides the pipeline's cap for one call; the pin's value is the default. */
  maxTokens?: number;
  timeoutMs?: number;
  transport?: FetchLike;
  /** Injected so a retry does not sleep in a test. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function keyError(code: ModelConfigCode, message: string): ModelConfigError {
  return new ModelConfigError(code, message);
}

/**
 * The key from its file. `0600` is enforced by the mode bits: group or other readable means the
 * secret is not the reader's alone, and a run that starts anyway would make the refusal a comment.
 */
function readKeyFile(path: string): string {
  let mode: number;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw keyError('KEY_MODE', 'DEEPSEEK_API_KEY_FILE is not a regular file');
    mode = stats.mode & 0o777;
  } catch (error) {
    if (error instanceof ModelConfigError) throw error;
    throw keyError('KEY_MISSING', 'DEEPSEEK_API_KEY_FILE cannot be read');
  }
  if ((mode & 0o077) !== 0) {
    throw keyError('KEY_MODE', `DEEPSEEK_API_KEY_FILE must be 0600, it is ${mode.toString(8).padStart(3, '0')}`);
  }
  let value: string;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    throw keyError('KEY_MISSING', 'DEEPSEEK_API_KEY_FILE cannot be read');
  }
  if (value.length === 0) throw keyError('KEY_MISSING', 'DEEPSEEK_API_KEY_FILE is empty');
  return value;
}

function readKey(env: NodeJS.ProcessEnv, production: boolean): { key: string; source: 'file' | 'env' } {
  const file = (env.DEEPSEEK_API_KEY_FILE ?? '').trim();
  if (file.length > 0) return { key: readKeyFile(file), source: 'file' };
  const plain = (env.DEEPSEEK_API_KEY ?? '').trim();
  if (plain.length > 0) {
    if (production) {
      throw keyError(
        'KEY_MISSING',
        'DEEPSEEK_API_KEY must come from DEEPSEEK_API_KEY_FILE in production, never from a plain value',
      );
    }
    return { key: plain, source: 'env' };
  }
  throw keyError('KEY_MISSING', 'no model key: set DEEPSEEK_API_KEY_FILE');
}

/**
 * Read the pin, derive the wire model and take the key. The pipeline file is read on every call to
 * this function (a process boots once): a pin that changed on disk is a restart, not a surprise.
 */
export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const production = (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const pipelinePath = (env.PIPELINE_PATH ?? '').trim() || DEFAULT_PIPELINE_PATH;

  let pipeline: Pipeline;
  try {
    pipeline = loadPipeline(pipelinePath);
  } catch (error) {
    // `loadPipeline` names the path and the problem, never a value that could be a key.
    throw new ModelConfigError('CONFIG_INVALID', error instanceof Error ? error.message : 'pipeline is unreadable');
  }

  const { key, source } = readKey(env, production);
  const config: ModelConfig = {
    endpoint: pipeline.endpoint,
    model: apiModelOf(pipeline),
    maxOutputTokens: pipeline.maxOutputTokens,
    apiKey: key,
    keySource: source,
  };
  Object.defineProperty(config, 'apiKey', { value: key, enumerable: false, writable: false, configurable: false });
  return config;
}

const DATA_PREFIX = 'data:';
const DONE_FRAME = '[DONE]';

type Accumulated = {
  parts: string[];
  chars: number;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  model: string;
  done: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function finishReasonOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length > 0 ? reason : null;
}

/**
 * One SSE line folded into the accumulator. `data:` is our protocol and the rest of the wire is
 * not ours. Only `delta.content` is text: a reasoning model also streams `delta.reasoning_content`,
 * which is thought and never enters an answer. A payload that is not a JSON object is a broken
 * frame, and nothing here invents a reading for it.
 */
function consumeLine(line: string, acc: Accumulated): 'ok' | 'bad' {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DATA_PREFIX)) return 'ok';
  const payload = trimmed.slice(DATA_PREFIX.length).trim();
  if (payload.length === 0) return 'ok';
  if (payload === DONE_FRAME) {
    acc.done = true;
    return 'ok';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return 'bad';
  }
  const frame = record(parsed);
  if (frame === null) return 'bad';

  const model = typeof frame.model === 'string' ? frame.model.trim() : '';
  if (model.length > 0 && acc.model.length === 0) acc.model = model;

  const usage = record(frame.usage);
  if (usage !== null) acc.usage = usage;

  const choices = frame.choices;
  if (!Array.isArray(choices)) return 'ok';
  const choice = record(choices[0]);
  if (choice === null) return 'ok';

  const reason = finishReasonOf(choice.finish_reason);
  if (reason !== null && acc.finishReason === null) acc.finishReason = reason;

  const delta = record(choice.delta);
  const content = delta?.content;
  if (typeof content === 'string' && content.length > 0) {
    acc.parts.push(content);
    acc.chars += content.length;
  }
  return 'ok';
}

/** Whole lines out of a byte-decoded buffer: an SSE frame may be split on any chunk boundary. */
function drainLines(buffer: string, acc: Accumulated, final: boolean): { rest: string; broken: boolean } {
  const parts = buffer.split('\n');
  const rest = final ? '' : parts.splice(-1, 1).join('');
  for (const part of parts) {
    const line = part.endsWith('\r') ? part.slice(0, -1) : part;
    if (consumeLine(line, acc) === 'bad') return { rest: '', broken: true };
  }
  return { rest, broken: false };
}

type AttemptOk = { ok: true; text: string; responseModel: string; usage: ModelUsage; finishReason: string | null };
type AttemptFail = { ok: false; code: CallCode; retryable: boolean };
type Attempt = AttemptOk | AttemptFail;

function shape(): AttemptFail {
  return { ok: false, code: 'MODEL_SHAPE', retryable: false };
}

/**
 * The stream's own account, assembled. A missing or unusable usage object is a shape failure, not a
 * zero-cost call: a chapter whose tokens are unknown cannot be charged, and a charge of zero would
 * be a lie in the run's row. An empty text is *not* a shape failure — `finish_reason: length` on a
 * reasoning model is exactly that — so it is returned and left for the schema to refuse.
 */
function assemble(acc: Accumulated, fallbackModel: string): Attempt {
  const inTokens = tokenCount(acc.usage?.prompt_tokens);
  const outTokens = tokenCount(acc.usage?.completion_tokens);
  if (acc.usage === null || inTokens === null || outTokens === null) return shape();

  const details = record(acc.usage.prompt_tokens_details);
  const cached = tokenCount(acc.usage.prompt_cache_hit_tokens) ?? tokenCount(details?.cached_tokens) ?? 0;

  return {
    ok: true,
    text: acc.parts.join(''),
    responseModel: acc.model.length > 0 ? acc.model : fallbackModel,
    usage: { in: inTokens, out: outTokens, cached: Math.min(cached, inTokens) },
    finishReason: acc.finishReason,
  };
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function attemptOnce(
  config: ModelConfig,
  request: CompleteRequest,
  transport: FetchLike,
  timeoutMs: number,
  maxTokens: number,
): Promise<Attempt> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const acc: Accumulated = { parts: [], chars: 0, finishReason: null, usage: null, model: '', done: false };

  try {
    let response: Response;
    try {
      response = await transport(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: request.messages,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
    } catch {
      // No response means no content: the retry is cheap and safe, and only the timeout has a code.
      return { ok: false, code: timedOut ? 'MODEL_TIMEOUT' : 'MODEL_UNREACHABLE', retryable: true };
    }

    if (!response.ok) {
      return {
        ok: false,
        code: `MODEL_HTTP_${response.status}`,
        retryable: retryableStatus(response.status),
      };
    }

    const body = response.body;
    // A `200` with no body is not a stream: nothing to read, nothing to bill.
    if (body === null) return shape();

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let broken = false;
    let readError = false;

    try {
      while (!acc.done) {
        const step = await reader.read();
        if (step.done) {
          buffer += decoder.decode();
          broken = drainLines(buffer, acc, true).broken;
          break;
        }
        buffer += decoder.decode(step.value, { stream: true });
        const drained = drainLines(buffer, acc, false);
        buffer = drained.rest;
        if (drained.broken) {
          broken = true;
          break;
        }
      }
    } catch {
      // A body reset (the measured `ECONNRESET`) or the timeout aborting the read.
      readError = true;
    } finally {
      // `[DONE]` or a reset leaves the body unread; give the connection back.
      void reader.cancel().catch(() => {});
    }

    if (broken) return shape();
    if (readError) {
      // A half-read answer is final: the code says what happened, and the caller sees `attempts`.
      return { ok: false, code: timedOut ? 'MODEL_TIMEOUT' : 'MODEL_UNREACHABLE', retryable: acc.chars === 0 };
    }
    return assemble(acc, config.model);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call, at most two attempts. The key travels in the header, never in the URL, and no message
 * carries the endpoint but the request itself.
 */
export async function complete(config: ModelConfig, request: CompleteRequest): Promise<ModelResult> {
  const transport = request.transport ?? ((url, init) => fetch(url, init));
  const sleep = request.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = request.now ?? (() => Date.now());
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = request.maxTokens ?? config.maxOutputTokens;

  const startedAt = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const outcome = await attemptOnce(config, request, transport, timeoutMs, maxTokens);
    if (outcome.ok) {
      return {
        text: outcome.text,
        model: outcome.responseModel,
        usage: outcome.usage,
        latencyMs: now() - startedAt,
        finishReason: outcome.finishReason,
        attempts,
      };
    }
    if (!outcome.retryable || attempts >= 2) throw new ModelError(outcome.code, attempts);
    await sleep(DEFAULT_BACKOFF_MS);
  }
}
