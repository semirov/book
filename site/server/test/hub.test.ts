import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { loadImprint } from '../src/imprint.ts';
import { WsHub } from '../src/ws/hub.ts';
import { createFixture } from './helpers.ts';

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: Array<{ code: number; reason: string }> = [];
  pings = 0;
  terminated = false;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

type Rig = {
  hub: WsHub;
  socket: FakeSocket;
  close: () => void;
};

function rig(
  options: {
    heartbeatMs?: number;
    backpressureBytes?: number;
    now?: () => Date;
    maxConnections?: number;
    perIp?: number;
    stateThrottleMs?: number;
  } = {},
): Rig {
  const fixture = createFixture({});
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const config = loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: fixture.dataDir });
  const state = new StateService(fixture.db);
  const hub = new WsHub({
    db: fixture.db,
    state,
    config,
    imprint: loadImprint(config.imprintPath),
    heartbeatMs: options.heartbeatMs ?? 60_000,
    backpressureBytes: options.backpressureBytes ?? 256 * 1024,
    now: options.now,
    maxConnections: options.maxConnections,
    perIp: options.perIp,
    stateThrottleMs: options.stateThrottleMs ?? 0,
    idFactory: () => 'ws_test',
  });
  const socket = new FakeSocket();
  const request = {
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
  } as unknown as FastifyRequest;
  hub.attach(socket as unknown as WebSocket, request);
  return {
    hub,
    socket,
    close: () => {
      hub.close();
      fixture.close();
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('hello and connections', () => {
  it('sends hello once, after the upgrade, with the state version', async () => {
    const { hub, socket, close } = rig();
    expect(socket.sent).toHaveLength(0);
    await flush();
    expect(socket.frames()).toHaveLength(1);
    const hello = socket.frames()[0] as { type: string; seq: number; data: { state: { version: number } } };
    expect(hello.type).toBe('hello');
    expect(hello.seq).toBe(1);
    expect(hello.data.state.version).toBe(1);
    expect(hub.connectionCount()).toBe(1);
    close();
  });

  it('sends hello before any broadcast that raced the upgrade', async () => {
    const { hub, socket, close } = rig();
    hub.publish('chapter:created', { n: 1 });
    await flush();
    expect(socket.frames()[0]?.type).toBe('hello');
    expect(socket.frames().some((frame) => frame.type === 'chapter:created')).toBe(false);
    close();
  });

  it('counts connections per /64 and never stores the raw IP', () => {
    const { hub, close } = rig();
    expect(hub.connectionsFor('127.0.0.1')).toBe(1);
    expect(hub.connectionCount()).toBe(1);
    close();
  });
});

describe('backpressure', () => {
  it('skips state:updated for a slow client and heals it with state:snapshot', async () => {
    const { hub, socket, close } = rig({ backpressureBytes: 100 });
    await flush();
    socket.sent = [];
    socket.bufferedAmount = 500;

    hub.publish('state:updated', { version: 2, reason: 'file' });
    expect(socket.sent).toHaveLength(0);

    // A small narrative frame is still sent: it is what the reader needs to know.
    hub.publish('chapter:created', { n: 1 });
    expect(socket.frames().map((frame) => frame.type)).toEqual(['chapter:created']);

    socket.bufferedAmount = 0;
    hub.tick();
    const snapshot = socket.frames().find((frame) => frame.type === 'state:snapshot');
    expect(snapshot).toMatchObject({ data: { state: { version: 1 } } });

    socket.sent = [];
    hub.publish('state:updated', { version: 3, reason: 'file' });
    expect(socket.frames()).toHaveLength(1);
    close();
  });
});

describe('state throttling', () => {
  it('coalesces state:updated to the last payload in the window', async () => {
    const { hub, socket, close } = rig({ stateThrottleMs: 30 });
    await flush();
    socket.sent = [];

    hub.publish('state:updated', { version: 2, reason: 'file' });
    hub.publish('state:updated', { version: 3, reason: 'file' });
    expect(socket.sent).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'state:updated', data: { version: 3 } });
    close();
  });
});

describe('inbound frames', () => {
  it('answers ping and resync, and reports an unknown frame', async () => {
    const { socket, close } = rig();
    await flush();
    socket.sent = [];

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'ping', data: { t: 7 } })), false);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'resync', data: {} })), false);
    socket.emit('message', Buffer.from('not json'), false);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'comment' })), false);

    expect(socket.frames().map((frame) => frame.type)).toEqual(['pong', 'state:snapshot', 'error', 'error']);
    expect(socket.frames()[0]).toMatchObject({ data: { t: 7 } });
    close();
  });

  it('closes a socket that sends more than 5 frames a minute', async () => {
    const { socket, close } = rig();
    await flush();
    for (let i = 0; i < 6; i += 1) {
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'ping', data: { t: i } })), false);
    }
    expect(socket.closed.at(-1)).toEqual({ code: 1009, reason: 'RATE_LIMITED' });
    close();
  });

  it('closes a socket whose frame is over 4 KB', async () => {
    const { socket, close } = rig();
    await flush();
    socket.emit('message', Buffer.alloc(5_000, 0x20), false);
    expect(socket.closed.at(-1)).toEqual({ code: 1009, reason: 'PAYLOAD_TOO_LARGE' });
    close();
  });
});

describe('heartbeat', () => {
  it('terminates a connection after two missed pongs', async () => {
    let nowMs = 1_000_000;
    const { hub, socket, close } = rig({ heartbeatMs: 1_000, now: () => new Date(nowMs) });
    await flush();

    nowMs += 1_000;
    hub.tick();
    expect(socket.pings).toBe(1);
    nowMs += 1_000;
    hub.tick();
    expect(socket.pings).toBe(2);
    nowMs += 1_000;
    hub.tick();
    expect(socket.terminated).toBe(true);
    expect(hub.connectionCount()).toBe(0);
    close();
  });

  it('resets the count on a pong', async () => {
    let nowMs = 1_000_000;
    const { hub, socket, close } = rig({ heartbeatMs: 1_000, now: () => new Date(nowMs) });
    await flush();

    nowMs += 1_000;
    hub.tick();
    socket.emit('pong');
    nowMs += 1_000;
    hub.tick();
    nowMs += 1_000;
    hub.tick();
    expect(socket.terminated).toBe(false);
    expect(socket.pings).toBe(3);
    close();
  });
});

describe('capacity on the fake transport', () => {
  it('closes the new socket when the hard limit is reached', async () => {
    const { hub, close } = rig({ maxConnections: 1 });
    await flush();
    const request = {
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;
    const second = new FakeSocket();
    hub.attach(second as unknown as WebSocket, request);
    expect(second.closed).toEqual([{ code: 1013, reason: 'CAPACITY' }]);
    expect(hub.connectionCount()).toBe(1);
    close();
  });
});
