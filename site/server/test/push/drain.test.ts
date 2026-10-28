import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { drainPush, type PushMessage, type PushTransport } from '../../src/push/sender.ts';
import { createWebPushTransport } from '../../src/push/transport.ts';
import { createFixture, type Fixture } from '../helpers.ts';
import { DAY, T0, enqueue, outbox, resetIds, seedDevice, seedIdentity } from './fixtures.ts';

/**
 * BOOK-189 acceptance for the drain — the one place a push is actually sent.
 *
 * The transport is fake, because the questions here are not about HTTP: what happens to a row
 * when a device accepts, when a device is gone for good, when the service is briefly down, when
 * the row is older than a day, and what a log line is allowed to contain. The one real `web-push`
 * shim (`createWebPushTransport`) is tested through its own injectable send, so the payload and
 * the VAPID options are asserted without a network.
 */

let fixture: Fixture | null = null;
let db: Db;

beforeEach(() => {
  resetIds();
  fixture = createFixture();
  db = fixture.db;
});

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function recordingTransport(answer: 'ok' | 'gone' | 'error'): {
  transport: PushTransport;
  calls: Array<{ endpoint: string; message: PushMessage }>;
} {
  const calls: Array<{ endpoint: string; message: PushMessage }> = [];
  const transport: PushTransport = async (subscription, message) => {
    calls.push({ endpoint: subscription.endpoint, message });
    return { status: answer };
  };
  return { transport, calls };
}

describe('drainPush', () => {
  it('delivers the row to the device and deletes it', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    enqueue(db, author, 20, T0);
    const { transport, calls } = recordingTransport('ok');

    const result = await drainPush(db, { transport, nowMs: T0 });
    expect(result).toEqual({ sent: 1, gone: 0, failed: 0, expired: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toEqual({
      title: 'глава 20 написана',
      body: 'Бланк',
      url: '/ch/20',
      tag: 'ch20',
    });
    expect(outbox(db)).toHaveLength(0);
    // A delivered device is still a device.
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 1 });
  });

  it('forgets a dead device and drops the row when nothing is left', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/dead');
    enqueue(db, author, 20, T0);
    const { transport, calls } = recordingTransport('gone');

    const result = await drainPush(db, { transport, nowMs: T0 });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ sent: 0, gone: 1, failed: 1, expired: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
    expect(outbox(db)).toHaveLength(0);
  });

  it('keeps a row after a transient error, spaces the retry, and drops it after three attempts', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = enqueue(db, author, 20, T0);
    const { transport } = recordingTransport('error');

    const first = await drainPush(db, { transport, nowMs: T0 });
    expect(first.failed).toBe(1);
    const afterOne = db.prepare('SELECT attempts, next_at FROM push_outbox WHERE id = ?').get(id) as {
      attempts: number;
      next_at: string;
    };
    expect(afterOne.attempts).toBe(1);
    expect(afterOne.next_at).toBe('2026-10-27T12:01:00Z');

    // Not due yet: the tick finds nothing and says nothing.
    const log: string[] = [];
    const early = await drainPush(db, { transport, nowMs: T0 + 30_000, log: (line) => log.push(line) });
    expect(early).toEqual({ sent: 0, gone: 0, failed: 0, expired: 0 });
    expect(log).toEqual([]);

    await drainPush(db, { transport, nowMs: T0 + 61_000 });
    const afterTwo = db.prepare('SELECT attempts, next_at FROM push_outbox WHERE id = ?').get(id) as {
      attempts: number;
      next_at: string;
    };
    expect(afterTwo.attempts).toBe(2);
    expect(afterTwo.next_at).toBe('2026-10-27T12:03:01Z');

    const third = await drainPush(db, { transport, nowMs: T0 + 3 * 61_000 });
    expect(third.failed).toBe(1);
    expect(outbox(db)).toHaveLength(0);
    // Three attempts spent the row; the device is still there to receive a later chapter.
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 1 });
  });

  it('drops an expired row without a send', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    enqueue(db, author, 20, T0);
    const { transport, calls } = recordingTransport('ok');

    const result = await drainPush(db, { transport, nowMs: T0 + DAY });
    expect(result).toEqual({ sent: 0, gone: 0, failed: 0, expired: 1 });
    expect(calls).toHaveLength(0);
    expect(outbox(db)).toHaveLength(0);
  });

  it('drops a row whose reader has no device left', async () => {
    const author = seedIdentity(db, 'Аня');
    enqueue(db, author, 20, T0);
    const { transport, calls } = recordingTransport('ok');

    const result = await drainPush(db, { transport, nowMs: T0 });
    expect(calls).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(outbox(db)).toHaveLength(0);
  });

  it('logs counts only, never an endpoint or a payload', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/secret-endpoint');
    enqueue(db, author, 20, T0);
    enqueue(db, author, 21, T0);
    const { transport } = recordingTransport('ok');
    const log: string[] = [];

    await drainPush(db, { transport, nowMs: T0, log: (line) => log.push(line) });
    expect(log).toEqual(['push: sent=2 gone=0 failed=0 expired=0']);
    expect(log.join('\n')).not.toContain('secret-endpoint');
    expect(log.join('\n')).not.toContain('глава');
  });

  it('honours the batch limit', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    for (const chapter of [20, 21, 22]) enqueue(db, author, chapter, T0);
    const { transport, calls } = recordingTransport('ok');

    const result = await drainPush(db, { transport, nowMs: T0, limit: 2 });
    expect(result.sent).toBe(2);
    expect(calls).toHaveLength(2);
    expect(outbox(db)).toHaveLength(1);
  });

  it('sends one row once even when two drains overlap', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    enqueue(db, author, 20, T0);

    // A send that is still in flight while the second drain runs: the window in which a
    // select-then-send drain would hand the same row to a second caller.
    let releaseSend: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const calls: string[] = [];
    const transport: PushTransport = async (subscription) => {
      calls.push(subscription.endpoint);
      sendStarted();
      await gate;
      return { status: 'ok' };
    };

    const first = drainPush(db, { transport, nowMs: T0 });
    await started;
    // The row was claimed by the first tick, so the second sees nothing due and sends nothing.
    const second = await drainPush(db, { transport, nowMs: T0 });
    expect(second).toEqual({ sent: 0, gone: 0, failed: 0, expired: 0 });
    expect(calls).toHaveLength(1);

    releaseSend();
    expect(await first).toEqual({ sent: 1, gone: 0, failed: 0, expired: 0 });
    expect(calls).toHaveLength(1);
    expect(outbox(db)).toHaveLength(0);
  });

  it('keeps a claimed row when the send fails, so the next tick still owns it', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = enqueue(db, author, 20, T0);
    const transport: PushTransport = async () => ({ status: 'error' });

    await drainPush(db, { transport, nowMs: T0 });
    const row = db.prepare('SELECT attempts, next_at FROM push_outbox WHERE id = ?').get(id) as
      | { attempts: number; next_at: string }
      | undefined;
    // The claim moved `next_at` forward; the failure wrote the attempt from the database's own
    // counter and left a time in the future — the row is neither lost nor due again immediately.
    expect(row?.attempts).toBe(1);
    expect(row?.next_at).toBe('2026-10-27T12:01:00Z');
    expect(outbox(db)).toHaveLength(1);
  });

  it('tries the next device when the newest one fails', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/first', T0);
    seedDevice(db, author, 'https://push.example.com/second', T0 + 1_000);
    enqueue(db, author, 20, T0);
    const tried: string[] = [];
    const transport: PushTransport = async (subscription) => {
      tried.push(subscription.endpoint);
      return subscription.endpoint.endsWith('/second') ? { status: 'error' } : { status: 'ok' };
    };

    const result = await drainPush(db, { transport, nowMs: T0 });
    expect(result.sent).toBe(1);
    expect(tried).toEqual(['https://push.example.com/second', 'https://push.example.com/first']);
    expect(outbox(db)).toHaveLength(0);
  });

  it('spends an attempt when the transport itself throws, so one bad row cannot stall the queue', async () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = enqueue(db, author, 20, T0);
    const transport: PushTransport = async () => {
      throw new Error('the seam broke');
    };

    const result = await drainPush(db, { transport, nowMs: T0 });
    expect(result.failed).toBe(1);
    const row = db.prepare('SELECT attempts FROM push_outbox WHERE id = ?').get(id) as { attempts: number };
    expect(row.attempts).toBe(1);
    // Two more ticks and the row is gone: a throw is an attempt, not an infinite loop.
    await drainPush(db, { transport, nowMs: T0 + 61_000 });
    await drainPush(db, { transport, nowMs: T0 + 3 * 61_000 });
    expect(outbox(db)).toHaveLength(0);
  });
});

