import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOTAL_CHAPTERS } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { appendEvent } from '../src/history/log.ts';
import type { IntegrityReport } from '../src/integrity/service.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { AGE_ACK_COOKIE, createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * BOOK-155 — the book is `TOTAL_CHAPTERS` (42) long, and the range is enforced at every
 * boundary a reader can reach, not in the database. The `chapters` CHECK still says
 * `BETWEEN 1 AND 67` on purpose (a row written before the cut is real prose and must survive);
 * so the one thing that must never happen is that such a row reaches a reader.
 *
 * The second half of the same rule: a preserved row must not be **counted** either — the
 * operator's panels answer about the book, not about the storage.
 */

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

const ADMIN_TOKEN = 'range-token';

async function boot(options: { chapters?: Record<string, string> } = {}): Promise<Fixture> {
  fixture = createFixture(options.chapters ?? {});
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  webDist = mkdtempSync(join(tmpdir(), 'book-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');
  app = await buildApp({
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: webDist, PORT: '8080' }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
    adminToken: ADMIN_TOKEN,
  });
  return fixture;
}

/** A chapter-65 row with one block: prose that existed before the cut. */
function seedChapter65(target: Fixture): void {
  target.db
    .prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
       VALUES (65, 2, 'Глава 65', 'sha-65', 9000, 1, 0, '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z')`,
    )
    .run();
  target.db
    .prepare(
      `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev)
       VALUES ('ch65#a', 65, 0, 'Текст, написанный до сокращения книги.', 'h-65', 2, 2)`,
    )
    .run();
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  webDist = null;
});

/**
 * One reader's change as the log records it: an identity, a filing, a change made from that
 * filing and its last log entry (the record's clock). `index` keeps the ids and the moments
 * apart; `chapter` is the only number under test.
 */
function seedReaderChange(target: Fixture, index: number, chapter: number, at: string): { changeId: string; commentId: string } {
  const db = target.db;
  const identityId = `idt_${index}`;
  const commentId = `cmt_${index}`;
  const changeId = `chg_${index}`;
  db.prepare(
    `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(identityId, `sub-${index}`, `Читатель ${index}`, at, at);
  db.prepare(
    `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at, number)
     VALUES (?, ?, ?, ?, 'абзац слишком часто повторяется', ?, 'iph', 'accepted', ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
  ).run(commentId, identityId, chapter, `Читатель ${index}`, `sha-${index}`, at);
  db.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, source_comment, base_rev, base_sha256, base_blocks,
                          scope_hint, status, enqueued_at, finished_at)
     VALUES (?, 'accepted_comment', ?, 'убрать второе упоминание абзаца', ?, 1, 'sha', '[]',
             'phrase', 'done', ?, ?)`,
  ).run(changeId, chapter, commentId, at, at);
  appendEvent(db, { kind: 'change.decided', changeId, chapter, payload: { seq: index } }, Date.parse(at));
  return { changeId, commentId };
}

