/**
 * The provider call, read as an SSE stream (BOOK-117 §5–6), with an injected transport: the happy
 * path assembles the deltas, the provider's own `finish_reason` and the usage frame (the one with
 * `choices: []`), ignoring a reasoning delta; the retry is exactly one and only before any content
 * arrives, or for transport/429/5xx (a half-read generation is never re-run); a stream the caller
 * cannot use is `PROVIDER_SHAPE`; a silent stream is `PROVIDER_TIMEOUT` inside the stall window;
 * and the key travels in the header — never in the URL, never in the body, never in an error.
 *
 * BOOK-219 adds the two rules the pass that died on a good answer taught: a **good answer without
 * a usage object is charged** (the estimate, `estimated: true`, never a shape failure), and an
 * **empty** answer is asked once more as a plain body (`stream: false`) before it is `SHAPE`.
 */

import { describe, expect, it } from 'vitest';

import {
  ANSWER_CHARS_PER_TOKEN,
  DEFAULT_STALL_MS,
  PROMPT_CHARS_PER_TOKEN,
  callProvider,
  estimateUsage,
  type FetchLike,
} from '../../src/writer/provider.ts';
import {
  API_MODEL,
  DONE,
  ENDPOINT,
  KEY,
  PROSE,
  STREAM_MODEL,
  USAGE,
  bodyOf,
  emptyAnswer,
  failureOf,
  fastSleep,
  finish,
  json,
  normalStream,
  prose,
  request,
  scripted,
  sse,
  streamOf,
  streamResponse,
  streamThenHang,
  streamThenReset,
  usageFrame,
  type Call,
} from './sse.ts';

