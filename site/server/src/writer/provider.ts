/**
 * One OpenAI-compatible completion call, read as a server-sent-event stream (BOOK-117,
 * `docs/writer-lane.md` §5–6).
 *
 * The exchange is deliberately plain: `POST` to the pinned endpoint with the pinned wire model,
 * the messages, `max_tokens`, `stream: true` and `stream_options: { include_usage: true }` — **no
 * sampling overrides**. A writer pass that let the provider sample differently from the pin would
 * make the money line and the prose irreproducible, and the pin is the only place a model may be
 * named.
 *
 * Why the stream and not a plain body: measured against this endpoint, a non-streaming call
 * answers `200` and then the body is reset (`ECONNRESET`, `TypeError: terminated`) ~20 s later on
 * a long answer, while the same request as SSE completes. The model reasons before it writes and
 * long generations are the norm here, so a non-streaming call would always hit the reset. The
 * answer is therefore assembled from `choices[0].delta.content` frames, the provider's own
 * `finish_reason` and the last `usage` object (the final frame carries `choices: []` and the
 * usage) — the same `ProviderResult` a plain body used to yield.
 *
 * The shape is the provider's, the retry is ours: transport failures, `429` and `5xx` are
 * retried **once** after a short fixed backoff; every other `4xx` is final — a bad key or a bad
 * request does not become a second request. A stream that breaks **after content has arrived** is
 * final too (see `partial`): re-running a half-read long generation doubles the cost and the reset
 * usually repeats. Error messages carry a code and a status and never the key or the response body.
 *
 * Two rules come from BOOK-219, the pass that died on a good answer:
 *
 *  · **A good answer is never a shape failure.** A `200` whose stream ends without a usable
 *    `usage` object used to be `PROVIDER_SHAPE`, and the pass — with its chapter already
 *    published — parked instead of closing. Now the text is the answer and the money is
 *    **estimated** from the bytes we sent and received (`estimateUsage`). The calibration of that
 *    run: 74 943 prompt chars → 25 300 tokens (≈2.96 chars/token), 28 383 answer chars → 15 068
 *    completion tokens with reasoning (≈1.88 chars/token); the constants sit **below** both
 *    ratios and every count is `ceil`ed, so the estimate is at or above the truth.
 *  · **An empty answer gets one more chance, unstreamed**: one more call as a plain body
 *    (`stream: false`, no `stream_options`). Only a second empty answer is `PROVIDER_SHAPE`.
 *
 * The call reports the model's own `finish_reason` and does not judge it: `length` means the
 * answer was cut at `max_tokens` — a reasoning model spends completion tokens before it writes
 * anything, so a tight cap truncates a chapter silently. That is the model's answer, not a
 * transport fault, so it is not retried here; the gate (`validate.ts`) refuses it.
 *
 * The transport is injected so the tests need no network, and this file lives outside
 * `engine/**`, which is where the architecture rule forbids `fetch` (ADR-012).
 */

import type { PipelineUsage } from './pipeline.ts';

export type WriterMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** `fetch` (or a test double): the only seam the provider has to the outside. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ProviderRequest = {
  endpoint: string;
  apiKey: string;
  apiModel: string;
  messages: WriterMessage[];
  maxTokens: number;
  timeoutMs: number;
};

export type ProviderResult = {
  text: string;
  responseModel: string;
  usage: PipelineUsage;
  latencyMs: number;
  attempts: number;
  /**
   * `choices[0].finish_reason` verbatim (`stop`, `length`, …), `null` when the provider did not
   * report one. `length` is the token cap: the text is a truncated answer, never a chapter.
   */
  finishReason: string | null;
};

/**
 * No chunk for this long means the generation is dead: the lease must not sit out the whole
 * total timeout on a stream that stopped sending.
 */
export const DEFAULT_STALL_MS = 90_000;

export type ProviderDeps = {
  transport?: FetchLike;
  /** Injected so a retry does not sleep in a test. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  backoffMs?: number;
  /** Stall window in milliseconds (`DEFAULT_STALL_MS`); injected so a test does not wait 90 s. */
  stallMs?: number;
};

export type ProviderCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNREACHABLE'
  | `PROVIDER_HTTP_${number}`
  | 'PROVIDER_SHAPE';

/** BOOK-219's calibration, in characters per token — under the measured 2.96 / 1.88, ceil()ed. */
export const PROMPT_CHARS_PER_TOKEN = 2.9;
export const ANSWER_CHARS_PER_TOKEN = 1.8;

/** The charge of a call that reported no usage: the prompt we sent, the answer we got, rounded up. */
export function estimateUsage(messages: readonly WriterMessage[], text: string): PipelineUsage {
  const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return {
    in: Math.ceil(promptChars / PROMPT_CHARS_PER_TOKEN),
    out: Math.ceil(text.length / ANSWER_CHARS_PER_TOKEN),
    cachedIn: 0,
    estimated: true,
  };
}

export class ProviderError extends Error {
  readonly code: ProviderCode;
  readonly attempts: number;

