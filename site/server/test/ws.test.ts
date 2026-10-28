import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { TOTAL_CHAPTERS } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { ManuscriptWatcher } from '../src/ingest/watcher.ts';
import { loadImprint } from '../src/imprint.ts';
import { WsHub, type WsHubOptions } from '../src/ws/hub.ts';
import { createFixture, type Fixture } from './helpers.ts';
import type { Config } from '../src/config.ts';

const FRONT = `Без названия\n\n${'Тестовая аннотация для проверки. '.repeat(20)}\n`;

type Frame = { v: number; type: string; seq: number; ts: string; data: Record<string, unknown> };

type Client = {
  ws: WebSocket;
  frames: Frame[];
  closes: Array<{ code: number; reason: string }>;
};

type Harness = {
  fixture: Fixture;
  app: FastifyInstance;
  hub: WsHub;
  state: StateService;
  config: Config;
  connect: (headers?: Record<string, string>, upgrade?: Record<string, unknown>) => Promise<Client>;
  close: () => Promise<void>;
};

let harness: Harness | null = null;

async function boot(hubOptions: Partial<WsHubOptions> = {}): Promise<Harness> {
  const fixture = createFixture({ '00-front.md': FRONT });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const config = loadConfig({
    BOOK_ROOT: fixture.root,
    DATA_DIR: fixture.dataDir,
    WEB_DIST: fixture.dataDir,
  });
  const state = new StateService(fixture.db);
  const hub = new WsHub({
    db: fixture.db,
    state,
    config,
    imprint: loadImprint(config.imprintPath),
    stateThrottleMs: 0,
    ...hubOptions,
  });
  const app = await buildApp({ config, db: fixture.db, state, wsHub: hub, version: 'test', logger: false });
  await app.ready();

  const clients: Client[] = [];
  /**
   * `upgrade` is the rest of the injected upgrade context. `injectWS` builds a raw request
   * without a socket, so `request.ip` is undefined and the peer keys to `''`; a test that
   * needs a real network key states the loopback peer itself, then `x-forwarded-for` is
   * believed (loopback is a trusted proxy, §14).
   */
  const connect = async (
    headers: Record<string, string> = {},
    upgrade: Record<string, unknown> = {},
  ): Promise<Client> => {
    const frames: Frame[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    const ws = await app.injectWS(
      '/ws',
      { headers, ...upgrade },
      {
        onInit: (socket) => {
          socket.on('message', (data) => {
            frames.push(JSON.parse(data.toString()) as Frame);
          });
          socket.on('close', (code, reason) => {
            closes.push({ code, reason: reason.toString() });
          });
        },
      },
    );
    const client = { ws, frames, closes };
    clients.push(client);
    return client;
  };

  harness = {
    fixture,
    app,
    hub,
    state,
    config,
    connect,
    close: async () => {
      for (const client of clients) client.ws.terminate();
      await app.close();
      fixture.close();
    },
  };
  return harness;
}

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 3_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a frame');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('the upgrade origin (audit m9)', () => {
  it('closes a socket opened from another site', async () => {
    await boot();
    const foreign = await harness!.connect({ origin: 'https://evil.test' });
    const closed = await waitFor(() => foreign.closes[0]);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('ORIGIN');
    // Rejected before `hello`: a foreign page learns nothing, not even the catalogue.
    expect(foreign.frames).toHaveLength(0);
  });

  it('accepts the public origin and a loopback origin outside production', async () => {
    await boot();
    const own = await harness!.connect({ origin: harness!.config.publicOrigin });
    await waitFor(() => own.frames.find((frame) => frame.type === 'hello'));
    // The Vite dev server on 127.0.0.1 is the documented dev shape (NODE_ENV is not production).
    const dev = await harness!.connect({ origin: 'http://127.0.0.1:5173' });
    await waitFor(() => dev.frames.find((frame) => frame.type === 'hello'));
  });
});