describe('callProvider — one streamed completion', () => {
  it('posts the pinned model, the messages and the stream envelope; the key is a header, never the URL or the body', async () => {
    let tick = 1_000;
    const { transport, calls } = scripted(streamResponse(streamOf(normalStream())));
    const result = await callProvider(request(), { transport, sleep: fastSleep, now: () => (tick += 50) });

    expect(result.text).toBe(PROSE);
    expect(result.responseModel).toBe(STREAM_MODEL);
    expect(result.usage).toEqual({ in: 100, out: 40, cachedIn: 60 });
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBe(50);
    expect(result.finishReason).toBe('stop');

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('no call recorded');
    expect(call.url).toBe(ENDPOINT);
    expect(call.url).not.toContain(KEY);
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${KEY}`);

    const sent = String(call.init.body);
    expect(sent).not.toContain(KEY);
    // The envelope, and nothing else: the pin decides the model, no sampling overrides, and the
    // usage frame is what the ledger is charged from — a diagnostic fact, so it is pinned here.
    expect(JSON.parse(sent)).toEqual({
      model: API_MODEL,
      messages: request().messages,
      max_tokens: 16_000,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('takes the usage from the last frame and clamps the cached prefix to the prompt', async () => {
    const body = [prose('Абзац.'), finish('stop'), usageFrame({ prompt_tokens: 100, completion_tokens: 900, prompt_cache_hit_tokens: 500 }), DONE];
    const { transport } = scripted(streamResponse(streamOf(body)));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.usage).toEqual({ in: 100, out: 900, cachedIn: 100 });
  });

  it('reads the OpenAI cached-token shape too', async () => {
    const body = [
      prose('Абзац.'),
      finish('stop'),
      usageFrame({ prompt_tokens: 200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 120 } }),
      DONE,
    ];
    const { transport } = scripted(streamResponse(streamOf(body)));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.usage).toEqual({ in: 200, out: 10, cachedIn: 120 });
  });

  it('ignores keep-alive, event and comment lines, a frame with no choices, and a [DONE] without a newline', async () => {
    const body = [
      ': keep-alive\n\n',
      'event: message\n',
      'data:\n\n',
      sse({ id: 'chatcmpl-1' }),
      prose('Абзац.'),
      finish('stop'),
      usageFrame(USAGE),
      'data: [DONE]',
    ];
    const { transport } = scripted(streamResponse(streamOf(body)));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.text).toBe('Абзац.');
    expect(result.usage).toEqual({ in: 100, out: 40, cachedIn: 60 });
    expect(result.finishReason).toBe('stop');
  });

  it('reads CRLF frames', async () => {
    const body = [prose('Абзац.'), finish('stop'), usageFrame(USAGE), DONE].map((frame) => frame.replaceAll('\n', '\r\n'));
    const { transport } = scripted(streamResponse(streamOf(body)));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.text).toBe('Абзац.');
    expect(result.usage).toEqual({ in: 100, out: 40, cachedIn: 60 });
    expect(result.finishReason).toBe('stop');
  });

  it('reassembles a frame split across two chunks', async () => {
    const wire = [`data: ${JSON.stringify({ model: STREAM_MODEL, choices: [{ index: 0, delta: { content: 'Сло' }}] })}\n\n`, finish('stop'), usageFrame(USAGE), DONE].join('');
    const body = [wire.slice(0, 19), wire.slice(19)];
    const { transport } = scripted(streamResponse(streamOf(body)));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.text).toBe('Сло');
    expect(result.usage).toEqual({ in: 100, out: 40, cachedIn: 60 });
    expect(result.finishReason).toBe('stop');
  });

  it('is null when no frame reported a finish reason', async () => {
    for (const absent of [null, '  ', 7]) {
      const body = [prose('Абзац.'), finish(absent), usageFrame(USAGE), DONE];
      const { transport } = scripted(streamResponse(streamOf(body)));
      const result = await callProvider(request(), { transport, sleep: fastSleep });
      expect(result.finishReason).toBeNull();
    }
  });

  it('falls back to the pinned api model when the stream names none, and charges no cache read', async () => {
    const body = [
      sse({ choices: [{ index: 0, delta: { content: 'Абзац.' } }] }),
      sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40 } }),
      DONE,
    ];
    const { transport } = scripted(streamResponse(streamOf(body)));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.responseModel).toBe(API_MODEL);
    expect(result.usage).toEqual({ in: 100, out: 40, cachedIn: 0 });
  });

  it('maps length: the token cap was hit, and that is not retried', async () => {
    const body = [prose('Обрывок'), finish('length'), usageFrame(USAGE), DONE];
    const { transport, calls } = scripted(streamResponse(streamOf(body)));
    const result = await callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 });
    expect(result.finishReason).toBe('length');
    // A cut answer is the model's answer, not a transport fault: one request, no second one.
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('callProvider — a stream that breaks mid-answer', () => {
  it('retries a connection failure that never produced a response, then gives up as PROVIDER_UNREACHABLE', async () => {
    const { transport, calls } = scripted(() => Promise.reject(new TypeError('fetch failed')));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_UNREACHABLE');
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('retries once when it breaks before any content, then gives up as PROVIDER_UNREACHABLE', async () => {
    const { transport, calls } = scripted(async () => streamResponse(streamThenReset([])));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_UNREACHABLE');
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('succeeds on the second attempt when the reset came before any content', async () => {
    const { transport, calls } = scripted(
      async () => streamResponse(streamThenReset([])),
      async () => streamResponse(streamOf(normalStream())),
    );
    const result = await callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 });
    expect(result.text).toBe(PROSE);
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a reset after content: a half-read generation is final', async () => {
    const { transport, calls } = scripted(async () => streamResponse(streamThenReset([prose('Глава первая.\n\n')])));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_UNREACHABLE');
    expect(failure.attempts).toBe(1);
    // The retry would re-send the whole prompt and double the cost of a long answer.
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 400', async () => {
    const { transport, calls } = scripted(json({ error: 'bad request' }, 400));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_HTTP_400');
    expect(failure.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 once and then succeeds (with the real, zero-millisecond backoff)', async () => {
    const { transport, calls } = scripted(json({ error: 'slow down' }, 429), streamResponse(streamOf(normalStream())));
    const result = await callProvider(request(), { transport, backoffMs: 0 });
    expect(result.attempts).toBe(2);
    expect(result.text).toBe(PROSE);
    expect(calls).toHaveLength(2);
  });

  it('stops after the second 429', async () => {
    const { transport, calls } = scripted(json({ error: 'slow down' }, 429));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_HTTP_429');
    expect(calls).toHaveLength(2);
  });

  it('retries a 5xx once and then succeeds', async () => {
    const { transport, calls } = scripted(json({ error: 'busy' }, 503), streamResponse(streamOf(normalStream())));
    const result = await callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 });
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('gives up after the second 500', async () => {
    const { transport, calls } = scripted(json({ error: 'busy' }, 500));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_HTTP_500');
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('never puts the key or the response body in an error', async () => {
    const { transport } = scripted(json({ error: `the key ${KEY} is wrong` }, 500));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.message).not.toContain(KEY);
    expect(failure.message).not.toContain('is wrong');
    expect(failure.message).toBe('provider: PROVIDER_HTTP_500');
  });
});

describe('callProvider — a stream it cannot use', () => {
  it('refuses a stream with no data frame as PROVIDER_SHAPE after the one unstreamed retry', async () => {
    const { transport, calls } = scripted(streamResponse(streamOf([])), emptyAnswer());
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_SHAPE');
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('refuses a 200 with no body at all, after the same retry', async () => {
    const { transport, calls } = scripted(streamResponse(null), emptyAnswer());
    expect((await failureOf(callProvider(request(), { transport, sleep: fastSleep }))).code).toBe('PROVIDER_SHAPE');
    expect(calls).toHaveLength(2);
  });

  it('charges a good answer that arrived without a usage frame, and says the number is an estimate', async () => {
    const { transport, calls } = scripted(streamResponse(streamOf([prose('Абзац.'), finish('stop'), DONE])));
    const result = await callProvider(request(), { transport, sleep: fastSleep });

    // BOOK-219: the text is the answer; the money is read off the bytes, never refused.
    expect(result.text).toBe('Абзац.');
    expect(result.usage.estimated).toBe(true);
    expect(calls).toHaveLength(1);
    const promptChars = request().messages.reduce((sum, message) => sum + message.content.length, 0);
    expect(result.usage.in).toBe(Math.ceil(promptChars / PROMPT_CHARS_PER_TOKEN));
    expect(result.usage.out).toBe(Math.ceil('Абзац.'.length / ANSWER_CHARS_PER_TOKEN));
    expect(result.usage.cachedIn).toBe(0);
    expect(result.usage.in).toBeGreaterThan(0);
    expect(result.usage.out).toBeGreaterThan(0);
  });

  it('charges the same estimate when a usage frame is there but unusable', async () => {
    const body = [prose('Абзац.'), finish('stop'), usageFrame({ prompt_tokens: 'many', completion_tokens: 40 }), DONE];
    const { transport } = scripted(streamResponse(streamOf(body)));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.text).toBe('Абзац.');
    expect(result.usage).toEqual(estimateUsage(request().messages, 'Абзац.'));
  });

  it('asks an empty answer once more without a stream, and only then gives up', async () => {
    const { transport, calls } = scripted(streamResponse(streamOf([finish('stop'), DONE])), emptyAnswer());
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));

    expect(failure.code).toBe('PROVIDER_SHAPE');
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    // The first is the stream the pass always asks for; the second is a plain body.
    expect(bodyOf(calls[0])).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(bodyOf(calls[1])).toMatchObject({ stream: false });
    expect(bodyOf(calls[1]).stream_options).toBeUndefined();
  });

  it('succeeds on the unstreamed retry when the stream was empty but the body answers', async () => {
    const answered = json({
      id: 'chatcmpl-2',
      model: STREAM_MODEL,
      choices: [{ index: 0, message: { content: 'Абзац.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 90, completion_tokens: 12 },
    });
    const { transport, calls } = scripted(streamResponse(streamOf([DONE])), answered);
    const result = await callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 });
    expect(result.text).toBe('Абзац.');
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ in: 90, out: 12, cachedIn: 0 });
    expect(bodyOf(calls[1]).stream).toBe(false);
  });

  it('refuses a malformed data frame as PROVIDER_SHAPE, and does not retry it', async () => {
    const { transport, calls } = scripted(streamResponse(streamOf(['data: {"model": \n\n'])));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_SHAPE');
    expect(failure.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('refuses a frame that is valid JSON but not an object', async () => {
    const { transport } = scripted(streamResponse(streamOf(['data: 5\n\n'])));
    expect((await failureOf(callProvider(request(), { transport, sleep: fastSleep }))).code).toBe('PROVIDER_SHAPE');
  });

  it('collects whitespace-only prose as no text at all', async () => {
    const body = [prose('   '), finish('stop'), usageFrame(USAGE), DONE];
    const blank = json({ choices: [{ index: 0, message: { content: '   ' } }] });
    const { transport, calls } = scripted(streamResponse(streamOf(body)), blank);
    expect((await failureOf(callProvider(request(), { transport, sleep: fastSleep }))).code).toBe('PROVIDER_SHAPE');
    expect(calls).toHaveLength(2);
  });
});

describe('callProvider — the stall guard', () => {
  it('defaults to 90 s', () => {
    expect(DEFAULT_STALL_MS).toBe(90_000);
  });

  it('aborts a stream that never yields as PROVIDER_TIMEOUT inside the window, and retries it once', async () => {
    const { transport, calls } = scripted(async () => streamResponse(streamThenHang([])));
    const started = Date.now();
    const failure = await failureOf(
      callProvider(request({ timeoutMs: 60_000 }), { transport, sleep: fastSleep, backoffMs: 0, stallMs: 20 }),
    );
    const elapsed = Date.now() - started;
    expect(failure.code).toBe('PROVIDER_TIMEOUT');
    // Nothing had arrived, so the retry is cheap: two attempts, still inside the injected window.
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('does not retry a stall after content: the generation is dead and half-read', async () => {
    const { transport, calls } = scripted(async () => streamResponse(streamThenHang([prose('Глава первая.\n\n')])));
    const failure = await failureOf(
      callProvider(request({ timeoutMs: 60_000 }), { transport, sleep: fastSleep, backoffMs: 0, stallMs: 20 }),
    );
    expect(failure.code).toBe('PROVIDER_TIMEOUT');
    expect(failure.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('callProvider — the total timeout', () => {
  it('times out, retries once and reports PROVIDER_TIMEOUT', async () => {
    const calls: Call[] = [];
    const transport: FetchLike = (url, init) => {
      calls.push({ url, init });
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };
    const failure = await failureOf(
      callProvider(request({ timeoutMs: 5 }), { transport, sleep: fastSleep, backoffMs: 0 }),
    );
    expect(failure.code).toBe('PROVIDER_TIMEOUT');
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('aborts a read in flight when the total timeout fires, before the stall window', async () => {
    const calls: Call[] = [];
    const transport: FetchLike = (url, init) => {
      calls.push({ url, init });
      // A real transport errors the body when the call's own signal aborts, mid-read.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return Promise.resolve(streamResponse(stream));
    };
    const failure = await failureOf(
      callProvider(request({ timeoutMs: 10 }), { transport, sleep: fastSleep, backoffMs: 0, stallMs: 60_000 }),
    );
    expect(failure.code).toBe('PROVIDER_TIMEOUT');
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });
});
