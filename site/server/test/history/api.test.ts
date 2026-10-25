import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { StateService } from '../../src/ingest/stateService.ts';
import { lastHseq } from '../../src/history/events.ts';
import { createFixture, longProse, type Fixture } from '../helpers.ts';
import { ingest, releaseLease, seedChange } from './helpers.ts';

const ABOUT =
  'Книга о том, как вещи научились обходиться без тех, кто их завёл. В ней нет героев — есть смены, ' +
  'заявки, очереди и бумаги, которые пережили своих составителей. Земля в ней больше не кормит: её ' +
  'обслуживают. Поля стали участками, участки — строками в реестре, реестр — тем, что закрывают само, ' +
  'без человека. Конец у этой книги один, и он не спрятан: шестьдесят семь глав пишутся в открытую.';

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

const CHAPTER = longProse(['Половик в тамбуре намок насквозь ещё в четверг.'], 'Половик в тамбуре');

describe('T-history — GET /api/history (§6F.2, §11.10)', () => {
  it('serves the scratch timeline newest first, with summaries and a cursor', async () => {
    const local = await boot();
    ingest(local, '00-front.md', `Земля, которая больше не кормит\n\n${ABOUT}\n`);
    ingest(local, 'ch01.md', CHAPTER);

    const response = await app!.inject({ method: 'GET', url: '/api/history/timeline' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      lastHseq: number;
      at: string;
      items: Array<{ hseq: number; kind: string; summary: string; author: { kind: string; label: string } }>;
      nextBefore: number | null;
    };
    expect(body.lastHseq).toBe(lastHseq(local.db));
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items[0]?.hseq).toBeGreaterThan(body.items[1]?.hseq ?? 0);
    expect(body.items.some((item) => item.summary.includes('глава 1'))).toBe(true);
    expect(body.items.some((item) => item.summary.includes('название'))).toBe(true);
    expect(body.nextBefore).toBe(body.items.at(-1)?.hseq ?? null);

    // Cursor semantics: `before` is exclusive, so the next page starts after the last row.
    const firstPage = await app!.inject({ method: 'GET', url: '/api/history/timeline?limit=1' });
    const newest = (firstPage.json() as { items: Array<{ hseq: number }>; nextBefore: number }).items[0];
    expect(firstPage.json().items).toHaveLength(1);
    const secondPage = await app!.inject({
      method: 'GET',
      url: `/api/history/timeline?limit=1&before=${(firstPage.json() as { nextBefore: number }).nextBefore}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const second = (secondPage.json() as { items: Array<{ hseq: number }> }).items[0];
    expect(second?.hseq).toBeLessThan(newest?.hseq ?? 0);
    const exhausted = await app!.inject({ method: 'GET', url: `/api/history/timeline?before=${body.nextBefore}` });
    expect((exhausted.json() as { items: unknown[] }).items).toHaveLength(0);

    const filtered = await app!.inject({ method: 'GET', url: '/api/history/timeline?kind=front.revised' });
    expect((filtered.json() as { items: Array<{ kind: string }> }).items.every((item) => item.kind === 'front.revised')).toBe(
      true,
    );

    const byChapter = await app!.inject({ method: 'GET', url: '/api/history/timeline?chapter=1' });
    expect((byChapter.json() as { items: Array<{ chapter: number }> }).items.every((item) => item.chapter === 1)).toBe(true);
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
    ingest(local, 'ch09.md', 'Девятая\n\nПервый абзац девятой главы: половик намок ещё в четверг.');
    const before = lastHseq(local.db);
    ingest(
      local,
      'ch09.md',
      'Девятая\n\nПервый абзац девятой главы: половик намок ещё в четверг.\n\nВторой абзац появился позже.',
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
    ingest(local, 'ch08.md', longProse(['Половик в тамбуре намок насквозь ещё в четверг.'], 'Восьмая'));
    const original = (local.db.prepare('SELECT id FROM blocks WHERE chapter = 8').get() as { id: string }).id;
    releaseLease(local.db, first.leaseId);

    const second = seedChange(local.db, { index: 2, chapter: 8, label: 'Марк' });
    ingest(
      local,
      'ch08.md',
      longProse(['Половик в тамбуре намок насквозь ещё в четверг, и никто его не поднимал.'], 'Восьмая'),
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
    const authors = contributors.json() as { totalChars: number; items: Array<{ label: string; share: number }> };
    expect(authors.totalChars).toBeGreaterThan(0);
    expect(authors.items[0]).toMatchObject({ label: 'Аня' });
    expect(authors.items[0]?.share).toBe(1);

    const status = await app!.inject({ method: 'GET', url: '/api/history/status' });
    expect((status.json() as { hseq: number }).hseq).toBe(lastHseq(local.db));
  });
});
