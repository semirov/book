import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { applyFrontFile } from '../src/ingest/applyFront.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

const CHAPTER_ONE = longProse(['Первый абзац главы.']);
const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';
const FRONT = `Без названия\n\n${ABOUT}\n`;
const UNTITLED =
  'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.\n' +
  'Тестовый абзац номер два. Это служебный текст.\n\n' +
  'Тестовый абзац номер три. Это служебный текст.';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

async function boot(
  options: {
    chapters?: Record<string, string>;
    ui?: boolean;
    adminToken?: string;
    env?: Record<string, string>;
    watcherStatus?: { lastTickAt: string | null; lastEventAt: string | null; missing: boolean };
  } = {},
): Promise<Fixture> {
  fixture = createFixture(options.chapters ?? {});
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

  webDist = mkdtempSync(join(tmpdir(), 'book-web-'));
  if (options.ui !== false) {
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');
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
    ...(options.watcherStatus === undefined ? {} : { watcherStatus: options.watcherStatus }),
    ...(options.adminToken === undefined ? {} : { adminToken: options.adminToken }),
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

describe('GET /api/state', () => {
  it('serves the empty book as 67 explicit slots', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/state' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.chapters.total).toBe(67);
    expect(body.chapters.written).toEqual([]);
    expect(body.chapters.empty).toHaveLength(67);
    expect(body.engine.status).toBe('unknown');
    expect(body.front).toEqual({ title: null, about: null, rev: 0, updatedAt: null });
    expect(body.toc).toHaveLength(67);
    expect(body.toc[0]).toEqual({ part: 1, n: 1, title: null, written: false, rev: 0 });
  });

  it('serves the empty book with the two basis sentences as 67 unwritten slots (BOOK-6)', async () => {
    // The owner's state: ch01 and ch67 carry one sentence each, no titles, no prose.
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': FRAME_FIRST_SENTENCE, 'ch67.md': FRAME_LAST_SENTENCE } });
    const state = (await app!.inject({ method: 'GET', url: '/api/state' })).json();
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.totalChars).toBe(0);
    expect(state.chapters.empty).toHaveLength(67);
    expect(state.toc[0]).toMatchObject({ n: 1, title: null, written: false });
    expect(state.toc[66]).toMatchObject({ n: 67, title: null, written: false });
    // The two sentences are named explicitly: they are readable and still not chapters.
    expect(state.chapters.basis).toEqual([1, 67]);
  });

  it('projects a basis-only slot as one paragraph while keeping it unwritten (BOOK-6)', async () => {
    await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE, 'ch67.md': FRAME_LAST_SENTENCE } });

    // The reader sees the opening and the closing sentence: one block each, no title.
    for (const [n, sentence] of [
      [1, FRAME_FIRST_SENTENCE],
      [67, FRAME_LAST_SENTENCE],
    ] as const) {
      const response = await app!.inject({ method: 'GET', url: `/api/chapters/${n}` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ n, title: null, chars: 0, basis: true });
      expect(body.blocks).toHaveLength(1);
      expect(body.blocks[0]).toMatchObject({ i: 0, text: sentence });
    }

    // The catalog names the slot as basis, and the state counts no chapter and no character.
    const catalog = (await app!.inject({ method: 'GET', url: '/api/chapters' })).json() as Array<
      Record<string, unknown>
    >;
    expect(catalog).toHaveLength(67);
    expect(catalog[0]).toMatchObject({ n: 1, title: null, chars: 0, blocks: 1, written: false, basis: true });
    expect(catalog[66]).toMatchObject({ n: 67, chars: 0, blocks: 1, written: false, basis: true });
    expect(catalog[1]).toMatchObject({ n: 2, chars: 0, blocks: 0, written: false, basis: false });

    const state = (await app!.inject({ method: 'GET', url: '/api/state' })).json();
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.totalChars).toBe(0);
    expect(state.chapters.basis).toEqual([1, 67]);
  });

  it('keeps one block across a rescan: a basis slot is idempotent (BOOK-6)', async () => {
    const fixture = await boot({
      chapters: { 'ch01.md': FRAME_FIRST_SENTENCE, 'ch67.md': FRAME_LAST_SENTENCE },
    });
    const again = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(again.emptied).toEqual([]);
    expect(again.created).toEqual([]);
    expect(again.revised).toEqual([]);
    expect(again.unchanged).toEqual([1, 67]);

    const rows = fixture.db
      .prepare('SELECT n, rev, block_count, chars, basis FROM chapters ORDER BY n')
      .all() as Array<Record<string, number>>;
    expect(rows).toEqual([
      { n: 1, rev: 0, block_count: 1, chars: 0, basis: 1 },
      { n: 67, rev: 0, block_count: 1, chars: 0, basis: 1 },
    ]);

    const chapter = (await app!.inject({ method: 'GET', url: '/api/chapters/1' })).json();
    expect(chapter.blocks).toHaveLength(1);
    expect(chapter.blocks[0].text).toBe(FRAME_FIRST_SENTENCE);
  });

  it('serves the first sheet and the live TOC in the same snapshot', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': CHAPTER_ONE } });
    const response = await app!.inject({ method: 'GET', url: '/api/state' });
    const body = response.json();
    expect(body.front).toMatchObject({ title: 'Без названия', rev: 1 });
    expect(body.front.about).toContain('Тестовая аннотация');
    expect(body.toc).toHaveLength(67);
    expect(body.toc[0]).toMatchObject({ n: 1, part: 1, title: 'Заголовок главы', written: true, rev: 1 });
  });

  it('keeps page 2 verbatim while a front revision changes only the title', async () => {
    const fixture = await boot({ chapters: { '00-front.md': FRONT } });
    const before = (await app!.inject({ method: 'GET', url: '/api/front' })).json();
    expect(before.title).toBe('Без названия');
    expect(before.about).toBe(ABOUT);

    applyFrontFile({
      db: fixture.db,
      dataDir: fixture.dataDir,
      raw: `Другое название\n\n${ABOUT}\n`,
      mtimeMs: Date.now(),
      nowMs: Date.now(),
    });
    const retitled = (await app!.inject({ method: 'GET', url: '/api/front' })).json();
    expect(retitled.title).toBe('Другое название');
    expect(retitled.about).toBe(ABOUT);
    expect(retitled.rev).toBe(before.rev + 1);

    // A file that also rewrote the annotation still answers with the basis: page 2 is frozen.
    applyFrontFile({
      db: fixture.db,
      dataDir: fixture.dataDir,
      raw: `Третье название\n\n${ABOUT.replace('Тестовая аннотация', 'Чужая аннотация')}\n`,
      mtimeMs: Date.now(),
      nowMs: Date.now(),
    });
    const frozen = (await app!.inject({ method: 'GET', url: '/api/front' })).json();
    expect(frozen.title).toBe('Третье название');
    expect(frozen.about).toBe(ABOUT);
  });

  it('returns an ETag and honours If-None-Match', async () => {
    await boot();
    const first = await app!.inject({ method: 'GET', url: '/api/state' });
    expect(first.headers.etag).toBe('"state-1"');
    expect(first.headers['cache-control']).toContain('max-age=2');
    const second = await app!.inject({
      method: 'GET',
      url: '/api/state',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });
});

