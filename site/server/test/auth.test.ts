import { afterEach, describe, expect, it } from 'vitest';

import { bootComments, commentBody, type Harness } from './comments/helpers.ts';

/**
 * M5 acceptance: the Yandex flow works end to end against a **stub IdP** (no production
 * credential exists), the callback validates `state`, and the session it mints is the only
 * thing that lets a reader write.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

type StubCall = { url: string; init?: RequestInit };

function idpStub(options: { tokenStatus?: number; profile?: unknown } = {}): {
  fetch: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const impl = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    if (String(input).endsWith('/token')) {
      if (options.tokenStatus !== undefined && options.tokenStatus !== 200) {
        return new Response('provider error body', { status: options.tokenStatus });
      }
      return Response.json({ access_token: 'access-1', expires_in: 31_536_000 });
    }
    return Response.json(
      options.profile ?? { id: 'yandex-2002', login: 'anya', display_name: 'Аня Петрова', default_email: 'a@b.c' },
    );
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function headersOf(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === 'string' ? [raw] : [];
}

function cookieValue(setCookies: string[], name: string): string | null {
  for (const line of setCookies) {
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1).split(';')[0] ?? '';
    return value.length === 0 ? null : value;
  }
  return null;
}

function post(h: Harness, cookie: string) {
  return h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { origin: h.config.publicOrigin, 'content-type': 'application/json', cookie: `book_session=${cookie}` },
    payload: commentBody({ body: 'Замечание от вошедшего читателя.' }),
  });
}

describe('Yandex OAuth', () => {
  it('answers OAUTH_UNCONFIGURED when the owner has not supplied credentials yet', async () => {
    const h = await bootComments({ yandexConfigured: false });
    harness = h;
    const response = await h.app.inject({ method: 'GET', url: '/auth/yandex/start' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'OAUTH_UNCONFIGURED' });
  });

  it('starts the flow with a signed state cookie and no token in the URL', async () => {
    const h = await bootComments();
    harness = h;
    const response = await h.app.inject({ method: 'GET', url: '/auth/yandex/start' });
    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(location.origin).toBe('https://idp.test');
    expect(location.pathname).toBe('/authorize');
    expect(location.searchParams.get('client_id')).toBe('test-client');
    expect(location.searchParams.get('redirect_uri')).toBe('https://book.test/auth/yandex/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    // Asked for explicitly: the profile call needs `display_name`/`login` (§9).
    expect(location.searchParams.get('scope')).toBe('login:info');
    // A redirect that carries a nonce is never cached by the browser or a proxy.
    expect(response.headers['cache-control']).toBe('no-store');
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();

    const cookies = headersOf(response);
    expect(cookies.some((line) => line.startsWith('book_oauth='))).toBe(true);
    expect(cookies.join('\n')).toContain('HttpOnly');
    expect(cookies.join('\n')).toContain('Path=/auth');
    expect(cookieValue(cookies, 'book_oauth')).toBe(state);
  });

  it('completes the flow against a stub IdP and mints a usable session', async () => {
    const stub = idpStub();
    const h = await bootComments({ oauthFetch: stub.fetch });
    harness = h;

    const start = await h.app.inject({ method: 'GET', url: '/auth/yandex/start' });
    const state = cookieValue(headersOf(start), 'book_oauth');
    expect(state).toBeTruthy();

    const callback = await h.app.inject({
      method: 'GET',
      url: `/auth/yandex/callback?code=code-1&state=${encodeURIComponent(state ?? '')}`,
      headers: { cookie: `book_oauth=${state}` },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    const sessionCookie = cookieValue(headersOf(callback), 'book_session');
    expect(sessionCookie).toBeTruthy();

    // Identity and session rows exist; the Yandex subject is stored, never rendered.
    const identity = h.db
      .prepare('SELECT * FROM identities WHERE yandex_sub = ?')
      .get('yandex-2002') as { display_name: string } | undefined;
    expect(identity?.display_name).toBe('Аня Петрова');
    const session = h.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions s
          JOIN identities i ON i.id = s.identity_id
         WHERE i.yandex_sub = 'yandex-2002' AND s.revoked_at IS NULL`,
      )
      .get() as { n: number };
    expect(session.n).toBe(1);

    // The token exchange happened server-side, with both credentials in the form body.
    const tokenCall = stub.calls.find((call) => call.url.endsWith('/token'));
    expect(tokenCall).toBeDefined();
    const body = String(tokenCall?.init?.body ?? '');
    expect(body).toContain('code=code-1');
    expect(body).toContain('client_id=test-client');
    expect(body).toContain('client_secret=test-secret');

    const posted = await post(h, sessionCookie ?? '');
    expect(posted.statusCode).toBe(201);
    expect(posted.json().comment.author).toBe('Аня Петрова');
  });

  it('refuses a callback whose state does not match the cookie, and stores no session', async () => {
    const stub = idpStub();
    const h = await bootComments({ oauthFetch: stub.fetch });
    harness = h;
    const start = await h.app.inject({ method: 'GET', url: '/auth/yandex/start' });
    const state = cookieValue(headersOf(start), 'book_oauth');

    const forged = await h.app.inject({
      method: 'GET',
      url: '/auth/yandex/callback?code=code-1&state=forged-state',
      headers: { cookie: `book_oauth=${state}` },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ code: 'OAUTH_STATE' });
    expect(forged.headers['cache-control']).toBe('no-store');
    expect(
      h.db.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN identities i ON i.id = s.identity_id WHERE i.yandex_sub = 'yandex-2002'`).get(),
    ).toEqual({ n: 0 });
    expect(stub.calls).toHaveLength(0);
  });

  it('never leaks a provider failure and mints nothing', async () => {
    const stub = idpStub({ tokenStatus: 401 });
    const h = await bootComments({ oauthFetch: stub.fetch });
    harness = h;
    const start = await h.app.inject({ method: 'GET', url: '/auth/yandex/start' });
    const state = cookieValue(headersOf(start), 'book_oauth');
    const callback = await h.app.inject({
      method: 'GET',
      url: `/auth/yandex/callback?code=code-1&state=${encodeURIComponent(state ?? '')}`,
      headers: { cookie: `book_oauth=${state}` },
    });
    expect(callback.statusCode).toBe(502);
    const body = callback.body;
    expect(body).toContain('OAUTH_FAILED');
    expect(body).not.toContain('provider error body');
    expect(body).not.toContain('test-secret');
    expect(
      h.db.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN identities i ON i.id = s.identity_id WHERE i.yandex_sub = 'yandex-2002'`).get(),
    ).toEqual({ n: 0 });
  });

  it('rates the start endpoint per IP so the callback cannot be spammed', async () => {
    const h = await bootComments();
    harness = h;
    for (let index = 0; index < h.config.oauthStartPerHour; index += 1) {
      expect((await h.app.inject({ method: 'GET', url: '/auth/yandex/start' })).statusCode).toBe(302);
    }
    const limited = await h.app.inject({ method: 'GET', url: '/auth/yandex/start' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['cache-control']).toBe('no-store');

    // §14: the counter is keyed by a hash of the network, never by the address.
    const keys = (
      h.db.prepare(`SELECT key FROM rate_events WHERE key LIKE 'oauth:ip:%'`).all() as Array<{ key: string }>
    ).map((row) => row.key);
    expect(keys[0]).toMatch(/^oauth:ip:[0-9a-f]{64}$/u);
  });

  it('logs the callback path, never the `code` or the `state` in its query', async () => {
    const lines: string[] = [];
    const h = await bootComments({ logStream: { write: (line) => lines.push(line) } });
    harness = h;

    const start = await h.app.inject({ method: 'GET', url: '/auth/yandex/start' });
    const state = cookieValue(headersOf(start), 'book_oauth') ?? '';
    expect(state.length).toBeGreaterThan(0);

    const code = 'one-use-authorization-code';
    await h.app.inject({
      method: 'GET',
      url: `/auth/yandex/callback?code=${code}&state=${encodeURIComponent(state)}`,
      headers: { cookie: `book_oauth=${state}` },
    });
    // onResponse fires after the reply is sent; one turn of the loop is enough for the line.
    await new Promise((resolve) => setImmediate(resolve));

    const output = lines.join('\n');
    expect(output).toContain('/auth/yandex/callback');
    expect(output).toContain('"statusCode"');
    expect(output).not.toContain(code);
    expect(output).not.toContain(state);
    expect(output).not.toMatch(/[?&](code|state)=/u);
    expect(output).not.toContain('book_oauth=');
  });

  it('logs out: the session is revoked and the cookie cleared', async () => {
    const h = await bootComments();
    harness = h;
    const logout = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: h.config.publicOrigin, 'content-type': 'application/json', cookie: `book_session=${h.cookie}` },
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    expect(headersOf(logout).join('\n')).toContain('book_session=');
    expect(headersOf(logout).join('\n')).toContain('Max-Age=0');

    const after = await post(h, h.cookie);
    expect(after.statusCode).toBe(401);
  });

  it('rejects logout from a foreign origin', async () => {
    const h = await bootComments();
    harness = h;
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie: `book_session=${h.cookie}` },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});
