import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db/db.ts';
import { EngineBridge } from '../src/engineState/bridge.ts';
import { appendChangeEvent, appendEvent } from '../src/history/log.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { loadImprint } from '../src/imprint.ts';
import { WsHub } from '../src/ws/hub.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * M4 acceptance, end to end: a stubbed change walks two chapters in both directions and
 * **two browsers** see the same narrative (§20 M4, §10.3a, §10.4). The engine rows are
 * written by SQL here; everything after them — the bridge, the hub, the envelope — is the
 * production path.
 */

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

type Frame = { v: number; type: string; seq: number; ts: string; data: Record<string, unknown> };

type Client = { ws: WebSocket; frames: Frame[] };

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

async function boots(): Promise<{ db: Db; connect: () => Promise<Client>; bridge: EngineBridge; state: StateService }> {
  fixture = createFixture({});
  const config = loadConfig({
    BOOK_ROOT: fixture.root,
    DATA_DIR: fixture.dataDir,
    WEB_DIST: fixture.dataDir,
  });
  const state = new StateService(fixture.db, () => new Date(T0));
  const hub = new WsHub({
    db: fixture.db,
    state,
    config,
    imprint: loadImprint(config.imprintPath),
    stateThrottleMs: 0,
    now: () => new Date(T0),
  });
  app = await buildApp({ config, db: fixture.db, state, wsHub: hub, version: 'test', logger: false });
  await app.ready();

  const bridge = new EngineBridge({
    db: fixture.db,
    emit: (type, data) => hub.publish(type, data),
    snapshot: () => state.snapshot(),
    replay: true,
    progressThrottleMs: 0,
    now: () => T0,
  });
  bridge.prime();

  const connect = async (): Promise<Client> => {
    const frames: Frame[] = [];
    const ws = await app!.injectWS(
      '/ws',
      {},
      {
        onInit: (socket) => {
          socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Frame));
        },
      },
    );
    return { ws, frames };
  };
  return { db: fixture.db, connect, bridge, state };
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

function insertChange(db: Db, status: string, outcome: string | null, finishedAt: string | null): void {
  db.prepare(
    `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
       status, outcome, cascade_id, model, tokens_in, tokens_out, cost_rub, enqueued_at, started_at, finished_at, attempts)
     VALUES (1, 'chg_walk', 'accepted_comment', 8, 'ключ теперь у другого человека', 2, 'sha', '[]', 'phrase',
       ?, ?, 'csc_walk', 'deepseek-flash', 100, 20, 0, ?, ?, ?, 0)`,
  ).run(status, outcome, new Date(T0).toISOString(), new Date(T0).toISOString(), finishedAt);
}

function insertCascade(db: Db, status: string, outcome: string | null, closedAt: string | null): void {
  db.prepare(
    `INSERT INTO cascades (id, change_id, status, outcome, wave, depth_fwd, depth_bwd, step_count, tokens, budget, opened_at, closed_at)
     VALUES ('csc_walk', 'chg_walk', ?, ?, 1, 1, 1, 3, 120, ?, ?, ?)`,
  ).run(
    status,
    outcome,
    JSON.stringify({ maxSteps: 8, maxWallMs: 1_800_000 }),
    new Date(T0).toISOString(),
    closedAt,
  );
}

