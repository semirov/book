import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  getChange,
  getChanges,
  getChapter,
  getChapters,
  getComments,
  getFront,
  getQueue,
  getState,
  postComment,
} from './api.ts';

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
    expect(spy).toHaveBeenCalledWith('/api/state', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  });
});

describe('the engine’s public reads (M4)', () => {
  it('reads the queue and the change list', async () => {
    respond({ depth: 3, byState: {}, head: null, processing: null, lastDecidedAt: null });
    await expect(getQueue()).resolves.toMatchObject({ depth: 3 });

    respond([{ id: 'chg_1', seq: 1, chapter: 8 }]);
    await expect(getChanges(3)).resolves.toEqual([{ id: 'chg_1', seq: 1, chapter: 8 }]);
  });

  it('asks for a bounded list and one change by id', async () => {
    const spy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await getChanges(500);
    expect(spy).toHaveBeenCalledWith('/api/changes?limit=50', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });

    respond({ id: 'chg_1', intent: '…' });
    await expect(getChange('chg_1')).resolves.toMatchObject({ id: 'chg_1' });

    respond({ code: 'NOT_FOUND', message: 'no such change' }, 404);
    await expect(getChange('chg_nope')).resolves.toBeNull();
  });
});

describe('getFront', () => {
  it('reads the live title and page 2 over REST', async () => {
    respond({ title: 'Земля', about: 'Аннотация', rev: 1, toc: [], imprint: {} });
    await expect(getFront()).resolves.toMatchObject({ title: 'Земля', about: 'Аннотация' });
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

describe('the comment thread (M5)', () => {
  it('reads one bounded page for a chapter', async () => {
    const spy = vi.fn(async () => new Response('{"items":[],"nextBefore":null}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await getComments({ chapter: 8, limit: 500 });
    expect(spy).toHaveBeenCalledWith('/api/comments?chapter=8&limit=50', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  });

  it('posts JSON with the CAPTCHA token and no author field', async () => {
    const spy = vi.fn(async () => new Response('{"comment":{"id":"cmt_1"}}', { status: 201 }));
    vi.stubGlobal('fetch', spy);
    await postComment({ chapter: 8, body: 'Тут дважды «намок».', captchaToken: 'token-1' });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/comments');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ chapter: 8, body: 'Тут дважды «намок».', captchaToken: 'token-1' });
    expect(payload).not.toHaveProperty('author');
  });

  it('keeps retryAfterMs and resetAt on a refusal', async () => {
    respond({ code: 'RATE_LIMITED', message: 'slow down', retryAfterMs: 90_000, resetAt: '2026-10-25T13:00:00Z' }, 429);
    const error = await postComment({ chapter: 8, body: 'Текст.', captchaToken: 't' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterMs: 90_000 });
    expect((error as ApiError).resetAt).toBe('2026-10-25T13:00:00Z');
  });
});