/** The one open ripple, with the steps it recorded — the shape `state.cascade` reads. */
function seedOpenCascade(
  target: Fixture,
  origin: number,
  steps: Array<{ chapter: number; lane: 'forward' | 'backward'; outcome?: string | null }>,
): void {
  const db = target.db;
  const changeId = `chg_csc_${String(origin)}`;
  const cascadeId = `csc_${String(origin)}`;
  db.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks,
                          scope_hint, status, enqueued_at)
     VALUES (?, 'continuity', ?, 'проверить стык', 1, 'sha', '[]', 'chapter', 'processing', '2026-10-25T08:00:00Z')`,
  ).run(changeId, origin);
  db.prepare(
    `INSERT INTO cascades (id, change_id, status, budget, opened_at)
     VALUES (?, ?, 'open', '{}', '2026-10-25T08:30:00Z')`,
  ).run(cascadeId, changeId);
  db.prepare('UPDATE changes SET cascade_id = ? WHERE id = ?').run(cascadeId, changeId);
  steps.forEach((step, index) => {
    db.prepare(
      `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, outcome, at)
       VALUES (?, ?, ?, 1, ?, 'cascade', ?, ?, ?, '2026-10-25T08:40:00Z')`,
    ).run(
      `stp_${String(origin)}_${String(index)}`,
      cascadeId,
      index + 1,
      step.lane,
      step.chapter,
      String(step.chapter),
      step.outcome === undefined ? 'rewritten' : step.outcome,
    );
  });
}

describe('the book’s range at the route boundary (BOOK-155)', () => {
  it('never serves a row left from the 67-chapter book', async () => {
    const target = await boot();
    seedChapter65(target);

    // The route refuses it as no chapter at all — not as a slot that is merely unwritten.
    const served = await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/65' });
    expect(served.statusCode).toBe(400);
    // The finale is inside the book, and since BOOK-187 it carries the frozen frame before it has
    // a chapter: the row `book_frame` holds is the text a reader is given.
    const finale = await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: `/api/chapters/${String(TOTAL_CHAPTERS)}` });
    expect(finale.statusCode).toBe(200);
    expect(finale.json()).toMatchObject({ n: TOTAL_CHAPTERS, basis: true, rev: 0 });

    const catalog = (await app!.inject({ method: 'GET', url: '/api/chapters' })).json() as Array<{ n: number }>;
    expect(catalog).toHaveLength(TOTAL_CHAPTERS);
    expect(catalog.map((entry) => entry.n)).not.toContain(65);

    const state = (await app!.inject({ method: 'GET', url: '/api/state' })).json() as {
      chapters: { total: number; written: number[]; empty: number[] };
      meeting: { gap: number };
      toc: Array<{ n: number }>;
    };
    expect(state.chapters.total).toBe(TOTAL_CHAPTERS);
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.empty).toHaveLength(TOTAL_CHAPTERS);
    expect(state.meeting.gap).toBe(TOTAL_CHAPTERS);
    expect(state.toc).toHaveLength(TOTAL_CHAPTERS);
    expect(state.toc.map((entry) => entry.n)).not.toContain(65);
  });

  it('answers 400 for the first number past the finale, and the finale is a chapter', async () => {
    await boot();
    const past = await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: `/api/chapters/${String(TOTAL_CHAPTERS + 1)}` });
    expect(past.statusCode).toBe(400);
    // In range and unwritten, a slot with no frame is 404 `NOT_WRITTEN`, never a 400; the finale
    // is the frame, so it answers 200 (BOOK-187 AC3).
    const before = await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: `/api/chapters/${String(TOTAL_CHAPTERS - 1)}` });
    expect(before.statusCode).toBe(404);
    expect(before.json()).toMatchObject({ code: 'NOT_WRITTEN' });
    const last = await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: `/api/chapters/${String(TOTAL_CHAPTERS)}` });
    expect(last.statusCode).toBe(200);
    expect(last.json()).toMatchObject({ n: TOTAL_CHAPTERS, basis: true });
  });
});

/**
 * The prose surfaces were clamped first (catalog, state, TOC, `/api/chapters`, the export);
 * these are the **process** rows: a change, a comment and a record kept from the 67-chapter
 * book. Each is preserved (BOOK-155 does not delete it — that is the owner's decision) and
 * each must stay out of every public listing, beside an in-range row that is still served.
 */
describe('a preserved chapter-65 row is storage, not a statement', () => {
  it('keeps the row out of /api/changes, /api/comments and /api/history/timeline, and serves its in-range neighbour', async () => {
    const target = await boot();
    const old = seedReaderChange(target, 1, 65, '2026-09-01T09:00:00Z');
    const current = seedReaderChange(target, 2, 7, '2026-10-01T09:00:00Z');

    const changes = (await app!.inject({ method: 'GET', url: '/api/changes' })).json() as Array<{
      id: string;
      chapter: number;
    }>;
    expect(changes.map((change) => change.id)).toEqual([current.changeId]);
    expect(changes.map((change) => change.chapter)).not.toContain(65);

    const comments = (await app!.inject({ method: 'GET', url: '/api/comments' })).json() as {
      items: Array<{ id: string; chapter: number }>;
    };
    expect(comments.items.map((comment) => comment.id)).toEqual([current.commentId]);
    expect(comments.items.map((comment) => comment.chapter)).not.toContain(65);

    const timeline = (await app!.inject({ method: 'GET', url: '/api/history/timeline' })).json() as {
      items: Array<{ changeId: string; chapter: number }>;
    };
    expect(timeline.items.map((record) => record.changeId)).toEqual([current.changeId]);
    expect(timeline.items.map((record) => record.chapter)).not.toContain(65);

    // A boundary filter, never a deletion: both rows are still in the log's own tables.
    const stored = target.db.prepare('SELECT COUNT(*) AS n FROM changes').get() as { n: number };
    expect(stored.n).toBe(2);
    expect(old.changeId).not.toBe(current.changeId);
  });

  it('answers no card for a change filed at a number the book does not have, and serves the in-range one', async () => {
    const target = await boot();
    const old = seedReaderChange(target, 1, 65, '2026-09-01T09:00:00Z');
    const current = seedReaderChange(target, 2, 7, '2026-10-01T09:00:00Z');

    // The card would print «глава 65» and link to `#ch-65`: a place this book does not have.
    const refused = await app!.inject({ method: 'GET', url: `/api/changes/${old.changeId}` });
    // The same answer an unknown id gets — one 404 shape for both doors.
    const unknown = await app!.inject({ method: 'GET', url: '/api/changes/chg_missing' });
    expect(refused.statusCode).toBe(404);
    expect(refused.statusCode).toBe(unknown.statusCode);
    expect(refused.json()).toEqual(unknown.json());
    expect(refused.json()).toMatchObject({ code: 'NOT_FOUND' });

    const served = await app!.inject({ method: 'GET', url: `/api/changes/${current.changeId}` });
    expect(served.statusCode).toBe(200);
    expect(served.json()).toMatchObject({ id: current.changeId, chapter: 7 });

    // A refusal at the door, never a deletion: the preserved row is still in the table.
    const stored = target.db.prepare('SELECT COUNT(*) AS n FROM changes WHERE id = ?').get(old.changeId) as { n: number };
    expect(stored.n).toBe(1);
  });

  it('draws no ribbon over a ripple whose change is not a chapter of this book', async () => {
    await boot();
    seedOpenCascade(fixture!, 65, [
      { chapter: 65, lane: 'backward' },
      { chapter: 7, lane: 'backward' },
    ]);

    const state = (await app!.inject({ method: 'GET', url: '/api/state' })).json() as { cascade: unknown };
    // The ribbon's origin is an anchor (`#ch-N`): a change with no place in the book has no
    // ripple to draw, so the public snapshot carries none.
    expect(state.cascade).toBeNull();
  });

  it('drops only the out-of-range reach of an in-range ripple', async () => {
    await boot();
    seedOpenCascade(fixture!, 7, [
      { chapter: 8, lane: 'forward' },
      { chapter: 65, lane: 'forward' },
      { chapter: 6, lane: 'backward' },
    ]);

    const state = (await app!.inject({ method: 'GET', url: '/api/state' })).json() as {
      cascade: {
        origin: number;
        touched: number[];
        rewritten: number[];
        frontier: { forward: number; backward: number };
        wings: { up: { frontier: number; reached: number[] }; down: { frontier: number; reached: number[] } };
      };
    };
    expect(state.cascade.origin).toBe(7);
    expect(state.cascade.touched).toEqual([6, 7, 8]);
    expect(state.cascade.rewritten).toEqual([6, 8]);
    // The upward wing stops at the last chapter the book has, never at the preserved row.
    expect(state.cascade.frontier.forward).toBe(8);
    expect(state.cascade.wings.up.reached).toEqual([8]);
    expect(state.cascade.wings.down.reached).toEqual([6]);

    // The card's own cascade reads the same range: it names the chapters the book has and no
    // other, so no link in the card points at a chapter that is not there.
    const card = (await app!.inject({ method: 'GET', url: '/api/changes/chg_csc_7' })).json() as {
      cascade: { chaptersRewritten: number[]; chaptersChecked: number[] };
    };
    expect(card.cascade.chaptersRewritten).toEqual([6, 8]);
    expect(card.cascade.chaptersChecked).toEqual([]);
  });

  it('draws no cursor over a step in flight at a number the book does not have', async () => {
    await boot();
    seedOpenCascade(fixture!, 7, [{ chapter: 65, lane: 'forward', outcome: null }]);

    const state = (await app!.inject({ method: 'GET', url: '/api/state' })).json() as {
      cascade: { stepChapter: number | 'front' | null; wing: string | null; wings: { up: { state: string } } };
    };
    // The ripple is live inside the book; its step is not at a chapter, so no ring is drawn and
    // the wing that only ever reached the preserved row never opened.
    expect(state.cascade.stepChapter).toBeNull();
    expect(state.cascade.wing).toBe('upward');
    expect(state.cascade.wings.up.state).toBe('waiting');
  });
});

/** The operator's panels answer about the book, not about the storage (BOOK-155). */
describe('the operator’s aggregates count the book, not the storage', () => {
  it('does not count a preserved chapter-65 row as a written chapter or as characters', async () => {
    const target = await boot({ chapters: { 'ch03.md': longProse(['Третий абзац.']) } });
    seedChapter65(target);
    const inRange = target.db.prepare('SELECT chars FROM chapters WHERE n = 3').get() as { chars: number };

    const response = await app!.inject({
      method: 'GET',
      url: '/api/admin/integrity',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as IntegrityReport;
    // The one written chapter is ch03; the 65th row's 9 000 characters are not the book's.
    expect(body.chapters.written).toBe(1);
    expect(body.chapters.totalChars).toBe(inRange.chars);
    expect(body.chapters.totalChars).toBeLessThan(9_000);

    const health = await app!.inject({
      method: 'GET',
      url: '/api/admin/health',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect((health.json() as { db: { chapters: number } }).db.chapters).toBe(1);
  });
});

