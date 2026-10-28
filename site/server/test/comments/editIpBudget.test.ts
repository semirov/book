/**
 * BOOK-DOC-4 rule 5 — one reader edit a day **per person and per address**.
 *
 * The identity key (`edit:id:`) was the only budget; two Yandex accounts behind one address
 * could spend two edits. The network key (`edit:ip:<HMAC>`) closes that hole at the same point
 * the identity key does. BOOK-158 moved that point: **acceptance** spends the day
 * (`feedback/cli.ts decide accepted`), for a note and an intervention alike, and a refusal —
 * at posting or at triage — spends nothing. A refusal must leave **both** budgets intact, and
 * neither key may be spent alone.
 *
 * The operator sees which counter refused (`у автора` / `с этого адреса`); the reader is told
 * the day through the budget the composer shows (`remaining`), never a counter's name, and no
 * address ever appears in the store, the keys or the CLI's output.
 */

import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { upsertIdentity } from '../../src/db/repo/identities.ts';
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
  return { identityId: identity.id, cookie: `${SESSION_COOKIE}=${session.cookie}` };
}

/** A post from a chosen reader **and** a chosen address (`X-Forwarded-For` behind loopback). */
function postFrom(h: Harness, who: Reader, ip: string, body: unknown) {
  return h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: {
      origin: h.config.publicOrigin,
      'content-type': 'application/json',
      cookie: who.cookie,
      'x-forwarded-for': ip,
    },
    payload: body as object,
  });
}

function firstReader(h: Harness): Reader {
  return { identityId: h.identity.id, cookie: h.sessionCookieHeader };
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

type Accepted = { id: string; code: number; out: string[] };

/**
 * Post one note from a chosen reader and address, then take it through triage exactly as an
 * operator would: batch, audit FITS, decide accepted. The acceptance is what spends the day.
 */
async function accept(h: Harness, who: Reader, ip: string, body: string): Promise<Accepted> {
  if (dir === null) dir = mkdtempSync(join(tmpdir(), 'book-edit-ip-'));
  const posted = await postFrom(h, who, ip, commentBody({ body }));
  expect(posted.statusCode).toBe(201);
  const id = posted.json().comment.id as string;
  expect(cli(h, 'inbox').code).toBe(0);
  expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
  const decided = cli(
    h,
    'decide',
    id,
    'accepted',
    '--reason',
    'сократить абзац',
    '--intent',
    'сократить второй абзац до одного предложения',
  );
  return { id, code: decided.code, out: decided.out };
}

describe('one address, two identities (BOOK-DOC-4 rule 5)', () => {
  it('spends both keys at acceptance and refuses the second identity on the address', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');
    const address = '203.0.113.9';

    expect((await accept(h, anya, address, 'Первый абзац лучше начать иначе.')).code).toBe(0);
    // Both budgets were spent by the one accepted filing, and nothing else was.
    expect(used(h, editIdentityKey(anya.identityId))).toBe(1);
    expect(used(h, netKey(address))).toBe(1);
    expect(used(h, editIdentityKey(boris.identityId))).toBe(0);

    const second = await accept(h, boris, address, 'Второй абзац тоже стоит сократить.');
    expect(second.code).toBe(1);
    expect(second.out.join('\n')).toContain('EDIT_DAILY_LIMIT');
    // The operator's line names the network budget; the reader sees none of it.
    expect(second.out.join('\n')).toContain('с этого адреса');

    // A refusal takes nothing: the second reader's identity budget stays untouched.
    expect(used(h, editIdentityKey(boris.identityId))).toBe(0);
    expect(editKeys(h)).toEqual([netKey(address), editIdentityKey(anya.identityId)].sort());
  });

  it('still refuses the first identity on another address, by its own key', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const address = '203.0.113.9';

    expect((await accept(h, anya, address, 'Первый абзац лучше начать иначе.')).code).toBe(0);

    // A new network would still leave the reader with a spent identity budget.
    const again = await accept(h, anya, '198.51.100.5', 'Второй абзац тоже стоит сократить.');
    expect(again.code).toBe(1);
    expect(again.out.join('\n')).toContain('EDIT_DAILY_LIMIT');
    expect(again.out.join('\n')).toContain('у автора');
    expect(used(h, editIdentityKey(anya.identityId))).toBe(1);
    expect(used(h, netKey('198.51.100.5'))).toBe(0);
    // No address, no hash of one, in anything the operator reads.
    expect(again.out.join('\n')).not.toContain(address);
    expect(again.out.join('\n')).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/u);
  });

  it('reports the tighter budget: a spent address leaves the next reader at 0 remaining', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');
    const address = '203.0.113.9';
    const resetAt = new Date(h.clock.ms + 24 * 60 * 60_000).toISOString();

    expect((await accept(h, anya, address, 'Первый абзац лучше начать иначе.')).code).toBe(0);
    // The budget line is read from the next post: the day is spent, nobody's own counter is.
    h.clock.advance(1_000);
    const plain = await postFrom(h, boris, address, commentBody({ body: 'Второй абзац стоит сократить.' }));
    expect(plain.statusCode).toBe(201);
    // Boris has spent nothing himself; his address has, and the composer says so before he
    // writes — otherwise the refusal at triage is a surprise.
    expect(plain.json().remaining).toMatchObject({ editsPerDay: 1, editsRemaining: 0, editsResetAt: resetAt });
    expect(used(h, editIdentityKey(boris.identityId))).toBe(0);
  });

  it('lets two readers on different addresses each spend their day', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');
    dir = mkdtempSync(join(tmpdir(), 'book-edit-ip-'));

    expect((await accept(h, anya, '203.0.113.9', 'Первый абзац лучше начать иначе.')).code).toBe(0);
    expect((await accept(h, boris, '198.51.100.5', 'Второй абзац тоже стоит сократить.')).code).toBe(0);
  });
});

