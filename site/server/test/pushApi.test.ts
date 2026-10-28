import { createECDH, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { upsertIdentity } from '../src/db/repo/identities.ts';
import { PUSH_WRITE_PER_HOUR } from '../src/rate/policy.ts';
import { countSubscriptions, deleteSubscription, subscriptionsOf, upsertSubscription } from '../src/push/repo.ts';
import { readVapid, type VapidKeys } from '../src/push/vapid.ts';
import { bootComments, type Harness } from './comments/helpers.ts';

/**
 * BOOK-189 acceptance for the push surface: the key is public, a subscription is a secret, and
 * every answer says a **count**.
 *
 * The three things these tests are really about:
 *
 *   1. **off is a state, not an error.** No key file (the shipped default) answers `503 PUSH_OFF`
 *      and stores nothing — a deployment without push is a normal site;
 *   2. **nothing comes back out.** Every answer is grepped for the endpoint and both key halves,
 *      because the one defect that matters here is a route that echoes what it was given;
 *   3. **the device list belongs to the session.** Subscribing and unsubscribing are own-only, and
 *      an endpoint named by one reader can never delete another reader's row.
 *
 * The key pair is generated per run and written to a temp file: no key material lives in the
 * repository, and the derived public point is checked against the PEM's own scalar rather than
 * against `readVapid`'s answer.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-push-'));
  dirs.push(dir);
  return dir;
}

/** A real P-256 key in the deployment's shape: PEM PKCS#8 in a `0600` file. */
function writeVapidKey(): { file: string; keys: VapidKeys; scalar: Buffer } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const file = join(tempDir(), 'vapid');
  writeFileSync(file, pem, { mode: 0o600 });
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  const scalar = Buffer.from(jwk.d ?? '', 'base64url');
  const read = readVapid(file);
  if (read.keys === null) throw new Error('the generated key did not read back');
  return { file, keys: read.keys, scalar };
}

/** The public point of a scalar, derived here so the test does not trust `readVapid`'s answer. */
function pointOf(scalar: Buffer): string {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(scalar);
  return ecdh.getPublicKey().toString('base64url');
}

/** A subscription body as a browser sends it. Dummy material: 32 bytes and 16 bytes of base64url. */
function subscribeBody(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123', seed = 'a'): Record<string, unknown> {
  return {
    endpoint,
    keys: {
      p256dh: `${seed.repeat(64)}`.slice(0, 64),
      auth: `${seed.repeat(20)}`.slice(0, 20),
    },
  };
}

async function boot(options: Parameters<typeof bootComments>[0] = {}): Promise<Harness> {
  return bootComments(options);
}

describe('GET /api/push/key', () => {
  it('answers the public key derived from the private scalar', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapidFile: pair.file, vapid: pair.keys });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/push/key' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json() as { key: string };
      expect(body.key).toBe(pair.keys.publicKey);
      expect(body.key).toBe(pointOf(pair.scalar));
      // An uncompressed P-256 point: one tag byte and two 32-byte coordinates.
      const point = Buffer.from(body.key, 'base64url');
      expect(point.length).toBe(65);
      expect(point[0]).toBe(0x04);
      // The private half never leaves the module that read it.
      expect(response.body).not.toContain(pair.keys.privateKey);
    } finally {
      await h.close();
    }
  });

  it('answers 503 PUSH_OFF when the deployment has no key', async () => {
    const h = await boot({ vapid: null });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/push/key' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: 'PUSH_OFF', message: 'уведомления выключены' });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await h.close();
    }
  });

  it('answers 503 when the default path finds no file at all', async () => {
    const absent = join(tempDir(), 'no-such-vapid');
    const h = await boot({ vapidFile: absent });
    try {
      expect(readVapid(absent)).toEqual({ keys: null, problem: null });
      const response = await h.app.inject({ method: 'GET', url: '/api/push/key' });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { code: string }).code).toBe('PUSH_OFF');
    } finally {
      await h.close();
    }
  });

  it('reads an unreadable file as a stable code and still answers 503', async () => {
    const broken = join(tempDir(), 'vapid');
    writeFileSync(broken, 'not a key at all', 'utf8');
    const read = readVapid(broken);
    expect(read.keys).toBeNull();
    expect(read.problem).toBe('VAPID_KEY_INVALID');
    // The code never carries the path or the file's content.
    expect(JSON.stringify(read)).not.toContain(broken);
    expect(JSON.stringify(read)).not.toContain('not a key');

    const h = await boot({ vapidFile: broken });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/push/key' });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(broken);
    } finally {
      await h.close();
    }
  });
});

