/**
 * The provider call (BOOK-117 §5–6), with an injected transport: the happy path maps the usage
 * (including the prompt-cache field) and the finish reason, the retry is exactly one and only for
 * transport/429/5xx (`length` is an answer, never a retry), a shape the caller cannot use is
 * `PROVIDER_SHAPE`, and the key travels in the header — never in the URL, never in an error.
 */

import { describe, expect, it } from 'vitest';

import {
  ProviderError,
  callProvider,
  type FetchLike,
  type ProviderRequest,
} from '../../src/writer/provider.ts';

const KEY = 'sk-provider-test-key-never-print-me-1b2c3d';
const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const API_MODEL = 'deepseek-v4-pro';

type Call = { url: string; init: RequestInit };

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A transport that answers from a script and records every call. */
function scripted(...answers: Array<Response | (() => Promise<Response>)>): { transport: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const transport: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === undefined) throw new Error('the script ran out of answers');
    return typeof answer === 'function' ? answer() : answer;
  };
  return { transport, calls };
}

function answer(content = 'Глава первая.\n\nОчередь стояла с утра.'): Record<string, unknown> {
  return {
    model: 'deepseek-v4-pro-20261027',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 60 },
  };
}

/** The same body with `finish_reason` replaced (`undefined` removes the field entirely). */
function withFinish(finish: unknown): Record<string, unknown> {
  const body = answer();
  const choices = body.choices as Array<Record<string, unknown>>;
  const choice = choices[0];
  if (choice === undefined) throw new Error('the fixture has no choice');
  if (finish === undefined) delete choice.finish_reason;
  else choice.finish_reason = finish;
  return body;
}

const fastSleep = () => Promise.resolve();

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('the call was expected to fail');
}

describe('callProvider — one plain completion', () => {
  it('posts the pinned model and the messages, and maps text, model and usage', async () => {
    let tick = 1_000;
    const { transport, calls } = scripted(json(answer()));
    const result = await callProvider(request(), { transport, sleep: fastSleep, now: () => (tick += 50) });

    expect(result.text).toBe('Глава первая.\n\nОчередь стояла с утра.');
    expect(result.responseModel).toBe('deepseek-v4-pro-20261027');
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
    // No sampling overrides: the pin decides the model, nothing else where a test could look.
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: API_MODEL,
      messages: request().messages,
      max_tokens: 16_000,
      stream: false,
    });
  });

  it('reads the OpenAI cached-token shape too', async () => {
    const body = answer();
    body.usage = { prompt_tokens: 200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 120 } };
    const { transport } = scripted(json(body));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.usage).toEqual({ in: 200, out: 10, cachedIn: 120 });
  });
});

describe('callProvider — the finish reason is the provider’s own statement', () => {
  it('maps length: the token cap was hit, and that is not retried', async () => {
    const { transport, calls } = scripted(json(withFinish('length')));
    const result = await callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 });
    expect(result.finishReason).toBe('length');
    // A cut answer is the model's answer, not a transport fault: one request, no second one.
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('maps stop', async () => {
    const { transport } = scripted(json(withFinish('stop')));
    const result = await callProvider(request(), { transport, sleep: fastSleep });
    expect(result.finishReason).toBe('stop');
  });

  it('is null when the provider did not report one', async () => {
    const absent = await callProvider(request(), {
      transport: scripted(json(withFinish(undefined))).transport,
      sleep: fastSleep,
    });
    expect(absent.finishReason).toBeNull();

    const explicit = await callProvider(request(), {
      transport: scripted(json(withFinish(null))).transport,
      sleep: fastSleep,
    });
    expect(explicit.finishReason).toBeNull();

    // A blank or a non-string is "said nothing", never a code the gate could misread.
    const blank = await callProvider(request(), {
      transport: scripted(json(withFinish('  '))).transport,
      sleep: fastSleep,
    });
    expect(blank.finishReason).toBeNull();

    const numeric = await callProvider(request(), {
      transport: scripted(json(withFinish(7))).transport,
      sleep: fastSleep,
    });
    expect(numeric.finishReason).toBeNull();
  });
});

describe('callProvider — the retry is one and it is narrow', () => {
  it('retries a transport failure once and then succeeds', async () => {
    const { transport, calls } = scripted(
      () => Promise.reject(new TypeError('fetch failed')),
      json(answer()),
    );
    const result = await callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 });
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('gives up after one retry on transport failure', async () => {
    const { transport, calls } = scripted(() => Promise.reject(new TypeError('fetch failed')));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_UNREACHABLE');
    expect(failure.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('retries a 5xx once and then succeeds', async () => {
    const { transport, calls } = scripted(json({ error: 'busy' }, 503), json(answer()));
    const result = await callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 });
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('stops after the second 429', async () => {
    const { transport, calls } = scripted(json({ error: 'slow down' }, 429));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_HTTP_429');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    const { transport, calls } = scripted(json({ error: 'bad request' }, 400));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.code).toBe('PROVIDER_HTTP_400');
    expect(failure.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('times out, retries once and reports PROVIDER_TIMEOUT', async () => {
    const calls: Call[] = [];
    const transport: FetchLike = (_url, init) => {
      calls.push({ url: _url, init });
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
});

describe('callProvider — an answer it cannot use', () => {
  it('refuses a body with no choices as PROVIDER_SHAPE', async () => {
    const { transport } = scripted(json({ choices: [] }));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep }));
    expect(failure.code).toBe('PROVIDER_SHAPE');
    expect(failure.attempts).toBe(1);
  });

  it('refuses a body with no usage: an uncharged pass is a lie, not a zero', async () => {
    const body = answer();
    delete body.usage;
    const { transport } = scripted(json(body));
    expect((await failureOf(callProvider(request(), { transport, sleep: fastSleep }))).code).toBe('PROVIDER_SHAPE');
  });

  it('refuses an empty completion', async () => {
    const { transport } = scripted(json(answer('   ')));
    expect((await failureOf(callProvider(request(), { transport, sleep: fastSleep }))).code).toBe('PROVIDER_SHAPE');
  });

  it('refuses a 200 whose body is not JSON', async () => {
    const { transport } = scripted(new Response('not json', { status: 200 }));
    expect((await failureOf(callProvider(request(), { transport, sleep: fastSleep }))).code).toBe('PROVIDER_SHAPE');
  });

  it('never puts the key or the response body in an error', async () => {
    const { transport } = scripted(json({ error: `the key ${KEY} is wrong` }, 500));
    const failure = await failureOf(callProvider(request(), { transport, sleep: fastSleep, backoffMs: 0 }));
    expect(failure.message).not.toContain(KEY);
    expect(failure.message).not.toContain('is wrong');
    expect(failure.message).toBe('provider: PROVIDER_HTTP_500');
  });
});
