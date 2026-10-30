import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { expect } from 'vitest';

import { loadConfig } from '../src/config.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';
import { createEngineFixture } from './engine/helpers.ts';
import { EngineBridge } from '../src/engineState/bridge.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { loadImprint } from '../src/imprint.ts';
import { WsHub } from '../src/ws/hub.ts';

/**
 * The shared rigs of the frame-coverage cases (BOOK-DOC-84 §2.1): a fake transport for the hub's
 * frames, a site fixture with a bridge that narrates rows as production does, and an engine
 * fixture for the writer's own path. One copy, because two test files cover the table.
 */

export const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

export type Frame = { type: string; seq?: number; data: Record<string, unknown> };

export class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: Array<{ code: number; reason: string }> = [];
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

  ping(): void {}

  terminate(): void {
    this.readyState = 3;
  }

  frames(): Frame[] {
    return this.sent.map((frame) => JSON.parse(frame) as Frame);
  }
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The site's own fixture + a bridge that narrates rows exactly as production does. */
export function siteRig(options: { seed?: Record<string, string> } = {}): {
  fixture: Fixture;
  frames: Frame[];
  bridge: EngineBridge;
  state: StateService;
} {
  const fixture = createFixture(options.seed ?? {});
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const state = new StateService(fixture.db, () => new Date(T0));
  const frames: Frame[] = [];
  const bridge = new EngineBridge({
    db: fixture.db,
    emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
    snapshot: () => state.snapshot(),
    dataDir: fixture.dataDir,
    replay: true,
    progressThrottleMs: 0,
    now: () => T0,
    maxPasses: 4,
  });
  bridge.prime();
  return { fixture, frames, bridge, state };
}

/** The engine's own fixture: the production writer path (a lease, a land, a close). */
export function engineRig(): { fixture: ReturnType<typeof createEngineFixture>; frames: Frame[]; bridge: EngineBridge } {
  const fixture = createEngineFixture({ chapters: { 5: longProse(['Первый служебный абзац главы.']) } });
  const frames: Frame[] = [];
  const bridge = new EngineBridge({
    db: fixture.db,
    emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
    dataDir: fixture.dataDir,
    replay: true,
    progressThrottleMs: 0,
    now: () => fixture.clock.now(),
    maxPasses: 4,
  });
  bridge.prime();
  return { fixture, frames, bridge };
}

/** The hub with a fake transport: `hello`/`state:snapshot`/`error`/`pong` are its frames. */
export async function hubRig(): Promise<{ hub: WsHub; socket: FakeSocket; close: () => void; fixture: Fixture }> {
  const fixture = createFixture({});
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const config = loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: fixture.dataDir });
  const state = new StateService(fixture.db, () => new Date(T0));
  const hub = new WsHub({
    db: fixture.db,
    state,
    config,
    imprint: loadImprint(config.imprintPath),
    stateThrottleMs: 0,
    now: () => new Date(T0),
    idFactory: () => 'ws_cov',
  });
  const socket = new FakeSocket();
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' } as unknown as FastifyRequest;
  hub.attach(socket as unknown as WebSocket, request);
  await flush();
  return { hub, socket, fixture, close: () => {
    hub.close();
    fixture.close();
  } };
}

export const first = (frames: Frame[], type: string): Frame => {
  const found = frames.filter((frame) => frame.type === type);
  expect(found, `exactly one ${type}`).toHaveLength(1);
  return found[0] as Frame;
};

