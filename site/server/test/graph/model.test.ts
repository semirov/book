/**
 * The extractor's one model call (BOOK-185, BOOK-DOC-77 §2).
 *
 * No network: the transport is a fake that answers with the frames the provider sends, so every
 * case here is a decision this module makes — assemble the stream, retry once or not at all,
 * refuse a key whose file another user can read. The fake is the only place a "500" exists.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TIMEOUT_MS,
  ModelConfigError,
  ModelError,
  complete,
  loadModelConfig,
  timeoutFromEnv,
  type FetchLike,
  type ModelConfig,
} from '../../src/graph/model.ts';

const encoder = new TextEncoder();

function contentFrame(text: string, model = 'deepseek-v4-flash'): unknown {
  return { model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

function finishFrame(reason: string): unknown {
  return { model: 'deepseek-v4-flash', choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

function usageFrame(prompt = 120, completion = 40, cached = 30): unknown {
  return {
    model: 'deepseek-v4-flash',
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } },
  };
}

function streamOf(frames: readonly unknown[], close = true): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      if (close) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Raw `data:` lines, so a broken frame is the thing under test. */
function rawStream(lines: readonly string[], close = true): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
      if (close) controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** A stream that sends its frames and then resets: the measured `ECONNRESET` mid-answer. */