describe('GET /api/chapters/:n — the ETag names the projection (BOOK-6)', () => {
  it('changes when a written chapter is emptied to its basis sentence', async () => {
    const fixture = await boot({ chapters: { 'ch01.md': CHAPTER_ONE } });
    const before = await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    expect(before.statusCode).toBe(200);
    expect(before.headers.etag).toBe('"ch01-r1-b0"');
    expect(before.json().basis).toBe(false);

    // Emptying down to the frame is a projection change without a revision: `rev` stays.
    fixture.write('ch01.md', FRAME_FIRST_SENTENCE);
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    const stale = await app!.inject({
      method: 'GET',
      url: '/api/chapters/1',
      headers: { 'if-none-match': before.headers.etag as string },
    });
    // A browser holding the old prose must be given the frame, never a 304.
    expect(stale.statusCode).toBe(200);
    expect(stale.headers.etag).toBe('"ch01-r1-b1"');
    const body = stale.json();
    expect(body).toMatchObject({ rev: 1, basis: true, chars: 0, title: null });
    expect(body.blocks.map((block: { text: string }) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);

    // And the new tag is honoured afterwards.
    const fresh = await app!.inject({
      method: 'GET',
      url: '/api/chapters/1',
      headers: { 'if-none-match': stale.headers.etag as string },
    });
    expect(fresh.statusCode).toBe(304);
  });
});

describe('GET /api/chapters', () => {
  it('lists all 67 slots with rev 0 for the unwritten ones', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/chapters' });
    expect(response.statusCode).toBe(200);
    const catalog = response.json() as Array<Record<string, unknown>>;
    expect(catalog).toHaveLength(67);
    expect(catalog[0]).toMatchObject({ n: 1, part: 1, title: null, rev: 0, written: false, direction: 'forward' });
    expect(catalog[66]).toMatchObject({ n: 67, part: 4, direction: 'backward' });
    expect(catalog[22]).toMatchObject({ n: 23, part: 2 });
  });
});