describe('the IPv6 /64 is the network identity (§14)', () => {
  it('collapses two /128 addresses of one /64 into one edit day', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');

    expect((await accept(h, anya, '2001:db8:1234:5678::1', 'Первый абзац лучше начать иначе.')).code).toBe(0);

    // A rotating /128 inside the same /64 is the same household.
    const sameNetwork = await accept(h, boris, '2001:db8:1234:5678:ffff::2', 'Второй абзац тоже стоит сократить.');
    expect(sameNetwork.code).toBe(1);
    expect(sameNetwork.out.join('\n')).toContain('EDIT_DAILY_LIMIT');
    expect(used(h, netKey('2001:db8:1234:5678::1'))).toBe(1);

    // A different /64 is a different household.
    const vera = reader(h, 'yandex-3003', 'Вера');
    expect((await accept(h, vera, '2001:db8:1234:9999::1', 'Третий абзац тоже длинный.')).code).toBe(0);
  });
});

describe('the refusal is one quiet line; the operator knows which key', () => {
  it('tells the two counters apart for the operator and prints no address', async () => {
    const h = await boot();
    dir = mkdtempSync(join(tmpdir(), 'book-edit-ip-'));
    const anya = firstReader(h);
    const boris = reader(h, 'yandex-2002', 'Борис');
    const address = '203.0.113.9';

    expect((await accept(h, anya, address, 'Первый абзац лучше начать иначе.')).code).toBe(0);

    const byIp = await accept(h, boris, address, 'Второй абзац тоже стоит сократить.');
    const byIdentity = await accept(h, anya, '198.51.100.5', 'Третий абзац тоже длинный.');
    expect(byIp.out.join('\n')).toContain('с этого адреса');
    expect(byIdentity.out.join('\n')).toContain('у автора');
    for (const line of [...byIp.out, ...byIdentity.out]) {
      expect(line).not.toContain(address);
      expect(line).not.toContain('edit:');
    }
  });
});

describe('a refusal spends nothing (BOOK-158)', () => {
  it('leaves both keys whole, while the same filing’s acceptance spends them', async () => {
    const h = await boot();
    dir = mkdtempSync(join(tmpdir(), 'book-edit-ip-'));
    const anya = firstReader(h);
    const address = '203.0.113.9';

    const posted = await postFrom(h, anya, address, commentBody({ body: 'Первый абзац лучше начать иначе.' }));
    expect(posted.statusCode).toBe(201);
    const id = posted.json().comment.id as string;
    expect(cli(h, 'inbox').code).toBe(0);
    const refused = cli(h, 'decide', id, 'rejected', '--reason', 'вне рамок: не про текст');
    expect(refused.code).toBe(0);
    expect(editKeys(h)).toEqual([]);
  });
});

describe('the address is never stored or printed raw', () => {
  it('keeps only edit:ip:<64 hex> and never the dotted quad', async () => {
    const h = await boot();
    const anya = firstReader(h);
    const address = '203.0.113.9';
    expect((await accept(h, anya, address, 'Первый абзац лучше начать иначе.')).code).toBe(0);

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
