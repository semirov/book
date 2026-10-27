/**
 * BOOK-109 — the freshness policy, asserted at the wire.
 *
 * The owner's phone kept printing the old ch01/ch67 while this host served the canon, so the
 * two permissions a cache lives on — `max-age` (do not ask) and `304` (keep what you have) —
 * are gone from everything but Vite's content-hashed assets. This file is the contract:
 * `/api/*` and HTML are `no-store` and never answer `304`; the static files whose tags follow
 * their own bytes — `/assets/*`, the fonts, `theme.js`, the favicon — keep the static policy
 * and *are* allowed to revalidate. None of them carries a sentence of the book (BOOK-109
 * review: stripping their validators re-downloaded 172 KB of woff2 on every page load).
 *
 * Every assertion is a header or a body on a real `inject`, never a unit call on the hook:
 * the defect this pass removes was in what the wire said, not in what a function returned.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

const CHAPTER_ONE = longProse(['Первый абзац главы.']);
const CHAPTER_LAST = longProse(['Последний абзац книги.'], 'Последняя глава');

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

async function boot(options: { ui?: boolean; env?: Record<string, string> } = {}): Promise<void> {
  fixture = createFixture({ 'ch01.md': CHAPTER_ONE, 'ch67.md': CHAPTER_LAST });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

  webDist = mkdtempSync(join(tmpdir(), 'book-web-'));
  if (options.ui !== false) {
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'assets', 'app-b7c1.js'), 'console.log("книга");', 'utf8');
    // The three public files the SPA needs before it paints: none of them is prose.
    mkdirSync(join(webDist, 'fonts'), { recursive: true });
    writeFileSync(join(webDist, 'fonts', 'troll-regular.woff2'), 'wOF2-not-really-a-font', 'utf8');
    writeFileSync(join(webDist, 'theme.js'), 'document.documentElement.dataset.theme = "day";', 'utf8');
    writeFileSync(join(webDist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
  }

  app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: webDist,
      PORT: '8080',
      ...options.env,
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
  });
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  webDist = null;
});

/** The newest moment the log holds — the `at` a history chapter is asked for. */
function lastHseq(): number {
  return (fixture!.db.prepare('SELECT COALESCE(MAX(hseq), 0) AS h FROM events').get() as { h: number }).h;
}

describe('the API is never cached (BOOK-109)', () => {
  it('answers every book read no-store, and keeps the ETags that name a representation', async () => {
    await boot();
    const urls = [
      '/api/chapters/1',
      '/api/chapters/67',
      '/api/state',
      '/api/chapters',
      '/api/front',
      '/api/cost',
      '/api/authors',
      '/api/history/timeline',
      '/api/history/status',
      '/api/analytics',
      '/api/changes',
    ];
    for (const url of urls) {
      const response = await app!.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['cache-control'], url).toBe('no-store');
    }

    // The tags stay: they name the projection, a proxy log still reads them, and a client may
    // compare them — they just never licence a reuse.
    for (const url of ['/api/chapters/1', '/api/chapters/67', '/api/state', '/api/front', '/api/cost']) {
      const response = await app!.inject({ method: 'GET', url });
      expect(response.headers.etag, url).toBeTruthy();
    }
  });

  it('answers a conditional request with the body, never a 304 (BOOK-6: the frame must arrive)', async () => {
    await boot();
    const hseq = lastHseq();
    const urls = [
      '/api/chapters/1',
      '/api/state',
      '/api/front',
      '/api/cost',
      `/api/history/chapters/1?at=${hseq}`,
    ];
    for (const url of urls) {
      const first = await app!.inject({ method: 'GET', url });
      expect(first.statusCode, url).toBe(200);
      const etag = String(first.headers.etag);
      expect(etag, url).not.toBe('undefined');

      // Both conditional hints at once, the way a browser sends them after a hard reload.
      const again = await app!.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': etag, 'cache-control': 'no-cache' },
      });
      expect(again.statusCode, url).toBe(200);
      expect(again.headers.etag, url).toBe(etag);
      // The full body, on every repeat: a client must never be told its copy is still right.
      expect(again.body, url).toBe(first.body);
      expect(again.body.length, url).toBeGreaterThan(0);
    }
  });

  it('marks a chapter 404 and an unknown API path no-store too', async () => {
    await boot();
    const notWritten = await app!.inject({ method: 'GET', url: '/api/chapters/40' });
    expect(notWritten.statusCode).toBe(404);
    expect(notWritten.json()).toMatchObject({ code: 'NOT_WRITTEN' });
    expect(notWritten.headers['cache-control']).toBe('no-store');

    const unknown = await app!.inject({ method: 'GET', url: '/api/nope' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['cache-control']).toBe('no-store');
  });
});

