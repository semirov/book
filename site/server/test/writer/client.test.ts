/**
 * The engine client (`docs/writer-lane.md` §3–§4): the bearer token stays in a header, a refusal
 * becomes a typed code, and a hung engine does not hang the writer.
 *
 * No network: the transport is injected, so every case here is a shape the engine can actually
 * produce — including a `401`, a `409` with a code the pass branches on, and a socket that never
 * answers.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { EngineRefusalError, ENGINE_TIMEOUT_MS, createEngineClient, type FetchLike } from '../../src/writer/client.ts';

const dirs: string[] = [];
const TOKEN = 'engine-token-never-print-9f21';

function tokenFile(contents = `${TOKEN}\n`): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-client-'));
  dirs.push(dir);
  const path = join(dir, 'engine.token');
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Recorded = { url: string; init: RequestInit };

function transportOf(answer: (request: Recorded) => Response | Promise<Response>): {
  fetch: FetchLike;
  seen: Recorded[];
} {
  const seen: Recorded[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      const request = { url, init };
      seen.push(request);
      return answer(request);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function refusalOf(run: () => Promise<unknown>): Promise<EngineRefusalError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineRefusalError);
    return error as EngineRefusalError;
  }
  throw new Error('expected a refusal');
}

describe('createEngineClient — the transport survives a busy engine', () => {
  it('gives the engine 60 s by default, not the old 10', async () => {
    expect(ENGINE_TIMEOUT_MS).toBe(60_000);
    // The cap the client actually applied is the one its refusal names — a test at 5 ms, so the
    // number in the message proves the wiring without waiting a real minute.
    const client = createEngineClient({
      baseUrl: 'http://127.0.0.1:9',
      tokenFile: tokenFile(),
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    expect((await client.state().catch((error: unknown) => error)) as {
      code: string;
      message: string;
    }).toMatchObject({ code: 'ENGINE_TIMEOUT', message: 'the engine did not answer within 5 ms' });
  });

  it('retries a transport failure once, because every call is idempotent', async () => {
    let attempts = 0;
    const { fetch, seen } = transportOf(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('fetch failed');
      return json({ ok: true, data: { status: 'running', tokens: {} } });
    });
    const client = createEngineClient({ baseUrl: 'http://127.0.0.1:9', tokenFile: tokenFile(), fetch });
    await expect(client.state()).resolves.toMatchObject({ status: 'running' });
    expect(seen).toHaveLength(2);
  });

  it('gives up after the second transport failure, with its own code and no URL', async () => {
    let attempts = 0;
    // Both attempts hang, and the transport's own error is a raw `fetch failed`: the pass must read
    // the client's code, because that is what the reader's sentence is built from.
    const hanging = createEngineClient({
      baseUrl: 'http://127.0.0.1:9',
      tokenFile: tokenFile(),
      timeoutMs: 5,
      fetch: (_url, init) => {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('fetch failed')));
        });
      },
    });
    const refusal = await refusalOf(() => hanging.state());
    expect(refusal.code).toBe('ENGINE_TIMEOUT');
    expect(refusal.message).toBe('the engine did not answer within 5 ms');
    expect(refusal.message).not.toContain('127.0.0.1');
    expect(attempts).toBe(2);
  });

  it('does not retry a refusal: a 4xx code is the engine’s answer', async () => {
    const { fetch, seen } = transportOf(() => json({ code: 'PASS_LEASED', message: 'занято' }, 409));
    const client = createEngineClient({ baseUrl: 'http://127.0.0.1:9', tokenFile: tokenFile(), fetch });
    expect((await refusalOf(() => client.pass(65, 'writer-test'))).code).toBe('PASS_LEASED');
    expect(seen).toHaveLength(1);
  });
});

describe('createEngineClient', () => {
  it('sends the token in the header and never in the URL', async () => {
    const { fetch, seen } = transportOf(() => json({ ok: true, data: { status: 'running', tokens: {} } }));
    const client = createEngineClient({ baseUrl: 'http://127.0.0.1:9/', tokenFile: tokenFile(), fetch });
    await client.state();

    const request = seen[0];
    expect(request?.url).toBe('http://127.0.0.1:9/internal/state');
    expect(request?.url).not.toContain(TOKEN);
    expect(request?.init.method).toBe('GET');
    const headers = request?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps a node-style refusal to the code the pass branches on', async () => {
    const { fetch } = transportOf(() => json({ code: 'CHAPTER_WRITTEN', message: 'глава 65 уже написана' }, 409));
    const client = createEngineClient({ baseUrl: 'http://127.0.0.1:9', tokenFile: tokenFile(), fetch });
    const refusal = await refusalOf(() => client.pass(65, 'writer-test'));
    expect(refusal.code).toBe('CHAPTER_WRITTEN');
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain('уже написана');
  });

  it('maps an unauthenticated answer and a body without ok', async () => {
    const unauthorized = createEngineClient({
      baseUrl: 'http://127.0.0.1:9',
      tokenFile: tokenFile(),
      fetch: async () => json({ code: 'UNAUTHORIZED', message: 'internal API: bearer token required' }, 401),
    });
    expect((await refusalOf(() => unauthorized.state())).code).toBe('UNAUTHORIZED');

    const silent = createEngineClient({
      baseUrl: 'http://127.0.0.1:9',
      tokenFile: tokenFile(),
      fetch: async () => json({ data: {} }),
    });
    expect((await refusalOf(() => silent.state())).code).toBe('ENGINE_REFUSED');
  });

  it('reports an unreachable engine and a timeout as their own codes', async () => {
    const unreachable = createEngineClient({
      baseUrl: 'http://127.0.0.1:9',
      tokenFile: tokenFile(),
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const refused = await refusalOf(() => unreachable.state());
    expect(refused.code).toBe('ENGINE_UNREACHABLE');
    expect(refused.message).not.toContain('127.0.0.1');

    const hanging = createEngineClient({
      baseUrl: 'http://127.0.0.1:9',
      tokenFile: tokenFile(),
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    expect((await refusalOf(() => hanging.state())).code).toBe('ENGINE_TIMEOUT');
  });

  it('refuses to build a client without a token, and never echoes its value', async () => {
    const missing = await refusalOf(async () => createEngineClient({ baseUrl: 'http://127.0.0.1:9' }));
    expect(missing.code).toBe('ENGINE_TOKEN_MISSING');
    expect(missing.message).not.toContain(TOKEN);

    const empty = await refusalOf(async () =>
      createEngineClient({ baseUrl: 'http://127.0.0.1:9', tokenFile: tokenFile('  \n') }),
    );
    expect(empty.code).toBe('ENGINE_TOKEN_MISSING');

    const gone = await refusalOf(async () =>
      createEngineClient({ baseUrl: 'http://127.0.0.1:9', tokenFile: join(tmpdir(), 'no-such-token-file') }),
    );
    expect(gone.message).toBe('ENGINE_TOKEN_FILE cannot be read');
  });

  it('posts the stage event it is given, unchanged', async () => {
    const { fetch, seen } = transportOf(() => json({ ok: true, data: { stageSeq: 3 } }));
    const client = createEngineClient({ baseUrl: 'http://127.0.0.1:9', tokenFile: tokenFile(), fetch });
    await client.stage({ passId: 'stp_1', stage: 'queued', summary: 'проход открыт', at: 1 });
    expect(seen[0]?.url).toBe('http://127.0.0.1:9/internal/stage');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      passId: 'stp_1',
      stage: 'queued',
      summary: 'проход открыт',
      at: 1,
    });
  });
});