describe('hello', () => {
  it('is the first frame and carries every slot, the first sheet and the state', async () => {
    await boot();
    const client = await harness!.connect();
    const hello = await waitFor(() => client.frames.find((frame) => frame.type === 'hello'));
    expect(hello.v).toBe(1);
    expect(hello.seq).toBe(1);
    expect(hello.data.protocolVersion).toBe(3);
    expect(hello.data.limits).toMatchObject({ commentsPerHour: 10, maxConnections: 100, perIp: 20 });
    expect(hello.data.front).toMatchObject({
      title: 'Без названия',
      imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
      // The byline count is in the first frame, so a reconnect heals page 1 (BOOK-DOC-4).
      authors: { count: 0, measuredAt: expect.any(String) },
    });
    expect((hello.data.catalog as unknown[]).length).toBe(TOTAL_CHAPTERS);
    expect((hello.data.state as Record<string, unknown>).chapters).toMatchObject({
      total: TOTAL_CHAPTERS,
      count: 0,
    });
    expect(hello.data.viewer).toEqual({ signedIn: false, displayName: null });
    expect(hello.data.comments).toEqual({ open: 0 });
  });

  it('numbers frames per connection and announces a catalog after a reconnect', async () => {
    await boot();
    const first = await harness!.connect();
    await waitFor(() => first.frames.find((frame) => frame.type === 'hello'));
    first.ws.terminate();

    harness!.fixture.write('ch01.md', 'Новая глава\n\nПервый абзац новой главы.\n');
    reconcile(harness!.fixture.db, { bookRoot: harness!.fixture.root, dataDir: harness!.fixture.dataDir });

    const second = await harness!.connect();
    const hello = await waitFor(() => second.frames.find((frame) => frame.type === 'hello'));
    const catalog = hello.data.catalog as Array<{ n: number; written: boolean; title: string | null }>;
    expect(catalog[0]).toMatchObject({ n: 1, written: true, title: 'Новая глава' });
    expect(hello.seq).toBe(1);
  });
});

describe('fan-out', () => {
  it('delivers the same frame to two readers in order', async () => {
    await boot();
    const one = await harness!.connect();
    const two = await harness!.connect();
    await waitFor(() => one.frames.find((frame) => frame.type === 'hello'));
    await waitFor(() => two.frames.find((frame) => frame.type === 'hello'));

    harness!.hub.publish('chapter:created', { n: 1, rev: 1, title: 'Глава', chars: 10 });
    harness!.hub.publish('state:updated', { version: 2, reason: 'file', chapters: { count: 1 } });

    for (const client of [one, two]) {
      const created = await waitFor(() => client.frames.find((frame) => frame.type === 'chapter:created'));
      const state = await waitFor(() => client.frames.find((frame) => frame.type === 'state:updated'));
      expect(created.data).toMatchObject({ n: 1, title: 'Глава' });
      expect(state.data.reason).toBe('file');
      expect(state.seq).toBe(created.seq + 1);
    }
  });

  it('answers ping with pong and rejects other client frames with an error', async () => {
    await boot();
    const client = await harness!.connect();
    await waitFor(() => client.frames.find((frame) => frame.type === 'hello'));

    client.ws.send(JSON.stringify({ type: 'ping', data: { t: 42 } }));
    const pong = await waitFor(() => client.frames.find((frame) => frame.type === 'pong'));
    expect(pong.data).toMatchObject({ t: 42 });

    client.ws.send(JSON.stringify({ type: 'comment', data: {} }));
    const error = await waitFor(() => client.frames.find((frame) => frame.type === 'error'));
    expect(error.data).toMatchObject({ code: 'INVALID' });
  });
});

describe('watcher → hub → two readers', () => {
  it('publishes a hand-written chapter with its title line to both browsers', async () => {
    await boot();
    const watcher = new ManuscriptWatcher({
      db: harness!.fixture.db,
      state: harness!.state,
      bookRoot: harness!.fixture.root,
      dataDir: harness!.fixture.dataDir,
      pollMs: 20,
      stabilityMs: 20,
      coalesceMs: 40,
      emit: (event) => harness!.hub.publish(event.type, event.data),
      log: () => undefined,
    });
    try {
      await watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const one = await harness!.connect();
      const two = await harness!.connect();
      await waitFor(() => one.frames.find((frame) => frame.type === 'hello'));
      await waitFor(() => two.frames.find((frame) => frame.type === 'hello'));

      writeFileSync(
        join(harness!.fixture.manuscript, 'ch05.md'),
        'Пятая глава\n\nПервый абзац пятой главы.\n\nВторой абзац пятой главы.\n',
      );

      for (const client of [one, two]) {
        const created = await waitFor(() => client.frames.find((frame) => frame.type === 'chapter:created'));
        expect(created.data).toMatchObject({ n: 5, rev: 1, title: 'Пятая глава', attributed: false });
        const state = await waitFor(() => client.frames.find((frame) => frame.type === 'state:updated'));
        expect(state.data.chapters).toMatchObject({ count: 1, written: [5] });
      }

      const hello = await (async () => {
        const third = await harness!.connect();
        return waitFor(() => third.frames.find((frame) => frame.type === 'hello'));
      })();
      const catalog = hello.data.catalog as Array<{ n: number; title: string | null }>;
      expect(catalog[4]).toMatchObject({ n: 5, title: 'Пятая глава' });
      expect((hello.data.state as { toc: Array<{ n: number; title: string | null }> }).toc[4]).toMatchObject({
        n: 5,
        title: 'Пятая глава',
      });
    } finally {
      await watcher.stop();
    }
  }, 10_000);
});

