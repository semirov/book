import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, getChapter, getChapters, getState } from './api.ts';

const realFetch = globalThis.fetch;

function respond(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function respondText(body: string, status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'text/plain' } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

describe('getState / getChapters', () => {
  it('reads JSON over REST', async () => {
    respond({ version: 3, chapters: { total: 67 } });
    await expect(getState()).resolves.toMatchObject({ version: 3 });

    respond([{ n: 1, written: false }]);
    await expect(getChapters()).resolves.toEqual([{ n: 1, written: false }]);
  });

  it('asks for JSON', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await getState();
    expect(spy).toHaveBeenCalledWith('/api/state', { headers: { accept: 'application/json' } });
  });
});

describe('getChapter', () => {
  it('returns the prose', async () => {
    respond({ n: 1, rev: 1, blocks: [] });
    await expect(getChapter(1)).resolves.toMatchObject({ n: 1, rev: 1 });
  });

  it('treats 404 as an unwritten slot, not a failure', async () => {
    respond({ code: 'NOT_WRITTEN', message: 'chapter is not written yet' }, 404);
    await expect(getChapter(40)).resolves.toBeNull();
  });

  it('keeps the server code and status in the error', async () => {
    respond({ code: 'INVALID', message: 'bad request' }, 400);
    await expect(getChapter(1)).rejects.toMatchObject({ status: 400, code: 'INVALID' });
  });

  it('falls back to HTTP_<status> for a non-JSON error', async () => {
    respondText('upstream down', 502);
    const error = await getChapter(1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: 'HTTP_502' });
  });
});
