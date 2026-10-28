import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthorsDto } from '@book/shared';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { publicAlias } from '../src/util/alias.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * The author marker's operator route (owner, 2026-10-28): `POST /api/admin/authors/author`.
 *
 * The owner signs in as a reader, so on a fresh book his identity must be marked by hand — there
 * is no first-reader guess anywhere. The route is guarded like the rest of the panel, flips one
 * column, reports `previous`/`current`, and the end matter and the byline follow at once.
 */

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

async function boot(token: string): Promise<{ fixture: Fixture; app: FastifyInstance }> {
  fixture = createFixture({
    'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
  });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  app = await buildApp({
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
    adminToken: token,
  });
  await app.ready();
  return { fixture, app };
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

const TOKEN = 'panel-token';

/** A surviving paragraph owned by one reader: the shape the history writer produces. */
function seedSurviving(h: { db: Fixture['db'] }, identityId: string, uid: string, chars: number): void {
  h.db
    .prepare(
      `INSERT INTO block_versions
         (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
          change_id, step_id, actor_kind, actor_label, identity_id, at)
       VALUES (?, 1, 8, 2, 100, ?, 'h', ?, 'introduced', NULL, NULL,
               NULL, NULL, 'reader', 'читатель', ?, '2026-10-25T12:00:00Z')`,
    )
    .run(uid, `ch08#${uid}`, chars, identityId);
}

function call(path: string, body: unknown, token: string | null = TOKEN) {
  return app!.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-admin-token': token }),
    },
    payload: body as object,
  });
}

describe('POST /api/admin/authors/author', () => {
  it('does not exist without a configured token, and refuses a wrong one', async () => {
    const none = await boot('');
    const anonymous = upsertIdentity(none.fixture.db, {
      yandexSub: 'yandex-owner',
      displayName: 'Филипп Семиров',
      at: '2026-10-25T11:00:00Z',
    });
    expect((await call('/api/admin/authors/author', { identity: anonymous.id, author: true }, null)).statusCode).toBe(404);
    await app?.close();

    const { fixture: f } = await boot(TOKEN);
    const owner = upsertIdentity(f.db, {
      yandexSub: 'yandex-owner',
      displayName: 'Филипп Семиров',
      at: '2026-10-25T11:00:00Z',
    });
    const wrong = await call('/api/admin/authors/author', { identity: owner.id, author: true }, 'not-the-token');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.db.prepare('SELECT is_author FROM identities WHERE id = ?').get(owner.id)).toEqual({ is_author: 0 });
  });

  it('refuses a body without a boolean author', async () => {
    const { fixture: f } = await boot(TOKEN);
    const owner = upsertIdentity(f.db, { yandexSub: 'yandex-owner', displayName: 'Филипп Семиров', at: '2026-10-25T11:00:00Z' });
    const response = await call('/api/admin/authors/author', { identity: owner.id, author: 'yes' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID' });
    expect((await call('/api/admin/authors/author', { author: true })).statusCode).toBe(400);
    expect((await call('/api/admin/authors/author', { identity: 'никого', author: true })).statusCode).toBe(404);
  });

  it('flips the marker on and off, reports previous/current, and the list and byline follow', async () => {
    const { fixture: f } = await boot(TOKEN);
    const owner = upsertIdentity(f.db, { yandexSub: 'yandex-owner', displayName: 'Филипп Семиров', at: '2026-10-25T11:00:00Z' });
    const anya = upsertIdentity(f.db, { yandexSub: 'yandex-anya', displayName: 'Аня', at: '2026-10-25T11:00:00Z' });
    // The owner's own reader identity carries text — exactly the live «+ 1» defect.
    seedSurviving(f, owner.id, 'bkd_owner', 300);
    seedSurviving(f, anya.id, 'bkd_anya', 500);

    const before = (await app!.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    expect(before.contributors.map((item) => item.label).sort()).toEqual(['Аня', 'Филипп Семиров']);
    expect((await app!.inject({ method: 'GET', url: '/api/front' })).json().authors.count).toBe(2);

    const on = await call('/api/admin/authors/author', { identity: 'Филипп Семиров', author: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({
      identity: { id: owner.id, displayName: 'Филипп Семиров' },
      previous: 0,
      current: 1,
    });
    expect(f.db.prepare('SELECT is_author FROM identities WHERE id = ?').get(owner.id)).toEqual({ is_author: 1 });

    const after = (await app!.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    expect(after.contributors.map((item) => item.label)).toEqual(['Аня']);
    expect(after.contributors[0]?.chars).toBe(500);
    // His 300 characters are the author's remainder, not a second name.
    expect(after.author.chars).toBe(after.totalChars - 500);
    expect((await app!.inject({ method: 'GET', url: '/api/front' })).json().authors.count).toBe(1);

    // A no-op toggle is visible as such rather than silently succeeding.
    const again = await call('/api/admin/authors/author', { identity: publicAlias(owner.id), author: true });
    expect(again.json()).toMatchObject({ previous: 1, current: 1 });

    const off = await call('/api/admin/authors/author', { identity: owner.id, author: false });
    expect(off.json()).toMatchObject({ previous: 1, current: 0 });
    expect(f.db.prepare('SELECT is_author FROM identities WHERE id = ?').get(owner.id)).toEqual({ is_author: 0 });
    const restored = (await app!.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    expect(restored.contributors.map((item) => item.label).sort()).toEqual(['Аня', 'Филипп Семиров']);
    expect((await app!.inject({ method: 'GET', url: '/api/front' })).json().authors.count).toBe(2);
  });
});