describe('GET /api/chapters/:n', () => {
  it('returns the prose with an ETag and the title line', async () => {
    await boot({ chapters: { 'ch01.md': CHAPTER_ONE } });
    const response = await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"ch01-r1-b0"');
    const body = response.json();
    expect(body.n).toBe(1);
    expect(body.title).toBe('Заголовок главы');
    expect(body.rev).toBe(1);
    expect(body.blocks[0]).toMatchObject({ i: 0, text: 'Первый абзац главы.' });
    expect(body.blocks[0].id).toMatch(/^ch01#[0-9a-f]{8}$/u);
  });

  it('answers 304 for a matching ETag', async () => {
    await boot({ chapters: { 'ch01.md': CHAPTER_ONE } });
    const first = await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    const second = await app!.inject({
      method: 'GET',
      url: '/api/chapters/1',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
  });

  it('still publishes a chapter without a title line: F022 is a commit gate, not a reader gate', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': UNTITLED } });
    const response = await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.title).toBeNull();
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.blocks[0].text.startsWith('Тестовый абзац номер один')).toBe(true);

    const catalog = (await app!.inject({ method: 'GET', url: '/api/chapters' })).json() as Array<
      Record<string, unknown>
    >;
    expect(catalog[0]).toMatchObject({ n: 1, written: true, title: null });
  });

  it('answers 404 for an unwritten slot — the normal case at launch', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/chapters/40' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_WRITTEN' });
  });

  it('answers 400 for a number outside 01..67 and for a non-number', async () => {
    await boot();
    expect((await app!.inject({ method: 'GET', url: '/api/chapters/68' })).statusCode).toBe(400);
    expect((await app!.inject({ method: 'GET', url: '/api/chapters/abc' })).statusCode).toBe(400);
  });
});

