import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { resolveIdentity } from '../src/identity/resolve.ts';
import { publicAlias } from '../src/util/alias.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * BOOK-113 — the two token-guarded budget routes.
 *
 * They mutate budget state, not the book. The setup is the operator's real shape: one identity,
 * a couple of comments (whose `ip_hash` is the only route to the network keys), and rows in
 * `rate_events`. Every answer carries counts and names — never a key, never a hash.
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

function identityId(fixture: Fixture, yandexSub: string, displayName: string): string {
  return upsertIdentity(fixture.db, {
    yandexSub,
    displayName,
    at: '2026-10-25T11:00:00Z',
  }).id;
}

function comment(fixture: Fixture, id: string, owner: string, ipHash: string): void {
  fixture.db
    .prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at, number)
       VALUES (?, ?, 8, 'Аня', 'Служебное замечание.', ?, ?, 'new', '2026-10-25T12:00:00Z', (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
    )
    .run(id, owner, `sha-${id}`, ipHash);
}

function event(fixture: Fixture, key: string): void {
  fixture.db.prepare('INSERT INTO rate_events (key, ts) VALUES (?, ?)').run(key, 1_760_000_000_000);
}

function keys(fixture: Fixture): string[] {
  return (fixture.db.prepare('SELECT key FROM rate_events ORDER BY key').all() as Array<{ key: string }>).map(
    (row) => row.key,
  );
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

describe('the budget routes are guarded like the panel (§17)', () => {
  it('refuses a call without a token', async () => {
    const { fixture } = await boot(TOKEN);
    const owner = identityId(fixture, 'yandex-owner', 'Филипп Семиров');
    const response = await call('/api/admin/budget/reset', { identity: owner }, null);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('does not exist when no admin token is configured', async () => {
    const { fixture } = await boot('');
    const owner = identityId(fixture, 'yandex-owner', 'Филипп Семиров');
    for (const path of ['/api/admin/budget/reset', '/api/admin/budget/exempt']) {
      const response = await call(path, { identity: owner, exempt: true }, null);
      expect(response.statusCode, path).toBe(404);
    }
  });
});

describe('POST /api/admin/budget/reset', () => {
  it('clears the edit keys (identity and this identity’s networks) and the comment key', async () => {
    const { fixture } = await boot(TOKEN);
    const owner = identityId(fixture, 'yandex-owner', 'Филипп Семиров');
    comment(fixture, 'cmt_one', owner, 'hash-one');
    comment(fixture, 'cmt_two', owner, 'hash-two');
    comment(fixture, 'cmt_three', owner, 'hash-one');
    event(fixture, `edit:id:${owner}`);
    event(fixture, 'edit:ip:hash-one');
    event(fixture, 'edit:ip:hash-two');
    // Not reachable through this identity: another reader's network and the comment network.
    event(fixture, 'edit:ip:hash-other');
    event(fixture, 'cmt:ip:hash-one');
    expect(keys(fixture)).toHaveLength(5);

    const response = await call('/api/admin/budget/reset', { identity: owner });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      identity: { id: owner, displayName: 'Филипп Семиров' },
      removed: { editId: 1, editIp: 2, commentId: 0 },
    });
    // The identity's rows are gone, the unrelated ones are untouched, and no key is echoed.
    expect(keys(fixture)).toEqual(['cmt:ip:hash-one', 'edit:ip:hash-other']);
    expect(response.body).not.toContain('hash-one');
  });

  it('resolves an id, a display name (case-insensitive) and the public alias', async () => {
    const { fixture } = await boot(TOKEN);
    const owner = identityId(fixture, 'yandex-owner', 'Филипп Семиров');
    const forms = [owner, 'фИлИпП сЕмИрОв', publicAlias(owner)];
    for (const identity of forms) {
      event(fixture, `edit:id:${owner}`);
      const response = await call('/api/admin/budget/reset', { identity });
      expect(response.statusCode, identity).toBe(200);
      expect(response.json().identity.id).toBe(owner);
      expect(response.json().removed.editId).toBe(1);
    }
  });

  it('refuses an ambiguous display name instead of guessing', async () => {
    const { fixture } = await boot(TOKEN);
    identityId(fixture, 'yandex-one', 'Аня');
    identityId(fixture, 'yandex-two', 'аня');
    event(fixture, 'edit:id:idt_unknown');

    const response = await call('/api/admin/budget/reset', { identity: 'Аня' });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.code).toBe('AMBIGUOUS');
    expect(body.candidates).toHaveLength(2);
    expect(keys(fixture)).toEqual(['edit:id:idt_unknown']);
  });

  it('answers NOT_FOUND for an unknown handle and INVALID for a missing one', async () => {
    const { fixture } = await boot(TOKEN);
    const missing = await call('/api/admin/budget/reset', { identity: 'никого' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });

    const invalid = await call('/api/admin/budget/reset', {});
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'INVALID' });

    // An empty handle is nobody, not everybody: the resolver never falls back to "all rows".
    expect(resolveIdentity(fixture.db, '   ')).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('POST /api/admin/budget/exempt', () => {
  it('turns the exemption on and off, reporting the previous and the current value', async () => {
    const { fixture } = await boot(TOKEN);
    const owner = identityId(fixture, 'yandex-owner', 'Филипп Семиров');
    const exempted = () =>
      (fixture.db.prepare('SELECT edit_exempt FROM identities WHERE id = ?').get(owner) as { edit_exempt: number })
        .edit_exempt;

    const on = await call('/api/admin/budget/exempt', { identity: 'Филипп Семиров', exempt: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({
      identity: { id: owner, displayName: 'Филипп Семиров' },
      previous: 0,
      current: 1,
    });
    expect(exempted()).toBe(1);

    // A no-op toggle is visible as such rather than silently succeeding.
    const again = await call('/api/admin/budget/exempt', { identity: owner, exempt: true });
    expect(again.json()).toMatchObject({ previous: 1, current: 1 });

    const off = await call('/api/admin/budget/exempt', { identity: publicAlias(owner), exempt: false });
    expect(off.json()).toMatchObject({ previous: 1, current: 0 });
    expect(exempted()).toBe(0);
  });

  it('refuses a body without a boolean exempt', async () => {
    const { fixture } = await boot(TOKEN);
    const owner = identityId(fixture, 'yandex-owner', 'Филипп Семиров');
    const response = await call('/api/admin/budget/exempt', { identity: owner, exempt: 'on' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID' });
  });
});
