/**
 * The one provider call the lane makes (ADR-038 §4) — **streaming**, which is the prod shape.
 *
 * Non-streaming is what this lane used to do, and it dies on a real writing pass: the provider
 * runs the generation long, then the TLS connection is reset mid-response and there is nothing
 * to parse (BOOK-62, 2026-10-27). Prod streams; so does the lane. One path, no fallback.
 *
 * `POST <endpoint>` with `{model, messages, max_tokens, stream, stream_options:{include_usage}}`
 * and **no sampling overrides** — `max_tokens` is the pinned output cap, temperature is never
 * sent. The answer's own `model` is recorded beside the declared one: the transcript is the
 * receipt. Only the reasoning **length** is kept; its text is never stored or logged.
 *
 * Timeouts bound a long call instead of a socket default: a total cap and an idle cap (no bytes
 * for N seconds) abort with `PROVIDER_STALL`, carrying the last finish state so the failure says
 * where it stopped. A 200 that is not SSE, with no usable events, is `PROVIDER_BODY`.
 *
 * The key comes from `DEEPSEEK_API_KEY` or `DEEPSEEK_API_KEY_FILE` (a `0600` file). It never
 * reaches a transcript, a log line, an error message or argv — only the *source name* is printed.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BOOK_ROOT, LaneError } from './pipeline.mjs';

/** Where the key may live; a file is preferred, because an env var is visible in `ps`. */
const KEY_FILE_DEFAULT = join(BOOK_ROOT, 'site', 'secrets', 'deepseek.key');
/** Caps, not knobs: 20 minutes for the whole call, 180 s of silence inside it. */
const TOTAL_MS = 20 * 60 * 1_000;
const IDLE_MS = 180 * 1_000;
const BACKOFF_MS = 2_000;
/** How much of a non-200 body may reach a message. */
const SNIPPET = 400;

/** The source, never the value: this string is the only thing a report may print. */
export function readKey(env = process.env) {
  const file = env.DEEPSEEK_API_KEY_FILE;
  if (typeof file === 'string' && file.trim().length > 0) {
    const path = file.trim();
    let mode;
    try {
      mode = statSync(path).mode;
    } catch {
      throw new LaneError('KEY_MISSING', `DEEPSEEK_API_KEY_FILE does not exist (${path})`);
    }
    if ((mode & 0o077) !== 0) {
      throw new LaneError('KEY_UNSAFE', `DEEPSEEK_API_KEY_FILE must be 0600, refusing to read it (${path})`);
    }
    const value = readFileSync(path, 'utf8').trim();
    if (value.length === 0) throw new LaneError('KEY_MISSING', `DEEPSEEK_API_KEY_FILE is empty (${path})`);
    return { key: value, source: 'DEEPSEEK_API_KEY_FILE' };
  }
  const plain = env.DEEPSEEK_API_KEY;
  if (typeof plain === 'string' && plain.trim().length > 0) {
    return { key: plain.trim(), source: 'DEEPSEEK_API_KEY' };
  }
  throw new LaneError(
    'KEY_MISSING',
    `no provider key: set DEEPSEEK_API_KEY_FILE (0600) or DEEPSEEK_API_KEY; ${KEY_FILE_DEFAULT} is the documented default`,
  );
}

/** How many cache tokens the provider reports — two shapes exist, and both are real. */
function cachedOf(usage) {
  const details = usage?.prompt_tokens_details;
  if (details !== undefined && details !== null && Number.isFinite(details.cached_tokens)) {
    return Math.max(0, Math.trunc(details.cached_tokens));
  }
  if (Number.isFinite(usage?.prompt_cache_hit_tokens)) return Math.max(0, Math.trunc(usage.prompt_cache_hit_tokens));
  return 0;
}

/** Reasoning is billed inside `completion_tokens`; the count is recorded, never hidden. */
function reasoningOf(usage) {
  const details = usage?.completion_tokens_details;
  return details !== undefined && details !== null && Number.isFinite(details.reasoning_tokens)
    ? Math.max(0, Math.trunc(details.reasoning_tokens))
    : 0;
}

