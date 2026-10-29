import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGE_COOKIE,
  AGE_MAX_AGE_SECONDS,
  FRAME_FIRST_SENTENCE,
  ageDateOf,
} from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { applyFrontFile } from '../src/ingest/applyFront.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * BOOK-225 — the rating is a server guard, not a painted layer.
 *
 * The prose route refuses **at the top of the handler**: without a live acknowledgement there
 * is no row read and no block in the body, so a client that asks harder than the page asks is
 * answered with a refusal either way. The one act that opens the text is `POST /api/age`, and
 * it is the server that writes the day — the page never mints its own. The catalog, the front
 * and the state stay open: the book must stay discoverable while gated.
 *
 * The clock is the app's seam (`now`), so every case here is a fixed day and not a moving one.
 */

const CHAPTER_ONE = longProse(['Первый абзац главы.']);
const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';
const FRONT = `Без названия\n\n${ABOUT}\n`;
/** The day the whole file runs on: the app's own clock, not the machine's. */
const TODAY = new Date('2026-10-29T09:30:00Z');
const TODAY_TEXT = '2026-10-29';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

async function boot(options: { chapters?: Record<string, string>; now?: Date; env?: Record<string, string> } = {}): Promise<Fixture> {
  fixture = createFixture(options.chapters ?? {});
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  if (options.chapters?.['00-front.md'] !== undefined) {
    applyFrontFile({
      db: fixture.db,
      dataDir: fixture.dataDir,
      raw: options.chapters['00-front.md'],
      mtimeMs: Date.now(),
      nowMs: Date.now(),
    });
  }

  webDist = mkdtempSync(join(tmpdir(), 'book-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');

  const now = options.now ?? TODAY;
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
    now: () => now,
  });
  return fixture;
}

/** The header a browser sends after `POST /api/age`: the one cookie, and nothing else. */
function cookieOf(day: string): string {
  return `${AGE_COOKIE}=${day}`;
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  webDist = null;
});

describe('GET /api/chapters/:n is refused before the prose exists for the reader', () => {
  it('answers 403 AGE_GATE when the cookie is missing, and the body carries no text', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': CHAPTER_ONE } });
    const response = await app!.inject({ method: 'GET', url: '/api/chapters/1' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      code: 'AGE_GATE',
      message: 'книга 18+ — сначала подтвердите, что вам есть 18',
    });
    // The refusal is the whole answer: not one block, not one sentence of the chapter.
    expect(response.body).not.toContain('Первый абзац главы.');
    expect(response.body).not.toContain('Заголовок главы');
    expect(response.headers['etag']).toBeUndefined();
    // The guard is the first thing the handler does: an unwritten slot answers the gate, not
    // `NOT_WRITTEN` — no row is read for a reader who has not answered.
    const unwritten = await app!.inject({ method: 'GET', url: '/api/chapters/40' });
    expect(unwritten.statusCode).toBe(403);
    expect(unwritten.json().code).toBe('AGE_GATE');
  });

  it('refuses a basis sentence the same way — ch01 and the finale are prose too', async () => {
    await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE } });
    const response = await app!.inject({ method: 'GET', url: '/api/chapters/1' });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('AGE_GATE');
    expect(response.body).not.toContain(FRAME_FIRST_SENTENCE);
  });

  it('treats a malformed, a future and a spent day as “not answered”', async () => {
    await boot({ chapters: { 'ch01.md': CHAPTER_ONE } });
    for (const day of [
      'not-a-date',
      '29.10.2026',
      '2026-02-30',
      // The site writes its own day, so a later one was not written here.
      '2026-10-30',
      // A year back is the bound: the cookie and the value expire together.
      '2025-10-29',
      '2000-01-01',
    ]) {
      const response = await app!.inject({ method: 'GET', url: '/api/chapters/1', headers: { cookie: cookieOf(day) } });
      expect(response.statusCode, day).toBe(403);
      expect(response.json().code, day).toBe('AGE_GATE');
      expect(response.body, day).not.toContain('Первый абзац главы.');
    }
    // A day inside the bound is an answer.
    const inside = await app!.inject({ method: 'GET', url: '/api/chapters/1', headers: { cookie: cookieOf('2025-10-30') } });
    expect(inside.statusCode).toBe(200);
  });
});

