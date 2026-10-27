/**
 * BOOK-DOC-4 rule 5 — one reader edit a day **per person and per address**.
 *
 * The identity key (`edit:id:`) was the only budget; two Yandex accounts behind one address
 * could spend two edits. The network key (`edit:ip:<HMAC>`) closes that hole at the same two
 * choke points as the identity key: POSTing a proposed edit and accepting a plain comment at
 * triage. A refusal must leave **both** budgets intact, and neither key may be spent alone.
 *
 * The public copy is one line for both counters; an operator can tell them apart in the log
 * (and in the triage CLI's output), the reader cannot — and no address ever appears in either.
 */

import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { editDailyMessage } from '../../src/comments/dailyLimit.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { SESSION_COOKIE } from '../../src/identity/session.ts';
import { editIdentityKey, editIpKey } from '../../src/rate/policy.ts';
import { ipKey } from '../../src/util/ip.ts';
import { createIpHasher } from '../../src/util/ipHash.ts';
import { bootComments, commentBody, type Harness } from './helpers.ts';

let harness: Harness | null = null;
let dir: string | null = null;

async function boot(options: Parameters<typeof bootComments>[0] = {}): Promise<Harness> {
  harness = await bootComments(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const ipHash = createIpHasher('test-ip-salt');

/** The key a /64-collapsed address hashes to — the same function the route uses. */
function netKey(address: string): string {
  return editIpKey(ipHash, ipKey(address));
}

type Reader = { identityId: string; cookie: string };

/** A second Yandex account: its own identity and session, no account-level coupling. */
function reader(h: Harness, sub: string, name: string): Reader {
  const identity = upsertIdentity(h.db, {
    yandexSub: sub,
    displayName: name,
    at: h.clock.now().toISOString(),
  });
  const session = h.sessions.issue(identity.id, { ipKey: '127.0.0.1' });
  return { identityId: identity.id, cookie: session.cookie };
}

/** A post from a chosen reader **and** a chosen address (`X-Forwarded-For` behind loopback). */
function postFrom(h: Harness, who: Reader, ip: string, body: unknown) {
  return h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: {
      origin: h.config.publicOrigin,
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${who.cookie}`,
      'x-forwarded-for': ip,
    },
    payload: body as object,
  });
}

function firstReader(h: Harness): Reader {
  return { identityId: h.identity.id, cookie: h.cookie };
}

function editKeys(h: Harness): string[] {
  return (
    h.db.prepare(`SELECT key FROM rate_events WHERE key LIKE 'edit:%' ORDER BY key`).all() as Array<{
      key: string;
    }>
  ).map((row) => row.key);
}

function used(h: Harness, key: string): number {
  return h.limiter.check({ key, limit: 1, windowMs: 24 * 60 * 60_000 }).used;
}

function cli(h: Harness, ...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, {
    db: h.db,
    dir: dir ?? '',
    now: h.clock.now,
    print: (line) => out.push(line),
  });
  return { code, out };
}

const PROPOSED = { body: 'Первый абзац лучше начать иначе.', proposedText: 'Тестовый абзац.' };

describe('one address, two identities (BOOK-DOC-4 rule 5)', () => {
  it('spends both keys at POST and refuses the second identity from the same address', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');
    const address = '203.0.113.9';

    const first = await postFrom(h, anya, address, commentBody(PROPOSED));
    expect(first.statusCode).toBe(201);

    // Both budgets were spent by the one accepted edit, and nothing else was.
    expect(used(h, editIdentityKey(anya.identityId))).toBe(1);
    expect(used(h, netKey(address))).toBe(1);
    expect(used(h, editIdentityKey(boris.identityId))).toBe(0);

    const second = await postFrom(h, boris, address, commentBody(PROPOSED));
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: 'EDIT_DAILY_LIMIT' });
    expect(second.headers['retry-after']).toBeDefined();
    expect(typeof second.json().resetAt).toBe('string');

    // A refusal takes nothing: the second reader's identity budget stays untouched.
    expect(used(h, editIdentityKey(boris.identityId))).toBe(0);
    expect(editKeys(h)).toEqual([netKey(address), editIdentityKey(anya.identityId)].sort());
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 1 });
  });

  it('still refuses the first identity on another address, by its own key', async () => {
    const lines: string[] = [];
    const h = await boot({ logStream: { write: (line) => lines.push(line) } });
    const anya = firstReader(h);
    const address = '203.0.113.9';

    expect((await postFrom(h, anya, address, commentBody(PROPOSED))).statusCode).toBe(201);

    // A new network would still leave the reader with a spent identity budget.
    const again = await postFrom(
      h,
      anya,
      '198.51.100.5',
      commentBody({ body: 'Второй абзац тоже стоит сократить.', proposedText: 'Тестовый абзац номер два.' }),
    );
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ code: 'EDIT_DAILY_LIMIT' });
    expect(used(h, editIdentityKey(anya.identityId))).toBe(1);
    expect(used(h, netKey('198.51.100.5'))).toBe(0);

    await new Promise((resolve) => setImmediate(resolve));
    const output = lines.join('\n');
    expect(output).toContain('"budget":"identity"');
    expect(output).not.toContain(address);
    expect(output).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/u);
  });

  it('reports the tighter budget: a spent address leaves the next reader at 0 remaining', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');
    const address = '203.0.113.9';
    const resetAt = new Date(h.clock.ms + 24 * 60 * 60_000).toISOString();

    const first = await postFrom(h, anya, address, commentBody(PROPOSED));
    expect(first.statusCode).toBe(201);
    expect(first.json().remaining).toMatchObject({ editsPerDay: 1, editsRemaining: 0, editsResetAt: resetAt });

    // Boris has spent nothing himself; his address has, and the composer must say so before
    // he writes — otherwise the refusal is a surprise.
    const plain = await postFrom(h, boris, address, commentBody({ body: 'Второй абзац стоит сократить.' }));
    expect(plain.statusCode).toBe(201);
    expect(plain.json().remaining).toMatchObject({ editsPerDay: 1, editsRemaining: 0, editsResetAt: resetAt });
    expect(used(h, editIdentityKey(boris.identityId))).toBe(0);
  });

  it('lets two readers on different addresses each spend their day', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');

    expect((await postFrom(h, anya, '203.0.113.9', commentBody(PROPOSED))).statusCode).toBe(201);
    expect((await postFrom(h, boris, '198.51.100.5', commentBody(PROPOSED))).statusCode).toBe(201);
  });
});

describe('the IPv6 /64 is the network identity (§14)', () => {
  it('collapses two /128 addresses of one /64 into one edit day', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');

    expect((await postFrom(h, anya, '2001:db8:1234:5678::1', commentBody(PROPOSED))).statusCode).toBe(201);

    // A rotating /128 inside the same /64 is the same household.
    const sameNetwork = await postFrom(h, boris, '2001:db8:1234:5678:ffff::2', commentBody(PROPOSED));
    expect(sameNetwork.statusCode).toBe(429);
    expect(sameNetwork.json()).toMatchObject({ code: 'EDIT_DAILY_LIMIT' });
    expect(used(h, netKey('2001:db8:1234:5678::1'))).toBe(1);

    // A different /64 is a different household.
    const other = reader(h, 'yandex-3003', 'Вера');
    expect((await postFrom(h, other, '2001:db8:1234:9999::1', commentBody(PROPOSED))).statusCode).toBe(201);
  });
});

describe('the public refusal is one quiet truth; the log knows which key', () => {
  it('names the reset moment in the display zone, and the day when it is not today', () => {
    // Same day in Europe/Moscow (12:00 → 18:00 MSK): a bare clock is enough.
    expect(editDailyMessage(Date.UTC(2026, 9, 26, 15, 0, 0), 'Europe/Moscow', Date.UTC(2026, 9, 26, 9, 0, 0))).toBe(
      'правка уже была сегодня — одна правка в сутки; следующая возможна после 18:00',
    );
    // T0 + 24 h falls on the next day there: the reader is told it is tomorrow.
    expect(editDailyMessage(Date.UTC(2026, 9, 26, 12, 0, 0), 'Europe/Moscow', Date.UTC(2026, 9, 25, 12, 0, 0))).toBe(
      'правка уже была сегодня — одна правка в сутки; следующая возможна завтра после 15:00',
    );
    expect(editDailyMessage(null, 'Europe/Moscow', Date.UTC(2026, 9, 26, 9, 0, 0))).toBe(
      'правка уже была сегодня — одна правка в сутки',
    );
    expect(editDailyMessage(Date.UTC(2026, 9, 26, 12, 0, 0), 'Not/AZone', Date.UTC(2026, 9, 25, 12, 0, 0))).toBe(
      'правка уже была сегодня — одна правка в сутки',
    );
  });

  it('names the day window and its reset, and reveals neither identity nor address', async () => {
    const lines: string[] = [];
    const h = await boot({ logStream: { write: (line) => lines.push(line) } });
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');
    const address = '203.0.113.9';

    expect((await postFrom(h, anya, address, commentBody(PROPOSED))).statusCode).toBe(201);

    const byIp = await postFrom(h, boris, address, commentBody(PROPOSED));
    const byIdentity = await postFrom(
      h,
      anya,
      '198.51.100.5',
      commentBody({ body: 'Третий абзац тоже длинный.', proposedText: 'Тестовый абзац номер три.' }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const copy = byIp.json() as { code: string; message: string; retryAfterMs: number };
    expect(copy.code).toBe('EDIT_DAILY_LIMIT');
    // The internal counter name never reaches the wire.
    expect(byIp.json()).not.toHaveProperty('budget');
    expect(copy.message).toContain('одна правка в сутки');
    // 24 h from T0 falls on the next day in the display timezone (Europe/Moscow).
    expect(copy.message).toContain('завтра после 15:00');
    expect(copy.retryAfterMs).toBe(24 * 60 * 60_000);
    // Identical public answer for both counters: no taxonomy, no probe.
    expect((byIdentity.json() as { message: string }).message).toBe(copy.message);
    for (const secret of [String(address), 'адрес', 'IP', 'identity', 'сеть']) {
      expect(copy.message).not.toContain(secret);
    }

    // The operator's log separates them and carries no address.
    const output = lines.join('\n');
    expect(output).toContain('"budget":"ip"');
    expect(output).toContain('"budget":"identity"');
    expect(output).not.toContain(address);
    expect(output).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/u);
  });
});

describe('triage acceptance spends and checks both keys', () => {
  it('refuses an accepted comment when the address already spent its edit', async () => {
    const h = await boot();
    dir = mkdtempSync(join(tmpdir(), 'book-edit-ip-'));
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');
    const address = '203.0.113.9';

    // Anya's proposed edit took the day for the identity and for the address.
    expect((await postFrom(h, anya, address, commentBody(PROPOSED))).statusCode).toBe(201);
    // Boris leaves a plain note from the same address: comments are unaffected.
    const posted = await postFrom(h, boris, address, commentBody({ body: 'Второй абзац стоит сократить.' }));
    expect(posted.statusCode).toBe(201);
    const plainId = posted.json().comment.id as string;

    expect(cli(h, 'inbox').code).toBe(0);
    expect(cli(h, 'audit', plainId, '--verdict', 'FITS').code).toBe(0);
    const refused = cli(
      h,
      'decide',
      plainId,
      'accepted',
      '--reason',
      'сократить второй абзац',
      '--intent',
      'сократить второй абзац до одного предложения',
    );
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain('EDIT_DAILY_LIMIT');
    // The operator sees the network budget, not the reader.
    expect(refused.out.join('\n')).toContain('с этого адреса');

    // No change, no decision line, no slot: all three budgets are exactly as they were.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT status, decided_at FROM comments WHERE id = ?').get(plainId)).toEqual({
      status: 'batched',
      decided_at: null,
    });
    expect(used(h, netKey(address))).toBe(1);
    expect(used(h, editIdentityKey(boris.identityId))).toBe(0);
    expect(editKeys(h)).toEqual([netKey(address), editIdentityKey(anya.identityId)].sort());
  });

  it('records both slots once the change exists, and distinguishes an identity refusal', async () => {
    const h = await boot();
    dir = mkdtempSync(join(tmpdir(), 'book-edit-ip-'));
    const anya = firstReader(h);

    // A plain comment from a fresh address: the identity budget is the only one spent.
    const posted = await postFrom(h, anya, '198.51.100.5', commentBody({ body: 'Второй абзац стоит сократить.' }));
    expect(posted.statusCode).toBe(201);
    const plainId = posted.json().comment.id as string;
    expect(cli(h, 'inbox').code).toBe(0);
    expect(cli(h, 'audit', plainId, '--verdict', 'FITS').code).toBe(0);

    expect(
      cli(
        h,
        'decide',
        plainId,
        'accepted',
        '--reason',
        'сократить второй абзац',
        '--intent',
        'сократить второй абзац до одного предложения',
      ).code,
    ).toBe(0);
    // The accepted change took both keys, once.
    expect(used(h, editIdentityKey(anya.identityId))).toBe(1);
    expect(used(h, netKey('198.51.100.5'))).toBe(1);

    // A second plain note by the same reader from another network: the identity key refuses
    // and the operator's line says so.
    const second = await postFrom(h, anya, '203.0.113.9', commentBody({ body: 'Третий абзац тоже длинный.' }));
    expect(second.statusCode).toBe(201);
    const secondId = second.json().comment.id as string;
    expect(cli(h, 'inbox').code).toBe(0);
    expect(cli(h, 'audit', secondId, '--verdict', 'FITS').code).toBe(0);
    const refused = cli(
      h,
      'decide',
      secondId,
      'accepted',
      '--reason',
      'сократить третий абзац',
      '--intent',
      'сократить третий абзац до одного предложения',
    );
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain('EDIT_DAILY_LIMIT');
    expect(refused.out.join('\n')).toContain('у автора');
  });
});

describe('the address is never stored or printed raw', () => {
  it('keeps only edit:ip:<64 hex> and never the dotted quad', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const address = '203.0.113.9';
    expect((await postFrom(h, anya, address, commentBody(PROPOSED))).statusCode).toBe(201);

    const keys = editKeys(h);
    expect(keys).toContain(netKey(address));
    for (const key of keys) expect(key).not.toContain('203.0.113');

    const rows = h.db.prepare('SELECT ip_hash FROM comments').all() as Array<{ ip_hash: string }>;
    for (const row of rows) {
      expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.ip_hash).not.toContain('203.0.113');
    }
  });
});