function insertStep(
  db: Db,
  step: { id: string; seq: number; lane: 'forward' | 'backward' | null; chapter: number; boundary: number; pass: string; outcome: string | null },
): void {
  db.prepare(
    `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, outcome,
       rev_before, rev_after, seams_in, seams_out, tokens_in, tokens_out, cost_rub, at, cycle, closed_at)
     VALUES (?, 'csc_walk', ?, 1, ?, ?, ?, ?, ?, 1, 2, '[]', ?, 0, 0, 0, ?, 0, ?)`,
  ).run(
    step.id,
    step.seq,
    step.lane,
    step.pass,
    step.chapter,
    String(step.boundary),
    step.outcome,
    JSON.stringify(step.outcome === 'holds' ? [] : [{ boundary: step.chapter + 1, reason: 'соседняя глава изменена' }]),
    new Date(T0).toISOString(),
    step.outcome === null ? null : new Date(T0).toISOString(),
  );
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

describe('a change walks two chapters on two browsers', () => {
  it('moves both wings, then closes, identically for both readers', async () => {
    const { db, connect, bridge } = await boots();
    const first = await connect();
    const second = await connect();
    await waitFor(() => first.frames.find((frame) => frame.type === 'hello'));
    await waitFor(() => second.frames.find((frame) => frame.type === 'hello'));

    insertChange(db, 'processing', null, null);
    insertCascade(db, 'open', null, null);
    insertStep(db, { id: 'stp_origin', seq: 1, lane: null, chapter: 8, boundary: 8, pass: 'change', outcome: 'rewritten' });
    insertStep(db, { id: 'stp_7', seq: 2, lane: 'backward', chapter: 7, boundary: 7, pass: 'cascade', outcome: 'rewritten' });
    insertStep(db, { id: 'stp_9', seq: 3, lane: 'forward', chapter: 9, boundary: 9, pass: 'cascade', outcome: 'holds' });
    appendChangeEvent(db, 'chg_walk', 'queued', {}, T0);
    appendChangeEvent(db, 'chg_walk', 'processing', {}, T0 + 1_000);
    appendEvent(db, { kind: 'cascade.opened', changeId: 'chg_walk', cascadeId: 'csc_walk', chapter: 8 }, T0 + 1_500);
    appendEvent(db, { kind: 'step.closed', stepId: 'stp_7', cascadeId: 'csc_walk', changeId: 'chg_walk', chapter: 7, payload: { outcome: 'rewritten' } }, T0 + 2_000);
    appendEvent(db, { kind: 'step.closed', stepId: 'stp_9', cascadeId: 'csc_walk', changeId: 'chg_walk', chapter: 9, payload: { outcome: 'holds' } }, T0 + 3_000);
    bridge.tick();

    const progress = (client: Client): number[] =>
      client.frames
        .filter((frame) => frame.type === 'cascade:progress')
        .map((frame) => frame.data.chapter)
        .filter((chapter): chapter is number => typeof chapter === 'number');

    await waitFor(() => progress(first).includes(7) && progress(first).includes(9));
    await waitFor(() => progress(second).includes(7) && progress(second).includes(9));

    const down = first.frames.find((frame) => frame.type === 'cascade:progress' && frame.data.chapter === 7);
    const up = first.frames.find((frame) => frame.type === 'cascade:progress' && frame.data.chapter === 9);
    expect(down?.data).toMatchObject({ lane: 'backward', boundary: 7, touched: [7, 8, 9] });
    expect(up?.data).toMatchObject({ lane: 'forward', boundary: 9, phase: 'holds' });

    // The same narrative, in the same order, on the second browser.
    const types = (client: Client): string[] =>
      client.frames.filter((frame) => frame.type !== 'hello').map((frame) => frame.type);
    expect(types(second)).toEqual(types(first));

    // Close the change: both readers hear the decision, with its reach and no gate.
    db.prepare(`UPDATE changes SET status = 'done', outcome = 'applied', finished_at = ?, reason = NULL WHERE id = 'chg_walk'`).run(
      new Date(T0 + 5_000).toISOString(),
    );
    db.prepare(`UPDATE cascades SET status = 'closed', outcome = 'consistent', closed_at = ? WHERE id = 'csc_walk'`).run(
      new Date(T0 + 5_000).toISOString(),
    );
    appendEvent(db, { kind: 'cascade.closed', changeId: 'chg_walk', cascadeId: 'csc_walk', payload: { outcome: 'consistent' } }, T0 + 5_000);
    appendChangeEvent(db, 'chg_walk', 'decided', { outcome: 'applied' }, T0 + 5_000);
    bridge.tick();

    const decided = await waitFor(() => first.frames.find((frame) => frame.type === 'change:decided'));
    expect(decided.data).toMatchObject({
      id: 'chg_walk',
      outcome: 'applied',
      chapters: [8, 7, 9],
      cascade: { id: 'csc_walk', outcome: 'consistent', waves: 1, finding: false },
    });
    await waitFor(() => second.frames.find((frame) => frame.type === 'change:decided'));

    const raw = JSON.stringify([first.frames, second.frames]);
    for (const forbidden of ['findings', 'verdict', 'editor', 'consultant', 'HOLDS', 'GAP']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
