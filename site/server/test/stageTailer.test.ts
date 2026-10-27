import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PassStageEvent } from '@book/shared';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db/db.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { loadImprint } from '../src/imprint.ts';
import { appendStage, type StageAppendInput } from '../src/stages/repo.ts';
import { StageTailer } from '../src/stages/tailer.ts';
import { WsHub } from '../src/ws/hub.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * The stage fan-out (docs/writer-lane.md §3): a socket sees each row exactly once, in the
 * store's order; a stage that happened before the tailer started is not replayed to live
 * sockets — a reconnecting client reads it from the GET route, with its original `at`.
 */

const T0 = Date.UTC(2026, 9, 27, 10, 0, 0, 456);

type Frame = { v: number; type: string; seq: number; ts: string; data: PassStageEvent };

type Booted = {
  db: Db;
  app: FastifyInstance;
  connect: () => Promise<{ frames: Frame[] }>;
  emit: (type: 'pass:stage', data: PassStageEvent) => void;
};

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let tailers: StageTailer[] = [];

async function boot(): Promise<Booted> {
  const created = createFixture({});
  fixture = created;
  const config = loadConfig({
    BOOK_ROOT: created.root,
    DATA_DIR: created.dataDir,
    WEB_DIST: created.dataDir,
    LOG_LEVEL: 'error',
  });
  const state = new StateService(created.db);
  const hub = new WsHub({
    db: created.db,
    state,
    config,
    imprint: loadImprint(config.imprintPath),
    stateThrottleMs: 0,
  });
  const built = await buildApp({ config, db: created.db, state, wsHub: hub, version: 'test', logger: false });
  app = built;
  await built.ready();

  const connect = async (): Promise<{ frames: Frame[] }> => {
    const frames: Frame[] = [];
    await built.injectWS(
      '/ws',
      {},
      {
        onInit: (socket) => {
          socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Frame));
        },
      },
    );
    await waitFor(() => frames.some((frame) => frame.type === 'hello'));
    return { frames };
  };

  return { db: created.db, app: built, connect, emit: (type, data) => hub.publish(type, data) };
}

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 4_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a frame');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedPass(db: Db, stepId: string, chapter: number): void {
  db.prepare(
    `INSERT INTO steps (step_id, seq, wave, lane, pass, chapter, boundary, at)
     VALUES (?, 1, 1, 'forward', 'change', ?, ?, '2026-10-27T09:00:00Z')`,
  ).run(stepId, chapter, String(chapter));
}

function stageInput(overrides: Partial<StageAppendInput> = {}): StageAppendInput {
  return {
    chapter: 8,
    passId: 'stp_tail',
    stage: 'read',
    at: T0,
    actor: { process: 'writer', model: null },
    summary: 'собрано: канон, соседи, задание',
    ...overrides,
  };
}

function stageFrames(frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.type === 'pass:stage');
}

beforeEach(() => {
  tailers = [];
});

afterEach(async () => {
  for (const tailer of tailers) tailer.stop();
  tailers = [];
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

describe('the stage tailer (§3)', () => {
  it('publishes exactly one `pass:stage` frame per row, ordered by seq', async () => {
    const booted = await boot();
    seedPass(booted.db, 'stp_tail', 8);
    const client = await booted.connect();
    // hello is the first frame; no stage may precede it.
    expect(client.frames.map((frame) => frame.type)).toEqual(['hello']);

    const tailer = new StageTailer({ db: booted.db, emit: booted.emit });
    tailers.push(tailer);

    appendStage(booted.db, stageInput({ stage: 'queued', at: T0 }));
    appendStage(booted.db, stageInput({ stage: 'read', at: T0 + 500 }));
    expect(tailer.poll()).toBe(2);

    const frames = await waitFor(() => {
      const found = stageFrames(client.frames);
      return found.length >= 2 ? found : null;
    });
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.data.stageSeq)).toEqual([1, 2]);
    expect(frames.map((frame) => frame.data.stage)).toEqual(['queued', 'read']);
    expect(frames.map((frame) => frame.data.at)).toEqual([T0, T0 + 500]);

    // Nothing is re-sent on the next tick: the cursor is the last published seq.
    await sleep(40);
    expect(tailer.poll()).toBe(0);
    expect(stageFrames(client.frames)).toHaveLength(2);
  });

  it('seeds the cursor at boot: rows written before it started are never published live', async () => {
    const booted = await boot();
    seedPass(booted.db, 'stp_tail', 8);
    appendStage(booted.db, stageInput({ stage: 'queued' }));
    appendStage(booted.db, stageInput({ stage: 'read' }));

    const client = await booted.connect();
    const tailer = new StageTailer({ db: booted.db, emit: booted.emit, intervalMs: 10 });
    tailers.push(tailer);
    expect(tailer.cursorSeq).toBe(2);

    tailer.start();
    await sleep(80);
    expect(stageFrames(client.frames)).toHaveLength(0);

    appendStage(booted.db, stageInput({ stage: 'drafting', at: T0 + 900 }));
    const frames = await waitFor(() => {
      const found = stageFrames(client.frames);
      return found.length > 0 ? found : null;
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data.stage).toBe('drafting');
    expect(frames[0]?.data.stageSeq).toBe(3);
  });

  it('a reconnecting client reads the same rows from GET with their original `at`', async () => {
    const booted = await boot();
    seedPass(booted.db, 'stp_tail', 8);
    const client = await booted.connect();
    const tailer = new StageTailer({ db: booted.db, emit: booted.emit, intervalMs: 10 });
    tailers.push(tailer);

    const stageAt = T0 + 1_234;
    appendStage(booted.db, stageInput({ stage: 'landed', at: stageAt, tokens: { in: 10, out: 20 }, costUsd: 0.01 }));
    tailer.poll();
    const frames = await waitFor(() => {
      const found = stageFrames(client.frames);
      return found.length > 0 ? found : null;
    });
    expect(frames[0]?.data.at).toBe(stageAt);

    const response = await booted.app.inject({ method: 'GET', url: '/api/chapters/8/stages' });
    expect(response.statusCode).toBe(200);
    const stages = (response.json() as { stages: PassStageEvent[] }).stages;
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      passId: frames[0]?.data.passId,
      stageSeq: frames[0]?.data.stageSeq,
      stage: 'landed',
      at: stageAt,
      tokens: { in: 10, out: 20 },
      costUsd: 0.01,
    });
  });
});