describe('HTML is never cached (BOOK-109)', () => {
  it('serves the shell, the two static pages and an unknown path as no-store text/html', async () => {
    await boot();
    for (const url of ['/', '/privacy', '/rules', '/ch-8']) {
      const response = await app!.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(String(response.headers['content-type']), url).toContain('text/html');
      // The static layer's own `public, max-age=0` (and the not-found handler's `no-cache`)
      // is overridden above the route: a shell that names a build may not outlive the build.
      expect(response.headers['cache-control'], url).toBe('no-store');
    }
  });

  it('answers a conditional request for the shell with the shell, never a 304', async () => {
    await boot();
    const first = await app!.inject({ method: 'GET', url: '/' });
    const etag = String(first.headers.etag);
    expect(etag).not.toBe('undefined');
    const again = await app!.inject({
      method: 'GET',
      url: '/',
      headers: { 'if-none-match': etag, 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain('книга');
  });

  it('marks /healthz no-store', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('does not let a proxy store the missing-build answer', async () => {
    await boot({ ui: false });
    const response = await app!.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'UI_NOT_BUILT' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('the hashed assets keep the static policy (BOOK-109, BOOK-119)', () => {
  it('serves /assets unchanged and immutable — the name is the hash, so the bytes cannot drift', async () => {
    await boot();
    const asset = await app!.inject({ method: 'GET', url: '/assets/app-b7c1.js' });
    expect(asset.statusCode).toBe(200);
    // BOOK-119: a year plus `immutable`. The same URL can only mean the same bytes, in this
    // release and in every retained one.
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.etag).toBeTruthy();
    expect(asset.body).toContain('книга');

    // The name is a hash of the bytes: revalidating it costs nothing and can only be right.
    const conditional = await app!.inject({
      method: 'GET',
      url: '/assets/app-b7c1.js',
      headers: { 'if-none-match': String(asset.headers.etag) },
    });
    expect(conditional.statusCode).toBe(304);
  });
});

describe('the prose-free static files keep revalidation (BOOK-109 review)', () => {
  it('answers 304 for theme.js, a font and the favicon, and 200 for the prose surfaces', async () => {
    await boot();
    // Each of these is fetched before the first paint on every load; their tags follow their
    // bytes, so revalidating is a real saving and cannot keep stale prose alive.
    for (const url of ['/theme.js', '/fonts/troll-regular.woff2', '/favicon.svg']) {
      const first = await app!.inject({ method: 'GET', url });
      expect(first.statusCode, url).toBe(200);
      expect(first.headers.etag, url).toBeTruthy();
      // BOOK-119 leaves these alone: `max-age=0` + ETag, so the pre-paint script and the fonts
      // revalidate on every load — a 304 here is right and cannot keep stale prose alive.
      expect(first.headers['cache-control'], url).toBe('public, max-age=0');
      const conditional = await app!.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': String(first.headers.etag) },
      });
      expect(conditional.statusCode, url).toBe(304);
    }

    // The prose surfaces are unchanged by that exception: a conditional request gets the body.
    for (const url of ['/api/state', '/']) {
      const first = await app!.inject({ method: 'GET', url });
      const conditional = await app!.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': String(first.headers.etag) },
      });
      expect(conditional.statusCode, url).toBe(200);
      expect(conditional.body, url).toBe(first.body);
    }
  });
});

describe('the API statuses are never stored (BOOK-109 review)', () => {
  it('marks a 401 no-store', async () => {
    await boot();
    // Own-only surface, anonymous caller: the answer is `session.ts`'s 401, and the policy
    // covers it as well — an auth answer must not be replayed from any cache.
    const response = await app!.inject({ method: 'GET', url: '/api/authors/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('marks a 429 no-store, with its retry window intact', async () => {
    // The real limiter, with a window of one read: the second poll is refused.
    await boot({ env: { READ_PER_MINUTE: '1' } });
    expect((await app!.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
    const blocked = await app!.inject({ method: 'GET', url: '/api/state' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('the FB2 export revalidates, and only because its tag is its content (BOOK-60, BOOK-138)', () => {
  it('answers a matching If-None-Match with a 304, no build and no export date', async () => {
    await boot();
    const first = await app!.inject({ method: 'GET', url: '/book.fb2' });
    expect(first.statusCode).toBe(200);
    // BOOK-138: the export states its own policy — `no-store`, like the rest of the book, so
    // the browser keeps nothing. The tag stays, so this explicit revalidation is still truthful.
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['x-export-date']).toBeTruthy();

    const conditional = await app!.inject({
      method: 'GET',
      url: '/book.fb2',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.headers.etag).toBe(first.headers.etag);
    expect(conditional.headers['cache-control']).toBe('no-store');
    // The moment is a property of a body; this answer produced none.
    expect(conditional.headers['x-export-date']).toBeUndefined();
    expect(conditional.body).toBe('');
  });
});
