import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthorsCountDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * `GET /api/front` — page 1's one call (§9, BOOK-24).
 *
 * Two properties are load-bearing here and are asserted, not described: the ETag names the
 * byline count (a cached page cannot pin a stale N), and a conditional request is answered
 * **without** the whole-book aggregate — the byline is measured once per book state, after
 * the comparison. The route also takes the read budget with the other book reads.
 */

const CHAPTER_ONE = longProse(['Первый абзац главы.']);
const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';
const FRONT = `Без названия\n\n${ABOUT}\n`;

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

async function boot(
  options: {
    chapters?: Record<string, string>;
    env?: Record<string, string>;
    /** Test seam: the byline reader, so a test can count the measurements the route makes. */
    authorsCount?: () => AuthorsCountDto;
  } = {},
): Promise<Fixture> {
  fixture = createFixture(options.chapters ?? {});
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

  webDist = mkdtempSync(join(tmpdir(), 'book-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');

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
    ...(options.authorsCount === undefined ? {} : { authorsCount: options.authorsCount }),
  });
  return fixture;
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  webDist = null;
});

/** A byline reader that counts its own calls: the spy that proves a 304 costs nothing. */
function countingByline(): { measure: () => AuthorsCountDto; calls: () => number } {
  let count = 0;
  const measure = vi.fn((): AuthorsCountDto => {
    count += 1;
    return { count, measuredAt: new Date(Date.UTC(2026, 9, 25, 12, 0, count)).toISOString() };
  });
  return { measure, calls: () => measure.mock.calls.length };
}

describe('GET /api/front', () => {
  it('serves the live title, page 2, the TOC and the imprint in one call', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': CHAPTER_ONE } });
    const response = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"front-1-a0"');
    const body = response.json();
    expect(body).toMatchObject({
      title: 'Без названия',
      about: ABOUT,
      rev: 1,
      imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
      authors: { count: 0, measuredAt: expect.any(String) },
    });
    expect(body.toc).toHaveLength(67);
    expect(body.toc[0]).toMatchObject({ part: 1, n: 1, title: 'Заголовок главы', written: true, rev: 1 });
    expect(body.toc[66]).toMatchObject({ part: 4, n: 67, title: null, written: false, rev: 0 });
  });

  it('answers 304 for a matching ETag', async () => {
    await boot({ chapters: { '00-front.md': FRONT } });
    const first = await app!.inject({ method: 'GET', url: '/api/front' });
    const second = await app!.inject({
      method: 'GET',
      url: '/api/front',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
  });

  it('measures the byline once and answers every conditional request without measuring again', async () => {
    const byline = countingByline();
    await boot({ chapters: { '00-front.md': FRONT }, authorsCount: byline.measure });

    const first = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ authors: { count: 1 } });
    // The ETag carries the count, so a cached page cannot pin a byline that changed.
    expect(first.headers.etag).toBe('"front-1-a1"');
    expect(byline.calls()).toBe(1);

    // A 304 costs nothing: ten conditional polls, still one measurement.
    for (let poll = 0; poll < 10; poll += 1) {
      const again = await app!.inject({
        method: 'GET',
        url: '/api/front',
        headers: { 'if-none-match': first.headers.etag as string },
      });
      expect(again.statusCode).toBe(304);
    }
    expect(byline.calls()).toBe(1);
  });

  it('measures again after the book changes, and an old ETag gets a 200 with the new count', async () => {
    const byline = countingByline();
    const fresh = await boot({ chapters: { '00-front.md': FRONT }, authorsCount: byline.measure });
    const first = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(first.headers.etag).toBe('"front-1-a1"');

    // A revision is what can move the byline: the next front request measures it afresh.
    fresh.write('ch02.md', CHAPTER_ONE);
    reconcile(fresh.db, { bookRoot: fresh.root, dataDir: fresh.dataDir });

    const second = await app!.inject({
      method: 'GET',
      url: '/api/front',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).toBe('"front-1-a2"');
    expect(second.json()).toMatchObject({ authors: { count: 2 } });
    expect(byline.calls()).toBe(2);
  });

  it('is honest at launch when there is no first sheet: null title and page 2', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/front' });
    const body = response.json();
    expect(body).toMatchObject({ title: null, about: null, rev: 0 });
    expect(body.toc).toHaveLength(67);
    expect(body.toc.every((entry: { written: boolean }) => !entry.written)).toBe(true);
  });
});

describe('the title page takes the read budget (BOOK-24)', () => {
  it('refuses a poll once the per-network window is spent', async () => {
    await boot({ chapters: { '00-front.md': FRONT }, env: { READ_PER_MINUTE: '2' } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await app!.inject({ method: 'GET', url: '/api/front' })).statusCode).toBe(200);
    }
    const blocked = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    // A query string is not a way around the budget.
    expect((await app!.inject({ method: 'GET', url: '/api/front?v=2' })).statusCode).toBe(429);
  });
});
