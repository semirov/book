/**
 * The provider lane's test doubles (BOOK-117 §5–6, BOOK-219): a request, a scripted transport, the
 * SSE frames the endpoint really sends, and the failure reader. They live apart from
 * `provider.test.ts` because `arch` bounds a file at 500 lines — and a second copy of a wire frame
 * in another test file would drift from this one.
 */

import { ProviderError, type FetchLike, type ProviderRequest } from '../../src/writer/provider.ts';

export const KEY = 'sk-provider-test-key-never-print-me-1b2c3d';
export const ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const API_MODEL = 'deepseek-v4-pro';
export const STREAM_MODEL = 'deepseek-v4-pro-20261027';
export const PROSE = 'Глава первая.\n\nОчередь стояла с утра.';

export type Call = { url: string; init: RequestInit };

export function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    endpoint: ENDPOINT,
    apiKey: KEY,
    apiModel: API_MODEL,
    messages: [
      { role: 'system', content: 'роль' },
      { role: 'user', content: 'задание' },
    ],
    maxTokens: 16_000,
    timeoutMs: 5_000,
    ...overrides,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A transport that answers from a script and records every call (the last answer repeats). */
export function scripted(...answers: Array<Response | (() => Promise<Response>)>): { transport: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const transport: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === undefined) throw new Error('the script ran out of answers');
    return typeof answer === 'function' ? answer() : answer;
  };
  return { transport, calls };
}

/** An SSE stream delivered as given chunks: what the wire looks like at a chunk boundary. */
export function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** The measured failure: chunks arrive, then the body is reset (`ECONNRESET`). */
export function streamThenReset(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.error(new TypeError('terminated', { cause: { errno: -54, code: 'ECONNRESET', syscall: 'read' } }));
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

/** A generation that stops sending: the stream stays open and never yields again. */
export function streamThenHang(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) return new Promise<void>(() => {});
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

export function streamResponse(body: ReadableStream<Uint8Array> | null, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

export function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** One prose delta, as the provider streams it. */
export function prose(content: string): string {
  return sse({ id: 'chatcmpl-1', model: STREAM_MODEL, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
}

/** A reasoning delta: thought, not text, and never a chapter. */
export function thought(content: string): string {
  return sse({
    id: 'chatcmpl-1',
    model: STREAM_MODEL,
    choices: [{ index: 0, delta: { reasoning_content: content, content: null }, finish_reason: null }],
  });
}

export function finish(reason: unknown): string {
  return sse({ id: 'chatcmpl-1', model: STREAM_MODEL, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

/** The final frame: no choices at all, the usage the ledger is charged from. */
export function usageFrame(usage: Record<string, unknown>): string {
  return sse({ id: 'chatcmpl-1', model: STREAM_MODEL, choices: [], usage });
}

export const DONE = 'data: [DONE]\n\n';

export const USAGE = { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 60 };

/** A whole normal stream: thought, prose, the finish frame, the usage frame, `[DONE]`. */
export function normalStream(): string[] {
  return [thought('Рассуждаю.'), prose('Глава первая.\n\n'), prose('Очередь стояла с утра.'), finish('stop'), usageFrame(USAGE), DONE];
}

export const fastSleep = () => Promise.resolve();

/** The body of a request, as the wire saw it. */
export function bodyOf(call: Call | undefined): Record<string, unknown> {
  if (call === undefined) throw new Error('no call recorded');
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** A plain-body answer with no prose: the second, unstreamed attempt of an empty stream. */
export function emptyAnswer(): Response {
  return json({ id: 'chatcmpl-2', model: STREAM_MODEL, choices: [{ index: 0, message: { content: '' }, finish_reason: 'stop' }] });
}

export async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('the call was expected to fail');
}

