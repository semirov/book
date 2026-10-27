import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE } from '@book/shared';

import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { StateService } from '../../src/ingest/stateService.ts';
import { appendEvent } from '../../src/history/log.ts';
import { lastHseq } from '../../src/history/events.ts';
import { readRecord } from '../../src/history/record.ts';
import { publicAlias } from '../../src/util/alias.ts';
import { createFixture, longProse, type Fixture } from '../helpers.ts';
import { ingest, releaseLease, seedChange } from './helpers.ts';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

async function boot(): Promise<Fixture> {
  fixture = createFixture();
  app = await buildApp({
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, PORT: '8080' }),
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
});

const CHAPTER = longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.'], 'Тестовая глава');

describe('T-history — GET /api/history (§6F.2, §11.10)', () => {
  it('serves the record newest first, one change per entry, with a cursor', async () => {
    const local = await boot();
    const first = seedChange(local.db, { index: 1, chapter: 1, label: 'Аня' });
    appendEvent(local.db, { kind: 'change.queued', changeId: first.changeId, chapter: 1 }, Date.parse('2026-10-25T09:00:00Z'));
    const second = seedChange(local.db, { index: 2, chapter: 2, label: 'Марк' });
    appendEvent(local.db, { kind: 'change.queued', changeId: second.changeId, chapter: 2 }, Date.parse('2026-10-25T09:10:00Z'));

    const response = await app!.inject({ method: 'GET', url: '/api/history/timeline' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
    const body = response.json() as {
      lastHseq: number;
      at: string;
      items: Array<{ hseq: number; seq: number; chapter: number; alias: string }>;
      nextBefore: number | null;
    };
    expect(body.lastHseq).toBe(lastHseq(local.db));
    expect(body.items).toHaveLength(2);
    // Newest first, one row per change — never one per event.
    expect(body.items.map((item) => item.seq)).toEqual([2, 1]);
    expect(body.items[0]?.alias).toBe('Марк');
    expect(body.items[0]?.chapter).toBe(2);
    expect(body.items[0]?.hseq).toBeGreaterThan(body.items[1]?.hseq ?? 0);
    // A short page reaches the oldest record: it carries no cursor (BOOK-DOC-50 §7).
    expect(body.nextBefore).toBeNull();

    // Cursor semantics: a full page yields its last row's `hseq`, and `before` is exclusive.
    const firstPage = await app!.inject({ method: 'GET', url: '/api/history/timeline?limit=1' });
    const firstPageBody = firstPage.json() as { items: Array<{ hseq: number; seq: number }>; nextBefore: number | null };
    expect(firstPageBody.items).toHaveLength(1);
    expect(firstPageBody.nextBefore).toBe(firstPageBody.items[0]?.hseq);
    const secondPage = await app!.inject({
      method: 'GET',
      url: `/api/history/timeline?limit=1&before=${firstPageBody.nextBefore}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json() as { items: Array<{ hseq: number; seq: number }>; nextBefore: number | null };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0]?.seq).toBe(1);
    // A full page always carries its own edge; the next request would simply be empty.
    expect(secondBody.nextBefore).toBe(secondBody.items[0]?.hseq);

    const exhausted = await app!.inject({
      method: 'GET',
      url: `/api/history/timeline?before=${body.items.at(-1)?.hseq}`,
    });
    expect((exhausted.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('serves the book at a moment and marks what did not exist yet', async () => {
    const local = await boot();
    ingest(local, 'ch01.md', CHAPTER);
    const first = lastHseq(local.db);
    ingest(local, 'ch02.md', longProse(['Второй абзац.'], 'Вторая глава'));

    const at = await app!.inject({ method: 'GET', url: `/api/history/at/${first}` });
    expect(at.statusCode).toBe(200);
    const body = at.json() as { hseq: number; chapters: Array<{ n: number; written: boolean; rev: number }> };
    expect(body.hseq).toBe(first);
    expect(body.chapters.find((entry) => entry.n === 1)).toMatchObject({ written: true, rev: 1 });
    expect(body.chapters.find((entry) => entry.n === 2)).toMatchObject({ written: false, rev: 0 });

    const now = await app!.inject({ method: 'GET', url: '/api/history/at/now' });
    expect((now.json() as { hseq: number }).hseq).toBe(lastHseq(local.db));

    const bad = await app!.inject({ method: 'GET', url: '/api/history/at/nonsense' });
    expect(bad.statusCode).toBe(422);
  });

  it('serves a chapter as it was, with an ETag, and 404 before it existed', async () => {
    const local = await boot();
    ingest(local, 'ch09.md', 'Девятая\n\nПервый абзац девятой главы: служебный текст.');
    const before = lastHseq(local.db);
    ingest(
      local,
      'ch09.md',
      'Девятая\n\nПервый абзац девятой главы: служебный текст.\n\nВторой абзац появился позже.',
    );

    const then = await app!.inject({ method: 'GET', url: `/api/history/chapters/9?at=${before}` });
    expect(then.statusCode).toBe(200);
    const thenBody = then.json() as { rev: number; blocks: Array<{ text: string }>; title: string };
    expect(thenBody.rev).toBe(1);
    expect(thenBody.blocks).toHaveLength(1);
    expect(thenBody.title).toBe('Девятая');

    const etag = then.headers.etag;
    expect(etag).toBe(`"ch09@h${before}"`);
    const cached = await app!.inject({
      method: 'GET',
      url: `/api/history/chapters/9?at=${before}`,
      headers: { 'if-none-match': String(etag) },
    });
    expect(cached.statusCode).toBe(304);

    const missing = await app!.inject({ method: 'GET', url: '/api/history/chapters/9?at=0' });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe('NOT_WRITTEN_THEN');

    const invalid = await app!.inject({ method: 'GET', url: '/api/history/chapters/99' });
    expect(invalid.statusCode).toBe(400);
  });

  it('publishes a reader as an alias in the record, never the identity key (audit m3)', async () => {
    const local = await boot();
    ingest(local, 'ch01.md', CHAPTER);
    const seeded = seedChange(local.db, { index: 3, chapter: 1, label: 'Аня' });
    ingest(
      local,
      'ch01.md',
      longProse(
        ['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.', 'Тестовый абзац номер два. Это служебный текст, он не является текстом книги.'],
        'Тестовая глава',
      ),
    );
    releaseLease(local.db, seeded.leaseId);

    const timeline = await app!.inject({ method: 'GET', url: '/api/history/timeline' });
    const body = timeline.json() as {
      items: Array<{ alias: string; changeId: string }>;
    };
    const reader = body.items.find((item) => item.changeId === seeded.changeId);
    expect(reader).toBeDefined();
    expect(reader?.alias).toBe('Аня');
    // A record carries no identity at all — not even the public handle.
    expect(timeline.body).not.toContain(seeded.identityId);
    expect(timeline.body).not.toContain(publicAlias(seeded.identityId));
  });

  it('serves the change log of a span', async () => {
    const local = await boot();
    ingest(local, 'ch01.md', longProse(['Первый абзац.', 'Второй абзац.'], 'Первая'));
    const from = lastHseq(local.db);
    ingest(local, 'ch01.md', longProse(['Первый абзац.', 'Второй абзац переписан.'], 'Первая'));
    const to = lastHseq(local.db);

    const response = await app!.inject({ method: 'GET', url: `/api/history/diff?before=${from}&at=${to}&chapter=1` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { from: number; to: number; ops: Array<{ op: string; chapter: number }> };
    expect(body.from).toBe(from);
    expect(body.ops.length).toBeGreaterThan(0);
    expect(body.ops.every((op) => op.chapter === 1)).toBe(true);

    const invalid = await app!.inject({ method: 'GET', url: '/api/history/diff?before=0&at=1&chapter=99' });
    expect(invalid.statusCode).toBe(422);
  });

  it('serves a paragraph chain with the SPEC’s public copy', async () => {
    const local = await boot();
    const first = seedChange(local.db, { index: 1, chapter: 8, label: 'Аня' });
    ingest(local, 'ch08.md', longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.'], 'Восьмая'));
    const original = (local.db.prepare('SELECT id FROM blocks WHERE chapter = 8').get() as { id: string }).id;
    releaseLease(local.db, first.leaseId);

    const second = seedChange(local.db, { index: 2, chapter: 8, label: 'Марк' });
    ingest(
      local,
      'ch08.md',
      longProse(['Тестовый абзац номер один, изменённый. Это служебный текст, он не является текстом книги.'], 'Восьмая'),
    );
    releaseLease(local.db, second.leaseId);

    const byOldId = await app!.inject({ method: 'GET', url: `/api/history/paragraphs/${encodeURIComponent(original)}` });
    expect(byOldId.statusCode).toBe(200);
    const chain = byOldId.json() as {
      alive: boolean;
      line: string;
      versions: Array<{ op: string; ver: number; blockId: string }>;
    };
    expect(chain.alive).toBe(true);
    expect(chain.versions.map((version) => version.op)).toEqual(['introduced', 'revised']);
    expect(chain.versions[1]?.ver).toBe(2);
    // «переписано в 14:20 правкой 2 (Марк) · было: правка 1 (Аня)»
    expect(chain.line).toMatch(/^переписано в \d{2}:\d{2} правкой 2 \(Марк\) · было: правка 1 \(Аня\)$/u);

    const byUid = await app!.inject({
      method: 'GET',
      url: `/api/history/paragraphs/${encodeURIComponent(chain.versions[0]?.blockId === original ? original : original)}`,
    });
    expect(byUid.statusCode).toBe(200);

    const unknown = await app!.inject({ method: 'GET', url: '/api/history/paragraphs/ch99%23deadbeef' });
    expect(unknown.statusCode).toBe(404);

    const tooLong = await app!.inject({ method: 'GET', url: `/api/history/paragraphs/${'x'.repeat(81)}` });
    expect(tooLong.statusCode).toBe(422);
  });

  it('serves impact and contributors, and 404s for an unknown change', async () => {
    const local = await boot();
    const seeded = seedChange(local.db, { index: 3, chapter: 6, label: 'Аня' });
    ingest(local, 'ch06.md', longProse(['Абзац, который читатель просил поправить.'], 'Шестая'));
    releaseLease(local.db, seeded.leaseId);

    const impact = await app!.inject({ method: 'GET', url: `/api/history/impact/${seeded.changeId}` });
    expect(impact.statusCode).toBe(200);
    const body = impact.json() as { changeId: string; chaptersTouched: number[]; blocksChanged: number };
    expect(body.changeId).toBe(seeded.changeId);
    expect(body.chaptersTouched).toContain(6);
    expect(body.blocksChanged).toBeGreaterThan(0);

    const missing = await app!.inject({ method: 'GET', url: '/api/history/impact/chg_nope' });
    expect(missing.statusCode).toBe(404);

    const contributors = await app!.inject({ method: 'GET', url: '/api/history/contributors' });
    expect(contributors.statusCode).toBe(200);
    const authors = contributors.json() as {
      totalChars: number;
      items: Array<{ identityId: string; label: string; share: number }>;
    };
    expect(authors.totalChars).toBeGreaterThan(0);
    expect(authors.items[0]).toMatchObject({ label: 'Аня' });
    expect(authors.items[0]?.share).toBe(1);
    // Audit m3: the public list publishes the alias, never the identity key.
    expect(authors.items[0]?.identityId).toBe(publicAlias(seeded.identityId));
    expect(authors.items[0]?.identityId).not.toBe(seeded.identityId);
    expect(JSON.stringify(authors)).not.toContain(seeded.identityId);

    const status = await app!.inject({ method: 'GET', url: '/api/history/status' });
    expect((status.json() as { hseq: number }).hseq).toBe(lastHseq(local.db));
  });

  it('serves a slot emptied to its basis sentence as the frame at the right edge (BOOK-6)', async () => {
    const local = await boot();
    ingest(local, 'ch01.md', CHAPTER);
    // The emptying writes no revision: the last revision is still 22 628 characters of prose.
    ingest(local, 'ch01.md', FRAME_FIRST_SENTENCE);

    const chapter = await app!.inject({ method: 'GET', url: '/api/history/chapters/1?at=now' });
    expect(chapter.statusCode).toBe(200);
    const body = chapter.json() as { rev: number; chars: number; title: string | null; blocks: Array<{ text: string }> };
    expect(body.chars).toBe(0);
    expect(body.title).toBeNull();
    expect(body.blocks.map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);
    expect(JSON.stringify(body)).not.toContain('Тестовый абзац номер один. Это служебный текст, он не является текстом книги.');

    const at = await app!.inject({ method: 'GET', url: '/api/history/at/now' });
    expect(at.statusCode).toBe(200);
    const book = at.json() as { chapters: Array<{ n: number; written: boolean; chars: number; title: string | null }> };
    expect(book.chapters.find((entry) => entry.n === 1)).toEqual({
      n: 1,
      rev: 1,
      written: false,
      title: null,
      chars: 0,
    });
  });
});

describe('the record cursor is the page’s own edge (BOOK-DOC-50 §7)', () => {
  it('carries a cursor only on a full page, and none on a short or empty one', async () => {
    const local = await boot();

    // No reader change is logged: no rows and no cursor.
    const empty = readRecord(local.db);
    expect(empty.items).toEqual([]);
    expect(empty.nextBefore).toBeNull();

    const seeded = seedChange(local.db, { index: 1, chapter: 1, label: 'Аня' });
    appendEvent(local.db, { kind: 'change.queued', changeId: seeded.changeId, chapter: 1 }, Date.parse('2026-10-25T09:00:00Z'));

    // The whole record on one page: it reached the oldest entry, so nothing lies before it.
    const short = readRecord(local.db);
    expect(short.items).toHaveLength(1);
    expect(short.nextBefore).toBeNull();

    // A full page — the limit equal to the row count — ends on its last row's `hseq`.
    const full = readRecord(local.db, { limit: 1 });
    expect(full.items).toHaveLength(1);
    expect(full.nextBefore).toBe(full.items[0]?.hseq);

    // The cursor and the query share one clamp: `limit: 0` is a page of one row, not zero.
    const clamped = readRecord(local.db, { limit: 0 });
    expect(clamped.items).toHaveLength(1);
    expect(clamped.nextBefore).toBe(clamped.items[0]?.hseq);
  });
});