describe('createWebPushTransport', () => {
  const keys = { privateKey: 'priv', publicKey: 'pub' };
  const subject = 'https://book.test';
  const message: PushMessage = { title: 'глава 20 написана', body: 'Бланк', url: '/ch/20', tag: 'ch20' };
  const subscription = { endpoint: 'https://push.example.com/x', p256dh: 'p'.repeat(64), auth: 'a'.repeat(20) };

  it('passes the browser subscription, the serialized payload and the VAPID options', async () => {
    const seen: Array<{ subscription: unknown; payload: string; options: Record<string, unknown> }> = [];
    const transport = createWebPushTransport(keys, subject, async (sub, payload, options) => {
      seen.push({ subscription: sub, payload, options: { ...options } });
      return { statusCode: 201 };
    });

    expect(await transport(subscription, message)).toEqual({ status: 'ok' });
    expect(seen[0]?.subscription).toEqual({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    });
    expect(seen[0]?.payload).toBe(JSON.stringify(message));
    expect(seen[0]?.options).toEqual({
      vapidDetails: { subject, publicKey: 'pub', privateKey: 'priv' },
      TTL: 86_400,
      urgency: 'normal',
      topic: 'ch20',
    });
  });

  it('maps 404 and 410 to gone and every other failure to error', async () => {
    for (const statusCode of [404, 410]) {
      const transport = createWebPushTransport(keys, subject, async () => {
        throw Object.assign(new Error('gone'), { statusCode });
      });
      expect(await transport(subscription, message)).toEqual({ status: 'gone' });
    }
    for (const statusCode of [400, 429, 500]) {
      const transport = createWebPushTransport(keys, subject, async () => {
        throw Object.assign(new Error('nope'), { statusCode });
      });
      expect(await transport(subscription, message)).toEqual({ status: 'error' });
    }
    // A failure with no status at all (a socket error) is «try later», not a dead device.
    const transport = createWebPushTransport(keys, subject, async () => {
      throw new Error('ECONNRESET');
    });
    expect(await transport(subscription, message)).toEqual({ status: 'error' });
  });

  it('never puts the endpoint or the keys in what it returns', async () => {
    const transport = createWebPushTransport(keys, subject, async () => {
      throw Object.assign(new Error(`failed for ${subscription.endpoint}`), { statusCode: 503 });
    });
    const outcome = await transport(subscription, message);
    expect(JSON.stringify(outcome)).not.toContain('push.example.com');
    expect(JSON.stringify(outcome)).not.toContain(keys.privateKey);
  });
});
