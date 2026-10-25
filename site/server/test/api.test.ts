import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const ABOUT =
  'Книга о том, как вещи научились обходиться без тех, кто их завёл. В ней нет героев — есть смены, ' +
  'заявки, очереди и бумаги, которые пережили своих составителей. Земля в ней больше не кормит: её ' +
  'обслуживают. Поля стали участками, участки — строками в реестре, реестр — тем, что закрывают само, ' +
  'без человека. Конец у этой книги один, и он не спрятан: шестьдесят семь глав пишутся в открытую.';
const FRONT = `Земля, которая больше не кормит\n\n${ABOUT}\n`;
const UNTITLED =
  'Половик в тамбуре намок насквозь ещё в четверг, и с тех пор его никто не поднимал: он лежал у порога.\n' +
  'В пятницу к нему прибавился след от колеса.\n\n' +
  'К субботе половик стал похож на карту местности.';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

async function boot(options: { chapters?: Record<string, string>; ui?: boolean } = {}): Promise<Fixture> {
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
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
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

  it('serves the first sheet and the live TOC in the same snapshot', async () => {
    await boot({ chapters: { '00-front.md': FRONT, 'ch01.md': CHAPTER_ONE } });
    const response = await app!.inject({ method: 'GET', url: '/api/state' });
    const body = response.json();
    expect(body.front).toMatchObject({ title: 'Земля, которая больше не кормит', rev: 1 });
    expect(body.front.about).toContain('Книга о том');
    expect(body.toc).toHaveLength(67);
    expect(body.toc[0]).toMatchObject({ n: 1, part: 1, title: 'Заголовок главы', written: true, rev: 1 });
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
    expect(response.headers.etag).toBe('"ch01-r1"');
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
    expect(body.blocks[0].text.startsWith('Половик в тамбуре')).toBe(true);

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

describe('GET /healthz', () => {
  it('reports the database and an absent engine honestly', async () => {
    await boot({ chapters: { 'ch01.md': CHAPTER_ONE } });
    const response = await app!.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      ok: true,
      version: 'test',
      engine: { status: 'absent', heartbeatAt: null },
      lane: { holder: null },
      front: { present: false },
      db: { chapters: 1, comments: 0 },
    });
  });

  it('reports the first sheet as present', async () => {
    await boot({ chapters: { '00-front.md': FRONT } });
    const response = await app!.inject({ method: 'GET', url: '/healthz' });
    expect(response.json()).toMatchObject({ front: { present: true } });
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
      title: 'Земля, которая больше не кормит',
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