  constructor(code: ProviderCode, attempts: number) {
    // The message is the code and nothing else: no key, no response body, no URL.
    super(`provider: ${code}`);
    this.name = 'ProviderError';
    this.code = code;
    this.attempts = attempts;
  }
}

type AttemptOk = {
  ok: true;
  text: string;
  responseModel: string;
  usage: PipelineUsage;
  finishReason: string | null;
};

type AttemptFail = {
  ok: false;
  code: ProviderCode;
  retryable: boolean;
  /** A `200` with not one character of prose: the one failure re-asked without a stream. */
  empty?: boolean;
};

type Attempt = AttemptOk | AttemptFail;

/**
 * What one stream has said so far: `chars` is how much prose has arrived (the retry decision),
 * `usage` is the last usage object seen, `finishReason` the first one reported.
 */
type Accumulated = {
  parts: string[];
  chars: number;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  model: string;
  done: boolean;
};

/** The race marker: the reader produced nothing inside the stall window. */
const STALL: unique symbol = Symbol('stall');

const DATA_PREFIX = 'data:';
const DONE_FRAME = '[DONE]';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * `finish_reason`, read as the provider writes it: a non-empty string is the value, anything
 * else (absent, `null`, an empty string, a number) is "the provider said nothing".
 */
function finishReasonOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length > 0 ? reason : null;
}

/**
 * One SSE line, folded into the accumulator. `data:` is our protocol and everything else on the
 * wire (`: comment`, `event:`, blank separators) is not ours; `[DONE]` is the end marker.
 *
 * Only `choices[0].delta.content` is prose: a reasoning model also streams
 * `choices[0].delta.reasoning_content`, which is thought, not text, and never enters a chapter.
 * The usage frame carries `choices: []`, so the choices branch is skipped and the usage kept.
 *
 * A `data:` payload that is not JSON — or not an object — is a broken protocol frame: nothing
 * here invents a reading for it.
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
    parsed = JSON.parse(payload);
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

/**
 * Whole lines out of a byte-decoded buffer. SSE frames arrive on chunk boundaries anywhere, so
 * the tail is kept until the next chunk (or until the stream ends, when it is a frame of its own).
 */
function drainLines(buffer: string, acc: Accumulated, final: boolean): { rest: string; broken: boolean } {
  const parts = buffer.split('\n');
  const rest = final ? '' : parts.splice(-1, 1).join('');
  for (const part of parts) {
    const line = part.endsWith('\r') ? part.slice(0, -1) : part;
    if (consumeLine(line, acc) === 'bad') return { rest: '', broken: true };
  }
  return { rest, broken: false };
}

/**
 * One read, abandoned when the stream goes quiet for `stallMs`. A stalled generation is dead, so
 * the caller aborts the call (`onStall`) and stops reading; the abandoned read is left to settle
 * on its own (the caller attaches a handler) rather than awaited.
 */