function brokenAfter(frames: readonly unknown[]): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < frames.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[sent] ?? {})}\n\n`));
        sent += 1;
        return;
      }
      controller.error(new Error('terminated'));
    },
  });
  return new Response(body, { status: 200 });
}

const CONFIG: ModelConfig = {
  endpoint: 'https://example.invalid/chat/completions',
  model: 'deepseek-v4-flash',
  maxOutputTokens: 4096,
  apiKey: 'sk-secret-test-value',
  keySource: 'env',
};

const REQUEST = { messages: [{ role: 'system' as const, content: 'read' }, { role: 'user' as const, content: 'chapter' }] };

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempKeyFile(value: string, mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-model-key-'));
  tempDirs.push(dir);
  const path = join(dir, 'deepseek.key');
  writeFileSync(path, value, 'utf8');
  chmodSync(path, mode);
  return path;
}

describe('the answer is assembled from the stream', () => {
  it('joins the content frames and reads the final usage', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const transport: FetchLike = (url, init) => {
      seen.push({ url, init });
      return Promise.resolve(streamOf([contentFrame('{"facts":'), contentFrame('[]}'), finishFrame('stop'), usageFrame()]));
    };
    const result = await complete(CONFIG, { ...REQUEST, transport, now: () => 1_000 });

    expect(result.text).toBe('{"facts":[]}');
    expect(result.usage).toEqual({ in: 120, out: 40, cached: 30 });
    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.finishReason).toBe('stop');
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBe(0);

    const sent = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>;
    expect(sent.model).toBe('deepseek-v4-flash');
    expect(sent.max_tokens).toBe(4096);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(seen[0]?.init.headers).toMatchObject({ authorization: 'Bearer sk-secret-test-value' });
    // No sampling override: the pin is the only place a model may be configured.
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBeUndefined();
  });

  it('returns finish_reason "length" instead of throwing', async () => {
    const transport: FetchLike = () =>
      Promise.resolve(streamOf([finishFrame('length'), usageFrame(900, 4096, 0)]));
    const result = await complete(CONFIG, { ...REQUEST, transport });
    expect(result.finishReason).toBe('length');
    expect(result.text).toBe('');
  });

  it('assembles a stream that ends without the [DONE] marker', async () => {
    const transport: FetchLike = () =>
      Promise.resolve(rawStream([`data: ${JSON.stringify(contentFrame('{"facts":[]}'))}`, `data: ${JSON.stringify(usageFrame())}`]));
    const result = await complete(CONFIG, { ...REQUEST, transport });
    expect(result.text).toBe('{"facts":[]}');
    expect(result.usage.in).toBe(120);
  });

  it('refuses a broken frame mid-stream', async () => {
    const transport: FetchLike = () =>
      Promise.resolve(rawStream(['data: {"choices":', `data: ${JSON.stringify(contentFrame('{"facts":[]}'))}`]));
    await expect(complete(CONFIG, { ...REQUEST, transport })).rejects.toMatchObject({ code: 'MODEL_SHAPE' });
  });

  it('refuses a data frame that is not an object', async () => {
    const transport: FetchLike = () => Promise.resolve(rawStream(['data: 42', `data: ${JSON.stringify(usageFrame())}`]));
    await expect(complete(CONFIG, { ...REQUEST, transport })).rejects.toMatchObject({ code: 'MODEL_SHAPE' });
  });

  it('reports the timeout it enforced', async () => {
    const transport: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const error = await complete(CONFIG, { ...REQUEST, transport, timeoutMs: 5, sleep: () => Promise.resolve() }).catch(
      (raised: unknown) => raised,
    );
    expect(error).toMatchObject({ code: 'MODEL_TIMEOUT', attempts: 2 });
  });

  it('refuses a stream that reports no usage rather than charging zero', async () => {
    const transport: FetchLike = () => Promise.resolve(streamOf([contentFrame('{"facts":[]}')]));
    await expect(complete(CONFIG, { ...REQUEST, transport })).rejects.toMatchObject({
      code: 'MODEL_SHAPE',
      attempts: 1,
    });
  });
});

describe('the retry is ours and it is one', () => {
  it('retries a 500 once', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const transport: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response('upstream exploded', { status: 500 })
          : streamOf([contentFrame('{"facts":[]}'), finishFrame('stop'), usageFrame()]),
      );
    };
    const result = await complete(CONFIG, {
      ...REQUEST,
      transport,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const transport: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response('bad request', { status: 400 }));
    };
    const error = await complete(CONFIG, { ...REQUEST, transport }).catch((raised: unknown) => raised);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: 'MODEL_HTTP_400', attempts: 1 });
    expect(calls).toBe(1);
  });

  it('does not retry a stream that broke after content arrived', async () => {
    let calls = 0;
    const transport: FetchLike = () => {
      calls += 1;
      return Promise.resolve(brokenAfter([contentFrame('{"facts":['), contentFrame(']}')]));
    };
    const error = await complete(CONFIG, { ...REQUEST, transport }).catch((raised: unknown) => raised);
    expect(error).toMatchObject({ code: 'MODEL_UNREACHABLE', attempts: 1 });
    expect(calls).toBe(1);
  });

  it('retries a stream that broke before any content', async () => {
    let calls = 0;
    const transport: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? brokenAfter([]) : streamOf([contentFrame('{"facts":[]}'), finishFrame('stop'), usageFrame()]),
      );
    };
    const result = await complete(CONFIG, { ...REQUEST, transport, sleep: () => Promise.resolve() });
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('never prints the key in a failure', async () => {
    const transport: FetchLike = () => Promise.reject(new Error('connect failed'));
    const error = await complete(CONFIG, { ...REQUEST, transport, sleep: () => Promise.resolve() }).catch(
      (raised: unknown) => raised,
    );
    expect(error).toBeInstanceOf(ModelError);
    expect(String((error as Error).message)).not.toContain(CONFIG.apiKey);
    expect(JSON.stringify(error)).not.toContain(CONFIG.apiKey);
  });
});

describe('the call timeout', () => {
  it('defaults to a whole chapter and takes GRAPH_TIMEOUT_MS when it is a positive number', () => {
    expect(timeoutFromEnv({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutFromEnv({ GRAPH_TIMEOUT_MS: ' 900000 ' })).toBe(900_000);
    expect(timeoutFromEnv({ GRAPH_TIMEOUT_MS: '0' })).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutFromEnv({ GRAPH_TIMEOUT_MS: '-5' })).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutFromEnv({ GRAPH_TIMEOUT_MS: 'soon' })).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('the key never leaves its file or its header', () => {
  it('is missing when no variable names it', () => {
    const error = loadModelConfigAndCatch({});
    expect(error).toBeInstanceOf(ModelConfigError);
    expect(error).toMatchObject({ code: 'KEY_MISSING' });
    expect(messageOf(error)).toContain('DEEPSEEK_API_KEY_FILE');
  });

  it('is read from a 0600 file and never printed', () => {
    const path = tempKeyFile('sk-file-value\n', 0o600);
    const config = loadModelConfig({ DEEPSEEK_API_KEY_FILE: path });
    expect(config.apiKey).toBe('sk-file-value');
    expect(config.keySource).toBe('file');
    // The wire model is derived from the pin (`<provider>/<model>` → `<model>`), never a literal.
    expect(config.model).not.toContain('/');
    expect(config.endpoint).toMatch(/^https:\/\//u);
    expect(JSON.stringify(config)).not.toContain('sk-file-value');
  });

  it('is refused when the file is readable by group or others', () => {
    const path = tempKeyFile('sk-file-value\n', 0o644);
    const error = loadModelConfigAndCatch({ DEEPSEEK_API_KEY_FILE: path });
    expect(error).toBeInstanceOf(ModelConfigError);
    expect(error).toMatchObject({ code: 'KEY_MODE' });
    expect(messageOf(error)).toContain('DEEPSEEK_API_KEY_FILE');
    expect(messageOf(error)).not.toContain(path);
  });

  it('refuses an unreadable key file by name, never by value', () => {
    const error = loadModelConfigAndCatch({ DEEPSEEK_API_KEY_FILE: join(tmpdir(), 'no-such-book-key-file') });
    expect(error).toMatchObject({ code: 'KEY_MISSING' });
    expect(messageOf(error)).not.toContain(tmpdir());
  });

  it('is missing when the key file cannot be read', () => {
    const path = tempKeyFile('sk-file-value\n', 0o600);
    chmodSync(path, 0o000);
    const error = loadModelConfigAndCatch({ DEEPSEEK_API_KEY_FILE: path });
    expect(error).toMatchObject({ code: 'KEY_MISSING' });
  });

  it('refuses a pipeline pin that cannot be read', () => {
    const error = loadModelConfigAndCatch({
      DEEPSEEK_API_KEY: 'sk-dev-value',
      PIPELINE_PATH: join(tmpdir(), 'no-such-pipeline.json'),
    });
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('accepts the plain variable outside production and refuses it in production', () => {
    const dev = loadModelConfig({ DEEPSEEK_API_KEY: 'sk-dev-value' });
    expect(dev.keySource).toBe('env');
    expect(dev.apiKey).toBe('sk-dev-value');

    const error = loadModelConfigAndCatch({ NODE_ENV: 'production', DEEPSEEK_API_KEY: 'sk-dev-value' });
    expect(error).toMatchObject({ code: 'KEY_MISSING' });
    expect(messageOf(error)).not.toContain('sk-dev-value');
  });
});

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadModelConfigAndCatch(env: NodeJS.ProcessEnv): unknown {
  try {
    return loadModelConfig(env);
  } catch (error) {
    return error;
  }
}
