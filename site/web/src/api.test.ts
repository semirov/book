import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  getAuthors,
  getChange,
  getChanges,
  getChapter,
  getChapters,
  getComment,
  getComments,
  getFront,
  getMyDecisions,
  getMyFilings,
  getMyPlace,
  getMyTrace,
  putMyPlace,
  getQueue,
  getState,
  postAuthorsHide,
  postComment,
  retryComment,
  reviseComment,
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
    respond({ version: 3, chapters: { total: 42 } });
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
    respond({ title: 'Название', about: 'Аннотация', rev: 1, toc: [], imprint: {} });
    await expect(getFront()).resolves.toMatchObject({ title: 'Название', about: 'Аннотация' });
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

describe('the reader’s own surfaces (BOOK-DOC-4)', () => {
  it('reads the authors list through the cache, and past it after a mutation', async () => {
    const spy = vi.fn(async () => new Response('{"contributors":[]}', { status: 200 }));
    vi.stubGlobal('fetch', spy);

    await getAuthors();
    await getAuthors({ fresh: true });

    expect(spy.mock.calls[0]).toEqual(['/api/authors', { credentials: 'same-origin', headers: { accept: 'application/json' } }]);
    // The route is `public, max-age=30`; the post-hide read must not come from the cache.
    expect(spy.mock.calls[1]).toEqual([
      '/api/authors',
      { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' },
    ]);
  });

  it('reads the own trace from a session-only path and posts the hide flag as JSON', async () => {
    const spy = vi.fn(async (url: string) =>
      url === '/api/authors/me'
        ? new Response('{"label":"Аня","hidden":false}', { status: 200 })
        : new Response('{"hidden":true,"authors":{"count":0,"measuredAt":"2026-10-25T12:00:00Z"}}', { status: 200 }),
    );
    vi.stubGlobal('fetch', spy);

    await expect(getMyTrace()).resolves.toMatchObject({ label: 'Аня', hidden: false });
    const result = await postAuthorsHide(true);
    expect(result).toEqual({ hidden: true, authors: { count: 0, measuredAt: '2026-10-25T12:00:00Z' } });

    const [url, init] = spy.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/authors/hide');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ hidden: true });
  });

  it('keeps the 401 code so the end matter can fall silent', async () => {
    respond({ code: 'UNAUTHENTICATED', message: 'войдите' }, 401);
    const error = await getMyTrace().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
});

describe('the reader’s own filings (BOOK-207)', () => {
  it('reads them from the own-only path, with no id in it', async () => {
    const spy = vi.fn(async () => new Response('{"items":[]}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await expect(getMyFilings()).resolves.toEqual({ items: [] });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    // Session only: no identity, no path parameter, no query.
    expect(url).toBe('/api/me/filings');
    expect(url).not.toContain('?');
    expect(init.credentials).toBe('same-origin');
  });
});

describe('the reader’s own decisions (BOOK-13)', () => {
  it('reads them from the own-only path, with no id in it', async () => {
    const spy = vi.fn(
      async () =>
        new Response('{"items":[],"open":["cmt_1"],"share":0}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', spy);
    await expect(getMyDecisions()).resolves.toEqual({ items: [], open: ['cmt_1'], share: 0 });
    expect(spy.mock.calls[0]).toEqual([
      '/api/me/decisions',
      { credentials: 'same-origin', headers: { accept: 'application/json' } },
    ]);
  });

  it('is refused for an anonymous visitor, and the caller keeps the code', async () => {
    respond({ code: 'UNAUTHENTICATED', message: 'войдите' }, 401);
    const error = await getMyDecisions().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
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

  it('posts JSON with no captcha field and no author field (BOOK-64)', async () => {
    const spy = vi.fn(async () => new Response('{"comment":{"id":"cmt_1"}}', { status: 201 }));
    vi.stubGlobal('fetch', spy);
    await postComment({ chapter: 8, body: 'Тут дважды «слово».' });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/comments');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ chapter: 8, body: 'Тут дважды «слово».' });
    // The gate is the session and the rate limits: no empty token, no captcha key at all.
    expect(payload).not.toHaveProperty('captchaToken');
    expect(payload).not.toHaveProperty('author');
  });

  it('keeps retryAfterMs and resetAt on a refusal', async () => {
    respond({ code: 'RATE_LIMITED', message: 'slow down', retryAfterMs: 90_000, resetAt: '2026-10-25T13:00:00Z' }, 429);
    const error = await postComment({ chapter: 8, body: 'Текст.' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterMs: 90_000 });
    expect((error as ApiError).resetAt).toBe('2026-10-25T13:00:00Z');
  });
});

describe('one filing by id, and the refusal that names it (BOOK-111)', () => {
  it('reads a filing by id, and 404 is a normal answer', async () => {
    const spy = vi.fn(async () => new Response('{"id":"cmt_1","chapter":9,"premise":true}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await expect(getComment('cmt_1')).resolves.toMatchObject({ id: 'cmt_1', premise: true });
    expect(spy).toHaveBeenCalledWith('/api/comments/cmt_1', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });

    respond({ code: 'NOT_FOUND', message: 'no such comment' }, 404);
    await expect(getComment('cmt_gone')).resolves.toBeNull();
  });

  it('keeps the duplicate commentId so the form can open the filing already sent', async () => {
    respond({ code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: 'cmt_1' }, 409);
    const error = await postComment({ chapter: 9, body: 'А как?' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'DUPLICATE', commentId: 'cmt_1' });
  });

  it('leaves commentId undefined when the refusal does not name a filing', async () => {
    respond({ code: 'INVALID', message: 'body must be a string' }, 400);
    const error = (await postComment({ chapter: 9, body: '' }).catch((caught: unknown) => caught)) as ApiError;
    expect(error.commentId).toBeUndefined();
  });
});

describe('the retry of a broken filing (owner, 2026-10-29)', () => {
  it('posts an empty body to the filing’s own retry path, and keeps the server’s refusal', async () => {
    const spy = vi.fn(async () => new Response('{"comment":{"id":"cmt_1","status":"new","retryable":false}}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await expect(retryComment('cmt_1')).resolves.toMatchObject({ comment: { id: 'cmt_1', status: 'new' } });

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/comments/cmt_1/retry');
    expect(init.method).toBe('POST');
    // Nothing travels: a retry re-arms the stored filing, so no text, anchor or chapter is sent.
    expect(init.body).toBe('{}');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });

    respond({ code: 'RETRY_NOT_OFFERED', message: 'повторить нельзя — по этому замечанию уже сказано по существу' }, 409);
    const refused = (await retryComment('cmt_1').catch((caught: unknown) => caught)) as ApiError;
    expect(refused).toMatchObject({ status: 409, code: 'RETRY_NOT_OFFERED' });
  });
});

describe('the revision of a refused filing (BOOK-158)', () => {
  it('posts the words to the filing’s own revise path, with no anchor in the body', async () => {
    const spy = vi.fn(async () => new Response('{"comment":{"id":"cmt_1","status":"new"}}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await expect(
      reviseComment('cmt_1', { body: 'Переписал: абзац начинается с действия.', proposedText: null }),
    ).resolves.toMatchObject({ comment: { id: 'cmt_1', status: 'new' } });

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/comments/cmt_1/revise');
    expect(init.method).toBe('POST');
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toEqual({ body: 'Переписал: абзац начинается с действия.', proposedText: null });
    expect(payload).not.toHaveProperty('blockId');
    expect(payload).not.toHaveProperty('baseRev');
  });

  it('keeps the wait and the day a refusal names', async () => {
    respond({ code: 'ATTEMPTS_EXHAUSTED', message: 'исчерпаны попытки — в следующий раз', reopenAt: '2026-10-29T00:00:00Z' }, 429);
    const exhausted = (await reviseComment('cmt_1', { body: 'Ещё раз.' }).catch((caught: unknown) => caught)) as ApiError;
    expect(exhausted).toMatchObject({ status: 429, code: 'ATTEMPTS_EXHAUSTED' });
    expect(exhausted.reopenAt).toBe('2026-10-29T00:00:00Z');

    respond({ code: 'REVISE_COOLDOWN', message: 'слишком быстро — попробуйте ещё раз чуть позже', retryAfterMs: 300_000 }, 429);
    const cooling = (await reviseComment('cmt_1', { body: 'Ещё раз.' }).catch((caught: unknown) => caught)) as ApiError;
    expect(cooling).toMatchObject({ code: 'REVISE_COOLDOWN', retryAfterMs: 300_000 });
    expect(cooling.reopenAt).toBeUndefined();
  });
});

describe('the reader’s place (BOOK-209)', () => {
  it('answers null for a reader who never left a place, and reads the DTO otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(getMyPlace()).resolves.toBeNull();

    const place = {
      chapter: 12,
      sentenceId: 'ch12#aabbccdd/s140',
      deltaPx: 12.5,
      at: '2026-10-29T08:00:00.000Z',
    };
    respond(place);
    await expect(getMyPlace()).resolves.toEqual(place);
  });

  it('puts exactly the four fields the route accepts, and no identity of any kind', async () => {
    const spy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', spy);
    const place = { chapter: 3, sentenceId: 'ch03#b12/p', deltaPx: 0, at: '2026-10-29T08:00:00.000Z' };
    await expect(putMyPlace(place)).resolves.toBeUndefined();

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/me/place');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual(place);
  });

  it('throws the route’s own refusal (BAD_PLACE) instead of retrying it', async () => {
    respond({ code: 'BAD_PLACE', message: 'место в книге не сохранено' }, 400);
    const error = (await putMyPlace({
      chapter: 3,
      sentenceId: 'ch03#b12/p',
      deltaPx: 0,
      at: '2026-10-29T08:00:00.000Z',
    }).catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'BAD_PLACE' });
  });
});