async function readOrStall<T>(
  pending: Promise<T>,
  stallMs: number,
  onStall: () => void,
): Promise<T | typeof STALL> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<typeof STALL>((resolveStall) => {
    timer = setTimeout(() => {
      onStall();
      resolveStall(STALL);
    }, stallMs);
  });
  try {
    return await Promise.race([pending, stall]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A transport failure, before the stream or inside it. A retry re-sends the whole prompt, so the
 * decision is made on how much prose has already arrived: before any content a retry is cheap and
 * safe, after content it is not — a reset mid-answer means a half-read long generation, and
 * re-running it doubles the cost while the same reset usually happens again. A half-read answer
 * is therefore final (BOOK-117, the writer's first real pass died exactly this way).
 */
function partial(code: ProviderCode, acc: Accumulated): AttemptFail {
  return { ok: false, code, retryable: acc.chars === 0 };
}

function shape(empty = false): AttemptFail {
  const failure: AttemptFail = { ok: false, code: 'PROVIDER_SHAPE', retryable: false };
  return empty ? { ...failure, empty: true } : failure;
}

/**
 * A text, a usage object and a model become an `AttemptOk` here, and only here (BOOK-219): an
 * empty text is `PROVIDER_SHAPE` (`empty`, so it may be re-asked unstreamed); a usable usage is
 * the measurement (cache clamped to the prompt); a missing one is `estimateUsage`.
 */
function assembled(input: {
  text: string;
  usage: Record<string, unknown> | null;
  responseModel: string;
  finishReason: string | null;
  messages: readonly WriterMessage[];
}): Attempt {
  const text = input.text;
  if (text.trim().length === 0) return shape(true);

  const { responseModel, finishReason } = input;
  const inTokens = tokenCount(input.usage?.prompt_tokens);
  const outTokens = tokenCount(input.usage?.completion_tokens);
  // No usable usage: the answer is charged at the estimate, never refused for its own invoice.
  if (input.usage === null || inTokens === null || outTokens === null) {
    return { ok: true, text, responseModel, usage: estimateUsage(input.messages, text), finishReason };
  }
  const details = record(input.usage.prompt_tokens_details);
  const cached = tokenCount(input.usage.prompt_cache_hit_tokens) ?? tokenCount(details?.cached_tokens) ?? 0;
  const usage = { in: inTokens, out: outTokens, cachedIn: Math.min(cached, inTokens) };
  return { ok: true, text, responseModel, usage, finishReason };
}

/** The streamed answer, from what the stream said so far. */
function assemble(acc: Accumulated, request: ProviderRequest): Attempt {
  return assembled({
    text: acc.parts.join(''),
    usage: acc.usage,
    responseModel: acc.model.length > 0 ? acc.model : request.apiModel,
    finishReason: acc.finishReason,
    messages: request.messages,
  });
}

/**
 * The plain-body answer — the retry an empty stream gets: `choices[0].message.content`, the
 * `finish_reason`, the `usage`. A body that cannot be read carried no prose, so it is empty.
 */
async function readBody(response: Response, request: ProviderRequest): Promise<Attempt> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return shape(true);
  }
  const frame = record(payload);
  if (frame === null) return shape();
  const choices = frame.choices;
  const choice = Array.isArray(choices) ? record(choices[0]) : null;
  if (choice === null) return shape(true);
  const message = record(choice.message);
  const model = typeof frame.model === 'string' ? frame.model.trim() : '';
  return assembled({
    text: typeof message?.content === 'string' ? message.content : '',
    usage: record(frame.usage),
    responseModel: model.length > 0 ? model : request.apiModel,
    finishReason: finishReasonOf(choice.finish_reason),
    messages: request.messages,
  });
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** The request body: the stream envelope, or the plain one the unstreamed retry sends (BOOK-219). */
function envelope(request: ProviderRequest, stream: boolean): string {
  const body = { model: request.apiModel, messages: request.messages, max_tokens: request.maxTokens };
  return JSON.stringify(
    stream ? { ...body, stream: true, stream_options: { include_usage: true } } : { ...body, stream: false },
  );
}

async function attemptOnce(request: ProviderRequest, deps: Required<ProviderDeps>, stream: boolean): Promise<Attempt> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  const acc: Accumulated = { parts: [], chars: 0, finishReason: null, usage: null, model: '', done: false };

  try {
    let response: Response;
    try {
      response = await deps.transport(request.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${request.apiKey}`,
        },
        body: envelope(request, stream),
        signal: controller.signal,
      });
    } catch {
      // No response yet means no content yet: the retry is cheap and safe either way, and only
      // the timeout has its own code.
      return partial(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', acc);
    }

    if (!response.ok) {
      // Status only. The body is provider text at best and a leaked credential at worst, and
      // nothing here needs it.
      return {
        ok: false,
        code: `PROVIDER_HTTP_${response.status}`,
        retryable: retryableStatus(response.status),
      };
    }

    if (!stream) return await readBody(response, request);

    const body = response.body;
    // A `200` with no body at all is not a stream: there is nothing to read, and no prose either.
    if (body === null) return shape(true);

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stalled = false;
    let broken = false;
    let readError: unknown = null;

    try {
      while (!acc.done) {
        const pending = reader.read();
        // The stall race abandons this read; its own rejection must not surface as unhandled.
        pending.catch(() => {});
        const step = await readOrStall(pending, deps.stallMs, () => {
          stalled = true;
          controller.abort();
        });
        if (step === STALL) break;
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
    } catch (error) {
      // A body reset (the measured `ECONNRESET`) or the total timeout aborting the read.
      readError = error;
    } finally {
      // `[DONE]`, a stall or a reset all leave the body unread; give the connection back. The
      // reader reports a disturbed stream as a rejected promise, never as a synchronous throw.
      void reader.cancel().catch(() => {});
    }

    if (stalled) return partial('PROVIDER_TIMEOUT', acc);
    if (broken) return shape();
    if (readError !== null) return partial(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', acc);
    return assemble(acc, request);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call: at most two attempts, and the second one is either the transport retry or the
 * unstreamed re-ask of an empty answer (BOOK-219). The key travels in the header, never in the URL.
 */
export async function callProvider(request: ProviderRequest, deps: ProviderDeps = {}): Promise<ProviderResult> {
  const transport = deps.transport ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const now = deps.now ?? (() => Date.now());
  const settings: Required<ProviderDeps> = {
    transport,
    sleep,
    now,
    backoffMs: deps.backoffMs ?? 500,
    stallMs: deps.stallMs ?? DEFAULT_STALL_MS,
  };

  const startedAt = now();
  let attempts = 0;
  // A `200` that ended without a single character is asked again as a plain body — no backoff:
  // the model did not fail, it answered nothing, and a short gate answer needs no stream.
  let stream = true;
  for (;;) {
    attempts += 1;
    const outcome = await attemptOnce(request, settings, stream);
    if (outcome.ok) {
      const { text, responseModel, usage, finishReason } = outcome;
      return { text, responseModel, usage, latencyMs: now() - startedAt, attempts, finishReason };
    }
    if (outcome.empty === true && stream) {
      stream = false;
      continue;
    }
    if (!outcome.retryable || attempts >= 2) {
      throw new ProviderError(outcome.code, attempts);
    }
    await settings.sleep(settings.backoffMs);
  }
}