describe('capacity', () => {
  it('closes the connection over the hard limit with 1013 CAPACITY', async () => {
    await boot({ maxConnections: 2 });
    const one = await harness!.connect();
    const two = await harness!.connect();
    await waitFor(() => one.frames.find((frame) => frame.type === 'hello'));
    await waitFor(() => two.frames.find((frame) => frame.type === 'hello'));

    const three = await harness!.connect();
    const closed = await waitFor(() => (three.closes.length > 0 ? three.closes[0] : null));
    expect(closed.code).toBe(1013);
    expect(closed.reason).toBe('CAPACITY');
    expect(harness!.hub.connectionCount()).toBe(2);
  });

  it('refuses the newcomer over the per-network cap and keeps the open seats', async () => {
    await boot({ perIp: 2, maxConnections: 10 });
    const one = await harness!.connect();
    await waitFor(() => one.frames.find((frame) => frame.type === 'hello'));
    const two = await harness!.connect();
    await waitFor(() => two.frames.find((frame) => frame.type === 'hello'));

    const three = await harness!.connect();
    const closed = await waitFor(() => (three.closes.length > 0 ? three.closes[0] : null));
    expect(closed.code).toBe(1013);
    expect(closed.reason).toBe('CAPACITY');
    // The newcomer is refused before any frame: no `hello`, nothing to learn.
    expect(three.frames).toHaveLength(0);
    // BOOK-75: a reader who is already reading is never evicted to seat another — a CGNAT
    // household shares one address, and taking the oldest seat would kick a reader mid-page.
    expect(one.closes).toHaveLength(0);
    expect(two.closes).toHaveLength(0);
    expect(harness!.hub.connectionCount()).toBe(2);
    expect(harness!.hub.connectionsFor('')).toBe(2);
  });

  it('holds 100 seats, refuses the 101st, and hands a freed seat to the next reader', async () => {
    await boot({ maxConnections: 100, perIp: 20 });

    // One distinct network per seat. `injectWS` has no socket of its own, so the loopback
    // peer is stated: loopback is a trusted proxy (§14), and each forwarded address becomes
    // its own key — 100 networks, not 100 sockets behind one.
    const fromLoopback = { socket: { remoteAddress: '127.0.0.1' } };
    const readers: Client[] = [];
    for (let i = 1; i <= 100; i += 1) {
      readers.push(await harness!.connect({ 'x-forwarded-for': `10.0.1.${i}` }, fromLoopback));
      if (i % 25 === 0) {
        const batch = readers.slice(-25);
        await Promise.all(
          batch.map((client) => waitFor(() => client.frames.find((frame) => frame.type === 'hello'), 10_000)),
        );
      }
    }
    expect(harness!.hub.connectionCount()).toBe(100);

    const overflow = await harness!.connect({ 'x-forwarded-for': '10.0.2.1' }, fromLoopback);
    const closed = await waitFor(() => (overflow.closes.length > 0 ? overflow.closes[0] : null));
    expect(closed.code).toBe(1013);
    expect(closed.reason).toBe('CAPACITY');
    expect(overflow.frames).toHaveLength(0);
    expect(harness!.hub.connectionCount()).toBe(100);

    // A seat really frees: one reader leaves and the next knock is admitted with `hello`.
    readers[0]!.ws.terminate();
    await waitFor(() => (harness!.hub.connectionCount() === 99 ? true : null));
    const freed = await harness!.connect({ 'x-forwarded-for': '10.0.2.1' }, fromLoopback);
    const hello = await waitFor(() => freed.frames.find((frame) => frame.type === 'hello'));
    expect(hello.seq).toBe(1);
    expect(harness!.hub.connectionCount()).toBe(100);
  }, 30_000);
});