describe('POST /api/push/subscribe', () => {
  it('stores the device for the session identity and answers the count only', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      const body = subscribeBody();
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: h.headers(),
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ devices: 1 });

      const row = h.db
        .prepare('SELECT identity_id, endpoint, p256dh, auth FROM push_subscriptions')
        .get() as { identity_id: string; endpoint: string; p256dh: string; auth: string };
      expect(row.identity_id).toBe(h.identity.id);
      expect(row.endpoint).toBe(body.endpoint);

      // No capability travels back: neither the endpoint nor either key half appears in the text.
      const { keys } = body as { keys: { p256dh: string; auth: string } };
      expect(response.body).not.toContain(String(body.endpoint));
      expect(response.body).not.toContain(keys.p256dh);
      expect(response.body).not.toContain(keys.auth);
      expect(response.body).not.toContain(h.identity.id);
    } finally {
      await h.close();
    }
  });

  it('updates the same endpoint instead of adding a second device', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      const body = subscribeBody('https://push.example.com/one', 'a');
      await h.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: h.headers(), payload: body });
      h.clock.advance(1_000);
      const changed = subscribeBody('https://push.example.com/one', 'b');
      const second = await h.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: h.headers(),
        payload: changed,
      });
      expect(second.json()).toEqual({ devices: 1 });
      expect(countSubscriptions(h.db, h.identity.id)).toBe(1);
      const row = h.db.prepare('SELECT p256dh FROM push_subscriptions').get() as { p256dh: string };
      expect(row.p256dh).toBe((changed.keys as { p256dh: string }).p256dh);
    } finally {
      await h.close();
    }
  });

  it('keeps five devices and evicts the oldest', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      for (let i = 0; i < 6; i += 1) {
        h.clock.advance(1_000);
        const response = await h.app.inject({
          method: 'POST',
          url: '/api/push/subscribe',
          headers: h.headers(),
          payload: subscribeBody(`https://push.example.com/${String(i)}`, String.fromCharCode(97 + i)),
        });
        expect(response.statusCode).toBe(200);
        expect((response.json() as { devices: number }).devices).toBe(Math.min(i + 1, 5));
      }
      const kept = subscriptionsOf(h.db, h.identity.id).map((device) => device.endpoint);
      expect(kept).toHaveLength(5);
      // The first device subscribed is the one that goes; the newest five stay.
      expect(kept).not.toContain('https://push.example.com/0');
      expect(kept).toContain('https://push.example.com/5');
    } finally {
      await h.close();
    }
  });

  it('refuses a body that is not a push endpoint', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      const cases: Array<Record<string, unknown>> = [
        subscribeBody('http://push.example.com/x'),
        subscribeBody('https://127.0.0.1/x'),
        subscribeBody('https://[::1]/x'),
        subscribeBody('https://localhost/x'),
        subscribeBody('https://printer.local/x'),
        subscribeBody('https://user:pass@push.example.com/x'),
        subscribeBody('https://push.example.com:8443/x'),
        subscribeBody('https://pushservice/x'),
        subscribeBody('not a url at all'),
        { endpoint: 'https://push.example.com/x' },
        { endpoint: 'https://push.example.com/x', keys: null },
        { endpoint: 'https://push.example.com/x', keys: { p256dh: 'short', auth: 'tiny' } },
        {},
      ];
      for (const payload of cases) {
        const response = await h.app.inject({
          method: 'POST',
          url: '/api/push/subscribe',
          headers: h.headers(),
          payload,
        });
        expect(response.statusCode, JSON.stringify(payload)).toBe(422);
        expect((response.json() as { code: string }).code).toBe('INVALID');
      }
      expect(countSubscriptions(h.db, h.identity.id)).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('refuses an anonymous reader and a foreign origin', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      const anonymous = await h.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: { origin: 'https://book.test', 'content-type': 'application/json' },
        payload: subscribeBody(),
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');

      const foreign = await h.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: h.headers({ origin: 'https://evil.test' }),
        payload: subscribeBody(),
      });
      expect(foreign.statusCode).toBe(403);
      expect((foreign.json() as { code: string }).code).toBe('ORIGIN');

      const notJson = await h.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: h.headers({ 'content-type': 'text/plain' }),
        payload: JSON.stringify(subscribeBody()),
      });
      expect(notJson.statusCode).toBe(403);
      expect((notJson.json() as { code: string }).code).toBe('CONTENT_TYPE');

      expect(countSubscriptions(h.db, h.identity.id)).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('answers 503 and stores nothing when push is off', async () => {
    const h = await boot({ vapid: null });
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: h.headers(),
        payload: subscribeBody(),
      });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { code: string }).code).toBe('PUSH_OFF');
      expect(countSubscriptions(h.db, h.identity.id)).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('spends a budget: 20 writes an hour, then 429 with the wait, on both routes', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      for (let i = 0; i < PUSH_WRITE_PER_HOUR; i += 1) {
        const response = await h.app.inject({
          method: 'POST',
          url: '/api/push/subscribe',
          headers: h.headers(),
          payload: subscribeBody(`https://push.example.com/device-${String(i)}`, String.fromCharCode(97 + (i % 26))),
        });
        expect(response.statusCode, `write ${String(i)}`).toBe(200);
      }

      const refused = await h.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: h.headers(),
        payload: subscribeBody('https://push.example.com/one-too-many'),
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['cache-control']).toBe('no-store');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      const body = refused.json() as { code: string; retryAfterMs: number; resetAt?: string };
      expect(body.code).toBe('RATE_LIMITED');
      expect(body.retryAfterMs).toBeGreaterThan(0);
      expect(body.resetAt).toBe(new Date(h.clock.ms + body.retryAfterMs).toISOString());

      // Unsubscribe shares the budget: it is the same identity on the same network.
      const unsubscribe = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers(),
        payload: {},
      });
      expect(unsubscribe.statusCode).toBe(429);

      // The window is an hour: a reader who was looping gets their list back after it.
      h.clock.advance(3_600_001);
      const later = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers(),
        payload: {},
      });
      expect(later.statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe('POST /api/push/unsubscribe', () => {
  it('forgets one device of the session identity and leaves the others alone', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      const other = upsertIdentity(h.db, {
        yandexSub: 'yandex-2002',
        displayName: 'Боря',
        at: h.clock.now().toISOString(),
      });
      // Two devices of this reader, one of somebody else — including one whose endpoint is
      // exactly the one the request will name.
      upsertSubscription(h.db, h.identity.id, { endpoint: 'https://push.example.com/one', p256dh: 'a'.repeat(64), auth: 'a'.repeat(20) }, h.clock.ms);
      h.clock.advance(1_000);
      upsertSubscription(h.db, h.identity.id, { endpoint: 'https://push.example.com/two', p256dh: 'b'.repeat(64), auth: 'b'.repeat(20) }, h.clock.ms);
      h.clock.advance(1_000);
      upsertSubscription(h.db, other.id, { endpoint: 'https://push.example.com/three', p256dh: 'c'.repeat(64), auth: 'c'.repeat(20) }, h.clock.ms);

      const response = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers(),
        payload: { endpoint: 'https://push.example.com/one' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ devices: 1 });
      expect(subscriptionsOf(h.db, h.identity.id).map((device) => device.endpoint)).toEqual([
        'https://push.example.com/two',
      ]);
      expect(countSubscriptions(h.db, other.id)).toBe(1);
      expect(response.body).not.toContain('push.example.com');

      const all = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers(),
        payload: {},
      });
      expect(all.json()).toEqual({ devices: 0 });
      expect(countSubscriptions(h.db, other.id)).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('cannot delete another reader’s device by naming its endpoint', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      const other = upsertIdentity(h.db, {
        yandexSub: 'yandex-3003',
        displayName: 'Вера',
        at: h.clock.now().toISOString(),
      });
      upsertSubscription(h.db, other.id, { endpoint: 'https://push.example.com/theirs', p256dh: 'c'.repeat(64), auth: 'c'.repeat(20) }, h.clock.ms);
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers(),
        payload: { endpoint: 'https://push.example.com/theirs' },
      });
      expect(response.json()).toEqual({ devices: 0 });
      expect(countSubscriptions(h.db, other.id)).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('works with push off, because cleanup must not need the key', async () => {
    const h = await boot({ vapid: null });
    try {
      upsertSubscription(h.db, h.identity.id, { endpoint: 'https://push.example.com/left', p256dh: 'd'.repeat(64), auth: 'd'.repeat(20) }, h.clock.ms);
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers(),
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ devices: 0 });
      expect(deleteSubscription(h.db, h.identity.id)).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('refuses a stranger and a bad body', async () => {
    const pair = writeVapidKey();
    const h = await boot({ vapid: pair.keys });
    try {
      const anonymous = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: { origin: 'https://book.test', 'content-type': 'application/json' },
        payload: {},
      });
      expect(anonymous.statusCode).toBe(401);

      const bad = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers(),
        payload: { endpoint: 42 },
      });
      expect(bad.statusCode).toBe(422);
      const tooLong = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers(),
        payload: { endpoint: `https://push.example.com/${'x'.repeat(1_100)}` },
      });
      expect(tooLong.statusCode).toBe(422);

      const foreign = await h.app.inject({
        method: 'POST',
        url: '/api/push/unsubscribe',
        headers: h.headers({ origin: 'https://evil.test' }),
        payload: {},
      });
      expect(foreign.statusCode).toBe(403);
      expect((foreign.json() as { code: string }).code).toBe('ORIGIN');
      expect(foreign.headers['cache-control']).toBe('no-store');
    } finally {
      await h.close();
    }
  });
});
