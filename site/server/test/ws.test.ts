import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
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

const FRONT = `Земля, которая больше не кормит\n\n${'Книга о том, как вещи научились обходиться без тех, кто их завёл. '.repeat(
  5,
)}\n`;

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
  connect: (headers?: Record<string, string>) => Promise<Client>;
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
  const connect = async (headers: Record<string, string> = {}): Promise<Client> => {
    const frames: Frame[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    const ws = await app.injectWS(
      '/ws',
      { headers },
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

describe('hello', () => {
  it('is the first frame and carries all 67 slots, the first sheet and the state', async () => {
    await boot();
    const client = await harness!.connect();
    const hello = await waitFor(() => client.frames.find((frame) => frame.type === 'hello'));
    expect(hello.v).toBe(1);
    expect(hello.seq).toBe(1);
    expect(hello.data.protocolVersion).toBe(3);
    expect(hello.data.limits).toMatchObject({ commentsPerHour: 10, maxConnections: 100, perIp: 4 });
    expect(hello.data.front).toMatchObject({
      title: 'Земля, которая больше не кормит',
      imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
    });
    expect((hello.data.catalog as unknown[]).length).toBe(67);
    expect((hello.data.state as Record<string, unknown>).chapters).toMatchObject({ total: 67, count: 0 });
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

  it('closes the oldest connection of an IP over the soft per-IP cap', async () => {
    await boot({ perIp: 2, maxConnections: 10 });
    const one = await harness!.connect();
    await waitFor(() => one.frames.find((frame) => frame.type === 'hello'));
    const two = await harness!.connect();
    await waitFor(() => two.frames.find((frame) => frame.type === 'hello'));
    const three = await harness!.connect();
    await waitFor(() => three.frames.find((frame) => frame.type === 'hello'));

    const closed = await waitFor(() => (one.closes.length > 0 ? one.closes[0] : null));
    expect(closed.code).toBe(1013);
    expect(harness!.hub.connectionCount()).toBe(2);
    expect(harness!.hub.connectionsFor('')).toBe(2);
  });
});
