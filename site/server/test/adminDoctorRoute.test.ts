import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * BOOK-188 — `GET /api/admin/doctor`, the DB half of the launch preflight.
 *
 * The route is read-only and guarded exactly like the rest of the panel: no configured token is
 * a 404, a wrong token is a 401, and the answer carries counts, paths, booleans and sha256 — never
 * a chapter text or a token. The last test is the point of the whole module: a doctor that wrote
 * something would be a second writer of the book.
 */

const TOKEN = 'panel-token';

const apps: FastifyInstance[] = [];
let fixture: Fixture | null = null;

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  fixture?.close();
  fixture = null;
});

function framedFixture(): Fixture {
  const created = createFixture({
    'ch01.md': FRAME_FIRST_SENTENCE,
    'ch42.md': FRAME_LAST_SENTENCE,
    'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
  });
  reconcile(created.db, { bookRoot: created.root, dataDir: created.dataDir });
  fixture = created;
  return created;
}

async function boot(target: Fixture, adminToken: string): Promise<FastifyInstance> {
  const built = await buildApp({
    config: loadConfig({ BOOK_ROOT: target.root, DATA_DIR: target.dataDir }),
    db: target.db,
    state: new StateService(target.db),
    version: '0.1.0',
    commit: '5e8ea57',
    logger: false,
    adminToken,
  });
  apps.push(built);
  return built;
}

describe('GET /api/admin/doctor', () => {
  it('answers the preflight with counts, paths and digests, and no text', async () => {
    const target = framedFixture();
    // `migrate` is idempotent; a fresh fixture is already migrated, and this proves the version
    // the route reports is the one the image carries.
    migrate(target.db);
    const built = await boot(target, TOKEN);

    const response = await built.inject({
      method: 'GET',
      url: '/api/admin/doctor',
      headers: { 'x-admin-token': TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json() as {
      build: { commit: string; version: string };
      schema: { userVersion: number; expected: number };
      dumps: { preMigration: unknown };
      dataDir: { path: string; entries: string[]; denied: string[]; stray: string[]; tokens: unknown; error: string | null };
      frame: { source: string; rows: Array<{ chapter: number; position: string; sha256: string }> };
      graph: { shipped: boolean };
    };
    expect(Object.keys(body).sort()).toEqual(['build', 'dataDir', 'dumps', 'frame', 'graph', 'schema']);
    expect(body.build).toEqual({ commit: '5e8ea57', version: '0.1.0' });
    expect(body.schema.userVersion).toBe(body.schema.expected);
    expect(body.dumps.preMigration).toBeNull();
    expect(body.dataDir.path).toBe(target.dataDir);
    expect(body.dataDir.denied).toEqual([]);
    expect(body.dataDir.tokens).toEqual({ admin: false, engine: false });
    expect(body.dataDir.error).toBeNull();
    // BOOK-187: the volume carries the two seeded rows, so the table answers — still digests only.
    expect(body.frame.source).toBe('book_frame');
    expect(body.frame.rows.map((row) => row.chapter)).toEqual([1, 42]);
    expect(body.frame.rows.every((row) => /^[0-9a-f]{64}$/u.test(row.sha256))).toBe(true);
    // BOOK-185 stage 3 (v29): the edge table is in this image, so a fresh volume reports the
    // graph as shipped and counts zero rows — the CLI reads `shipped` before the numbers.
    expect(body.graph).toEqual({ shipped: true, facts: 0, threads: 0, edges: 0, closureMs: null });

    expect(response.body).not.toContain(FRAME_FIRST_SENTENCE);
    expect(response.body).not.toContain(FRAME_LAST_SENTENCE);
    expect(response.body).not.toContain(TOKEN);
  });

  it('refuses without the token and hides the route when none is configured', async () => {
    const target = framedFixture();
    const built = await boot(target, TOKEN);

    const anonymous = await built.inject({ method: 'GET', url: '/api/admin/doctor' });
    expect(anonymous.statusCode).toBe(401);
    const wrong = await built.inject({
      method: 'GET',
      url: '/api/admin/doctor',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const closed = await boot(target, '');
    const hidden = await closed.inject({
      method: 'GET',
      url: '/api/admin/doctor',
      headers: { 'x-admin-token': TOKEN },
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('changes nothing: the schema version and the row counts survive the call', async () => {
    const target = framedFixture();
    const built = await boot(target, TOKEN);
    const snapshot = (): { version: number; chapters: number; blocks: number; revisions: number } => ({
      version: Number(target.db.pragma('user_version', { simple: true })),
      chapters: (target.db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number }).n,
      blocks: (target.db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number }).n,
      revisions: (target.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n,
    });
    const before = snapshot();

    const first = await built.inject({
      method: 'GET',
      url: '/api/admin/doctor',
      headers: { 'x-admin-token': TOKEN },
    });
    const second = await built.inject({
      method: 'GET',
      url: '/api/admin/doctor',
      headers: { 'x-admin-token': TOKEN },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(snapshot()).toEqual(before);
    expect(second.json()).toEqual(first.json());
  });
});