describe('the read API budget (audit M6)', () => {
  it('bounds /api/history and /api/state per network, and leaves the catalogue alone', async () => {
    await boot({ env: { READ_PER_MINUTE: '3' } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await app!.inject({ method: 'GET', url: '/api/history/status' })).statusCode).toBe(200);
    }
    const blocked = await app!.inject({ method: 'GET', url: '/api/history/status' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(blocked.json().retryAfterMs).toBeGreaterThan(0);

    // One budget for every expensive read: the state poll shares it.
    expect((await app!.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(429);
    // The catalogue is cheap and cached: it is not part of the budget.
    expect((await app!.inject({ method: 'GET', url: '/api/chapters' })).statusCode).toBe(200);
  });
});

describe('GET /healthz (audit m4: liveness only)', () => {
  it('reports the watcher and an absent engine, and nothing an operator knows', async () => {
    await boot({ chapters: { 'ch01.md': CHAPTER_ONE } });
    const response = await app!.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, engine: { status: 'absent' } });
    expect(body.watcher).toMatchObject({ missing: false });
    // The counts, the version, the cover and the lane holder are operator facts.
    for (const key of ['lane', 'db', 'front', 'version', 'uptimeMs']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.engine).not.toHaveProperty('heartbeatAt');
    // Nothing on the public probe names who holds the pen.
    expect(JSON.stringify(body)).not.toContain('holder');
  });

  it('reports a live watcher, including a missing manuscript mount', async () => {
    await boot({
      watcherStatus: { lastTickAt: '2026-10-25T12:00:00Z', lastEventAt: null, missing: true },
    });
    expect((await app!.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
      watcher: { lastTickAt: '2026-10-25T12:00:00Z', lastEventAt: null, missing: true },
    });
  });

  it('keeps the counts and the cover behind the admin token', async () => {
    await boot({ chapters: { '00-front.md': FRONT }, adminToken: 'panel-token' });
    // No token: the panel does not exist, and the public probe never carries the facts.
    expect((await app!.inject({ method: 'GET', url: '/api/admin/health' })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'GET', url: '/healthz' })).json()).not.toHaveProperty('front');

    const admin = await app!.inject({
      method: 'GET',
      url: '/api/admin/health',
      headers: { 'x-admin-token': 'panel-token' },
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.headers['cache-control']).toBe('no-store');
    expect(admin.json()).toMatchObject({
      version: 'test',
      lane: { holder: null },
      front: { present: true },
      db: { chapters: 0, comments: 0 },
      engine: { status: 'absent', heartbeatAt: null },
    });
  });

  it('closes the admin health surface when no token is configured, and refuses a wrong one', async () => {
    await boot();
    // A forgotten token closes the surface (404), never opens it.
    expect((await app!.inject({ method: 'GET', url: '/api/admin/health' })).statusCode).toBe(404);
    expect(
      (await app!.inject({ method: 'GET', url: '/api/admin/health', headers: { 'x-admin-token': 'anything' } }))
        .statusCode,
    ).toBe(404);
  });

  it('does not bump the state version', async () => {
    await boot();
    await app!.inject({ method: 'GET', url: '/api/state' });
    await app!.inject({ method: 'GET', url: '/healthz' });
    const state = await app!.inject({ method: 'GET', url: '/api/state' });
    expect(state.headers.etag).toBe('"state-1"');
  });
});

describe('the shell', () => {
  it('serves the SPA for an unknown path when a build exists', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/ch-8' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('книга');
  });

  it('routes /privacy and /rules explicitly (audit M5)', async () => {
    await boot();
    for (const url of ['/privacy', '/rules']) {
      const response = await app!.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toContain('text/html');
      expect(response.body, url).toContain('книга');
    }
  });

  it('keeps API 404s as JSON', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('explains a missing build instead of pretending', async () => {
    await boot({ ui: false });
    const response = await app!.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'UI_NOT_BUILT' });
  });
});

describe('GET /api/front', () => {
  it('serves the live title, page 2, the TOC and the imprint in one call', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': CHAPTER_ONE } });
    const response = await app!.inject({ method: 'GET', url: '/api/front' });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"front-1"');
    const body = response.json();
    expect(body).toMatchObject({
      title: 'Без названия',
      about: ABOUT,
      rev: 1,
      imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
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

  it('is honest at launch when there is no first sheet: null title and page 2', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/front' });
    const body = response.json();
    expect(body).toMatchObject({ title: null, about: null, rev: 0 });
    expect(body.toc).toHaveLength(67);
    expect(body.toc.every((entry: { written: boolean }) => !entry.written)).toBe(true);
  });
});