function counts(usage) {
  return {
    in: Math.max(0, Math.trunc(usage?.prompt_tokens ?? 0)),
    out: Math.max(0, Math.trunc(usage?.completion_tokens ?? 0)),
    cachedIn: cachedOf(usage),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `data:` payload of one SSE event (multi-line data joined), or null for a comment. */
function payloadOf(event) {
  const data = [];
  for (const line of event.split('\n')) {
    if (!line.startsWith('data:')) continue;
    data.push(line.slice('data:'.length).replace(/^ /u, ''));
  }
  return data.length === 0 ? null : data.join('\n');
}

/** A bounded read of an error body: enough to name the refusal, never the whole response. */
async function boundedText(response, limit = 4_096) {
  try {
    const reader = response.body?.getReader();
    if (reader === undefined || reader === null) return '';
    const decoder = new TextDecoder();
    let out = '';
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      size += value.byteLength;
      if (size >= limit) break;
    }
    await reader.cancel().catch(() => undefined);
    return out.slice(0, limit);
  } catch {
    return '';
  }
}

function stallError(cap, facts) {
  return new LaneError(
    'PROVIDER_STALL',
    `the stream stopped answering (${cap} cap; finish_reason ${facts.finishReason ?? 'absent'}, ` +
      `${String(facts.chars)} content chars, ${String(facts.reasoningChars)} reasoning chars)`,
  );
}

/**
 * Read one SSE response into an answer. `hooks.armIdle()` re-arms the silence timer on bytes;
 * `hooks.fired()` names the cap that aborted, if any. Only a stream that ends with `[DONE]` or
 * with a `finish_reason` counts as an answer — anything else is a truncated one.
 */
async function readStream(response, hooks) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoningChars = 0;
  let responseModel = null;
  let finishReason = null;
  let usage = null;
  let events = 0;
  let done = false;

  const apply = (payload) => {
    if (payload === '[DONE]') {
      done = true;
      events += 1;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk === null || typeof chunk !== 'object') return;
    events += 1;
    if (responseModel === null && typeof chunk.model === 'string') responseModel = chunk.model;
    if (chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (choice === null || typeof choice !== 'object') return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    // The reasoning text is never kept: its length alone explains a cap spent on thinking.
    if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length;
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  };

  const drain = () => {
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const payload = payloadOf(event);
      if (payload !== null) apply(payload);
      if (done) return;
    }
  };

  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      const fired = hooks.fired();
      if (fired !== null) throw stallError(fired, { finishReason, chars: text.length, reasoningChars });
      throw new LaneError(
        'PROVIDER_UNREACHABLE',
        `the stream broke: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (chunk.done) break;
    hooks.armIdle();
    buffer = `${buffer}${decoder.decode(chunk.value, { stream: true })}`.replace(/\r\n/gu, '\n');
    drain();
    if (done) break;
  }
  await reader.cancel().catch(() => undefined);

  if (events === 0) {
    throw new LaneError('PROVIDER_BODY', 'the provider answered 200 with no stream events');
  }
  if (!done && finishReason === null) {
    throw new LaneError(
      'PROVIDER_STALL',
      `the stream ended before [DONE] or a finish_reason (${String(text.length)} chars, ` +
        `${String(reasoningChars)} reasoning chars)`,
    );
  }
  return {
    text,
    empty: text.trim().length === 0,
    finishReason,
    reasoningTokens: reasoningOf(usage),
    reasoningChars,
    responseModel,
    usage: counts(usage),
    streamComplete: done,
  };
}

/**
 * One call, one retry on 429/5xx with a fixed backoff, none on any other 4xx: a malformed
 * request is our bug and retrying it only spends money. The returned `latencyMs` is the
 * successful attempt, measured over the whole stream.
 */
export async function complete(pipeline, messages, options = {}) {
  const { key, source } = readKey(options.env ?? process.env);
  const url = pipeline.endpoint;
  const idleMs = options.idleMs ?? IDLE_MS;
  const totalMs = options.totalMs ?? TOTAL_MS;
  const body = JSON.stringify({
    model: pipeline.apiModel,
    messages,
    max_tokens: pipeline.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  });
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const controller = new AbortController();
    let fired = null;
    const total = setTimeout(() => {
      if (fired === null) {
        fired = 'total';
        controller.abort();
      }
    }, totalMs);
    let idle = null;
    const armIdle = () => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        if (fired === null) {
          fired = 'idle';
          controller.abort();
        }
      }, idleMs);
    };
    try {
      armIdle();
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        if (fired !== null) {
          throw stallError(fired, { finishReason: null, chars: 0, reasoningChars: 0 });
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new LaneError('PROVIDER_UNREACHABLE', `the provider did not answer: ${reason}`);
      }
      if (!response.ok) {
        const status = response.status;
        const snippet = (await boundedText(response)).replace(/\s+/gu, ' ').trim().slice(0, SNIPPET);
        const retryable = status === 429 || status >= 500;
        if (!retryable || attempt >= 2) {
          throw new LaneError(
            `PROVIDER_HTTP_${String(status)}`,
            `the provider refused the call (${String(status)})${snippet === '' ? '' : `: ${snippet}`}`,
          );
        }
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 30_000) : BACKOFF_MS);
        continue;
      }
      const answer = await readStream(response, { armIdle, fired: () => fired });
      return {
        text: answer.text,
        empty: answer.empty,
        finishReason: answer.finishReason,
        reasoningTokens: answer.reasoningTokens,
        streamComplete: answer.streamComplete,
        responseModel: answer.responseModel,
        usage: answer.usage,
        latencyMs: Date.now() - started,
        attempts: attempt,
        keySource: source,
      };
    } finally {
      clearTimeout(total);
      if (idle !== null) clearTimeout(idle);
    }
  }
}