describe('POST /api/age', () => {
  it('writes the day from the app’s clock, as a cookie the page can read, for one year', async () => {
    await boot();
    const response = await app!.inject({ method: 'POST', url: '/api/age' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ acknowledgedAt: TODAY_TEXT });
    const cookie = String(response.headers['set-cookie'] ?? '');
    expect(cookie).toContain(`${AGE_COOKIE}=${TODAY_TEXT}`);
    expect(cookie).toContain(`Max-Age=${String(AGE_MAX_AGE_SECONDS)}`);
    expect(AGE_MAX_AGE_SECONDS).toBe(31_536_000);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    // A fact about this device, not a credential: the page reads it at boot.
    expect(cookie).not.toContain('HttpOnly');
    // `Secure` follows the public origin (https by default), like the session cookie.
    expect(cookie).toContain('Secure');
    // The day is the app's, not the machine's: the seam is what the value is written from.
    expect(ageDateOf(TODAY)).toBe(TODAY_TEXT);
  });

  it('drops `Secure` for a plain-http origin, so a local run keeps the answer', async () => {
    await boot({ env: { PUBLIC_ORIGIN: 'http://127.0.0.1:8080' } });
    const cookie = String((await app!.inject({ method: 'POST', url: '/api/age' })).headers['set-cookie'] ?? '');
    expect(cookie).toContain(`${AGE_COOKIE}=${TODAY_TEXT}`);
    expect(cookie).not.toContain('Secure');
  });

  it('opens the prose with the cookie it just wrote', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': CHAPTER_ONE } });
    const accepted = await app!.inject({ method: 'POST', url: '/api/age' });
    const cookie = String(accepted.headers['set-cookie'] ?? '').split(';')[0] ?? '';

    const prose = await app!.inject({ method: 'GET', url: '/api/chapters/1', headers: { cookie } });
    expect(prose.statusCode).toBe(200);
    const body = prose.json() as { n: number; blocks: Array<{ text: string }> };
    expect(body.n).toBe(1);
    expect(body.blocks[0]?.text).toContain('Первый абзац главы.');
    // The reader who answered is handed the book, not a reminder of the question.
    expect(prose.headers['cache-control']).toBe('no-store');
  });
});

describe('the other prose doors refuse the same way', () => {
  /** The newest moment the log holds — the `at` a history chapter is asked for. */
  function lastHseq(): number {
    return (fixture!.db.prepare('SELECT COALESCE(MAX(hseq), 0) AS h FROM events').get() as { h: number }).h;
  }

  it('refuses the history’s chapter — the same prose, at a moment — before the moment is read', async () => {
    await boot({ chapters: { 'ch01.md': CHAPTER_ONE } });
    const gated = await app!.inject({ method: 'GET', url: `/api/history/chapters/1?at=${String(lastHseq())}` });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().code).toBe('AGE_GATE');
    expect(gated.body).not.toContain('Первый абзац главы.');

    const open = await app!.inject({
      method: 'GET',
      url: `/api/history/chapters/1?at=${String(lastHseq())}`,
      headers: { cookie: cookieOf(TODAY_TEXT) },
    });
    expect(open.statusCode).toBe(200);
    expect(open.body).toContain('Первый абзац главы.');
  });

  it('refuses the whole book in one file — GET and HEAD, before any tag or build', async () => {
    await boot({ chapters: { 'ch01.md': CHAPTER_ONE } });
    for (const method of ['GET', 'HEAD'] as const) {
      const gated = await app!.inject({ method, url: '/book.fb2' });
      expect(gated.statusCode, method).toBe(403);
      expect(gated.json().code, method).toBe('AGE_GATE');
      expect(gated.headers.etag, method).toBeUndefined();
      // A refusal about this request's cookie is never a storable answer, and `/book.fb2` is
      // outside the `/api/` rule that would say so: a proxy must not keep the `403`.
      expect(gated.headers['cache-control'], method).toBe('no-store');
      expect(gated.body, method).not.toContain('Первый абзац главы.');
    }

    // The file itself with the answer: no gate code, and the XML the reader would save.
    const open = await app!.inject({ method: 'GET', url: '/book.fb2', headers: { cookie: cookieOf(TODAY_TEXT) } });
    expect(open.statusCode).toBe(200);
    expect(open.body).toContain('FictionBook');
    expect(open.body).not.toContain('AGE_GATE');
    // ...and the surfaces that carry no prose still answer: hashes and lineage are not sentences.
    expect((await app!.inject({ method: 'GET', url: '/api/history/diff' })).statusCode).toBe(200);
  });
});

describe('the rest of the book stays open while gated', () => {
  it('answers the front, the catalog and the state without an acknowledgement', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': CHAPTER_ONE } });

    const front = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(front.statusCode).toBe(200);
    expect((front.json() as { title: string }).title).toBe('Без названия');

    const catalog = await app!.inject({ method: 'GET', url: '/api/chapters' });
    expect(catalog.statusCode).toBe(200);
    expect((catalog.json() as unknown[]).length).toBe(42);

    const state = await app!.inject({ method: 'GET', url: '/api/state' });
    expect(state.statusCode).toBe(200);
  });
});
