/**
 * One call, one attempt, and the provider's own cache counters (BOOK-DOC-65 §6).
 *
 * Why this is not `writer/provider.ts`: that module is right for a pass — it retries a
 * transport failure once and reduces `usage` to `{in, out, cachedIn}`. The experiment may do
 * neither. **No retry** is a property of the measurement (a second attempt is a second charge
 * and a different row), and the C matrix needs `prompt_cache_miss_tokens`, which the writer's
 * `PipelineUsage` deliberately drops.
 *
 * Everything else is the writer's wire, unchanged: `POST` the pinned endpoint, the pinned wire
 * model, the messages, `max_tokens`, `stream: true`, `stream_options: {include_usage: true}`,
 * no sampling overrides. Only `choices[0].delta.content` is prose; `reasoning_content` is
 * thought and never enters a chapter. The message an error carries is a code — never the key,
 * never a header, never a response body.
 */

import type { PipelineUsage } from '../../server/src/writer/pipeline.ts';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type WireUsage = {
  promptTokens: number;
  completionTokens: number;
  /** `prompt_cache_hit_tokens` (0 when the provider reports none). */
  cacheHit: number;
  /** `prompt_cache_miss_tokens`; `-1` when the provider reports none (unknown, not zero). */
  cacheMiss: number;
  /** `prompt_tokens_details.cached_tokens`, when present. */
  cachedDetails: number | null;
};

export type WireRequest = {
  endpoint: string;
  apiKey: string;
  apiModel: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs: number;
  stallMs?: number;
};

export type WireResult = {
  text: string;
  finishReason: string | null;
  usage: WireUsage;
  latencyMs: number;
  responseModel: string | null;
};

export type WireCode =
  | 'CALL_TIMEOUT'
  | 'CALL_UNREACHABLE'
  | `CALL_HTTP_${number}`
  | 'CALL_SHAPE';

export class WireError extends Error {
  readonly code: WireCode;

  constructor(code: WireCode) {
    super(`call: ${code}`);
    this.name = 'WireError';
    this.code = code;
  }
}

/** A stream that goes quiet for this long is dead; the same bound the writer uses. */
export const DEFAULT_STALL_MS = 90_000;

type Frame = Record<string, unknown>;

function record(value: unknown): Frame | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Frame) : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function finishReasonOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length > 0 ? reason : null;
}

type Acc = {
  parts: string[];
  finishReason: string | null;
  usage: Frame | null;
  model: string | null;
  done: boolean;
};

function usageOf(raw: Frame | null): WireUsage {
  const promptTokens = count(raw?.prompt_tokens);
  const completionTokens = count(raw?.completion_tokens);
  if (promptTokens === null || completionTokens === null) throw new WireError('CALL_SHAPE');
  const details = record(raw?.prompt_tokens_details);
  const cacheHit = count(raw?.prompt_cache_hit_tokens) ?? count(details?.cached_tokens) ?? 0;
  const cacheMiss = count(raw?.prompt_cache_miss_tokens);
  return {
    promptTokens,
    completionTokens,
    cacheHit: Math.min(cacheHit, promptTokens),
    cacheMiss: cacheMiss === null ? -1 : Math.min(cacheMiss, promptTokens),
    cachedDetails: count(details?.cached_tokens),
  };
}

function consumeLine(line: string, acc: Acc): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload.length === 0) return;
  if (payload === '[DONE]') {
    acc.done = true;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new WireError('CALL_SHAPE');
  }
  const frame = record(parsed);
  if (frame === null) throw new WireError('CALL_SHAPE');
  if (acc.model === null && typeof frame.model === 'string' && frame.model.trim().length > 0) {
    acc.model = frame.model.trim();
  }
  const usage = record(frame.usage);
  if (usage !== null) acc.usage = usage;
  const choices = frame.choices;
  if (!Array.isArray(choices)) return;
  const choice = record(choices[0]);
  if (choice === null) return;
  const reason = finishReasonOf(choice.finish_reason);
  if (reason !== null && acc.finishReason === null) acc.finishReason = reason;
  const delta = record(choice.delta);
  const content = delta?.content;
  if (typeof content === 'string' && content.length > 0) acc.parts.push(content);
}

function drain(buffer: string, acc: Acc, final: boolean): string {
  const lines = buffer.split('\n');
  const rest = final ? '' : (lines.pop() ?? '');
  for (const line of lines) consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line, acc);
  return rest;
}

const STALL: unique symbol = Symbol('stall');

async function readOrStall<T>(pending: Promise<T>, stallMs: number, onStall: () => void): Promise<T | typeof STALL> {
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

/** One attempt. A transport failure, a bad status or a shape the reader cannot read is final. */
export async function callOnce(request: WireRequest, transport: typeof fetch = fetch): Promise<WireResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const stallMs = request.stallMs ?? DEFAULT_STALL_MS;
  const acc: Acc = { parts: [], finishReason: null, usage: null, model: null, done: false };

  try {
    let response: Response;
    try {
      response = await transport(request.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${request.apiKey}` },
        body: JSON.stringify({
          model: request.apiModel,
          messages: request.messages,
          max_tokens: request.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
    } catch {
      throw new WireError(timedOut ? 'CALL_TIMEOUT' : 'CALL_UNREACHABLE');
    }
    // Status only: the body is provider text at best and a leaked credential at worst.
    if (!response.ok) throw new WireError(`CALL_HTTP_${response.status}` as WireCode);
    const body = response.body;
    if (body === null) throw new WireError('CALL_SHAPE');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stalled = false;
    try {
      while (!acc.done) {
        const pending = reader.read();
        pending.catch(() => {});
        const step = await readOrStall(pending, stallMs, () => {
          stalled = true;
          controller.abort();
        });
        if (step === STALL) break;
        if (step.done) {
          buffer += decoder.decode();
          drain(buffer, acc, true);
          break;
        }
        buffer += decoder.decode(step.value, { stream: true });
        buffer = drain(buffer, acc, false);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (stalled) throw new WireError('CALL_TIMEOUT');

    return {
      text: acc.parts.join(''),
      finishReason: acc.finishReason,
      usage: usageOf(acc.usage),
      latencyMs: Date.now() - startedAt,
      responseModel: acc.model ?? request.apiModel,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The writer's shape, for the metrics that are priced the same way the lane prices them. */
export function pipelineUsage(usage: WireUsage): PipelineUsage {
  return { in: usage.promptTokens, out: usage.completionTokens, cachedIn: usage.cacheHit };
}

/** Every character a request carries; the cap's projection reads this, never the text. */
export function requestChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}
