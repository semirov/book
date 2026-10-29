import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOTAL_CHAPTERS, type AuthorsCountDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { AGE_ACK_COOKIE, createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * `GET /api/front` — page 1's one call (§9, BOOK-24).
 *
 * Two properties are load-bearing here and are asserted, not described: the ETag names the
 * byline count (a cached page cannot pin a stale N), and a repeated request is answered
 * **without** the whole-book aggregate — the byline is measured once per book state and
 * remembered. BOOK-109 removed the `304`: every answer carries the full body, so the memo is
 * what a poll saves, not a conditional-request short cut. The route also takes the read
 * budget with the other book reads.
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

/** A byline reader that counts its own calls: the spy that proves a repeat costs no measurement. */
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
    const body = response.json();
    // BOOK-60: the edition number is part of the validator, beside the front revision and N.
    expect(response.headers.etag).toBe(`"front-1-a0-e${body.revision}"`);
    expect(body).toMatchObject({
      title: 'Без названия',
      about: ABOUT,
      rev: 1,
      imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
      authors: { count: 0, measuredAt: expect.any(String) },
      // BOOK-126: no DONATE_URL in this boot, so the footer's gift row has nothing to print.
      donateUrl: null,
    });
    expect(body.toc).toHaveLength(TOTAL_CHAPTERS);
    // The opening and the finale stand outside the parts (BOOK-155).
    expect(body.toc[0]).toMatchObject({ part: null, n: 1, title: 'Заголовок главы', written: true, rev: 1 });
    expect(body.toc[TOTAL_CHAPTERS - 1]).toMatchObject({
      part: null,
      n: TOTAL_CHAPTERS,
      title: null,
      written: false,
      rev: 0,
    });
  });

  // BOOK-109: the tag is a name, not a licence to reuse — the answer is always a 200 with the
  // page, because the TOC, the title and the byline may have moved under the same ETag.
  it('answers a matching If-None-Match with the page, never a 304', async () => {
    await boot({ chapters: { '00-front.md': FRONT } });
    const first = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(first.headers['cache-control']).toBe('no-store');
    const second = await app!.inject({
      method: 'GET',
      url: '/api/front',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.json()).toMatchObject({ title: 'Без названия', rev: 1 });
  });

  it('measures the byline once and answers every repeat from the memo, not the aggregate', async () => {
    const byline = countingByline();
    await boot({ chapters: { '00-front.md': FRONT }, authorsCount: byline.measure });

    const first = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ authors: { count: 1 } });
    // The ETag carries the count, so a cached page cannot pin a byline that changed.
    expect(first.headers.etag).toBe(`"front-1-a1-e${first.json().revision}"`);
    expect(byline.calls()).toBe(1);

    // Ten polls of a book state that did not move: ten full bodies, one measurement. The memo
    // is what makes a poll cheap now that no 304 short-cuts it (BOOK-109).
    for (let poll = 0; poll < 10; poll += 1) {
      const again = await app!.inject({
        method: 'GET',
        url: '/api/front',
        headers: { 'if-none-match': first.headers.etag as string },
      });
      expect(again.statusCode).toBe(200);
      expect(again.headers.etag).toBe(first.headers.etag);
      expect(again.json()).toMatchObject({ authors: { count: 1 }, title: 'Без названия' });
    }
    expect(byline.calls()).toBe(1);
  });

  it('measures again after the book changes, and an old ETag gets a 200 with the new count', async () => {
    const byline = countingByline();
    const fresh = await boot({ chapters: { '00-front.md': FRONT }, authorsCount: byline.measure });
    const first = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(first.headers.etag).toBe(`"front-1-a1-e${first.json().revision}"`);

    // A revision is what can move the byline: the next front request measures it afresh.
    fresh.write('ch02.md', CHAPTER_ONE);
    reconcile(fresh.db, { bookRoot: fresh.root, dataDir: fresh.dataDir });

    const second = await app!.inject({
      method: 'GET',
      url: '/api/front',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).toBe(`"front-1-a2-e${second.json().revision}"`);
    // The chapter write is an edition change, so the tag moved with the byline.
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(second.json()).toMatchObject({ authors: { count: 2 } });
    expect(byline.calls()).toBe(2);
  });

  it('carries the boot-validated gift link (BOOK-126)', async () => {
    await boot({
      chapters: { '00-front.md': FRONT },
      env: { DONATE_URL: 'https://t.tb.ru/pm_short/11T50nT6AL' },
    });
    const body = (await app!.inject({ method: 'GET', url: '/api/front' })).json();
    // The value is the owner's, unchanged, and it travels on the payload that already exists.
    expect(body.donateUrl).toBe('https://t.tb.ru/pm_short/11T50nT6AL');
  });

  it('carries null when the configured link is refused, never a dead href (BOOK-126)', async () => {
    // The boot warns once about the refused value (BOOK-126); the warning itself is pinned in
    // `config.test.ts`, so here it is only silenced.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await boot({ chapters: { '00-front.md': FRONT }, env: { DONATE_URL: 'https://evil.tb.ru/x' } });
      const body = (await app!.inject({ method: 'GET', url: '/api/front' })).json();
      expect(body.donateUrl).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('carries the edition number the FB2 file writes as document-info/version (BOOK-60)', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': CHAPTER_ONE } });
    const front = (await app!.inject({ method: 'GET', url: '/api/front' })).json();
    expect(typeof front.revision).toBe('number');
    // A 52-bit decimal: a valid FB2 `version` value (the full hash, not this number, is the
    // name the ETag carries).
    expect(front.revision).toBeGreaterThanOrEqual(0);
    expect(front.revision).toBeLessThanOrEqual(4_503_599_627_370_495);

    const file = await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/book.fb2' });
    expect(file.statusCode).toBe(200);
    const version = /<version>(\d+)<\/version>/u.exec(file.body)?.[1];
    expect(Number(version)).toBe(front.revision);
  });

  it('is honest at launch when there is no first sheet: null title and page 2', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/front' });
    const body = response.json();
    expect(body).toMatchObject({ title: null, about: null, rev: 0 });
    expect(body.toc).toHaveLength(TOTAL_CHAPTERS);
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
