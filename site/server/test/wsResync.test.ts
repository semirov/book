import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import type { LivePayload } from '@book/shared';

import { loadConfig } from '../src/config.ts';
import { EngineBridge } from '../src/engineState/bridge.ts';
import { appendChangeEvent } from '../src/history/log.ts';
import { applyChapterFile } from '../src/ingest/applyChapter.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { loadImprint } from '../src/imprint.ts';
import { liveSnapshot } from '../src/ws/live.ts';
import { WsHub } from '../src/ws/hub.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * BOOK-DOC-84 §3.3 — **reconnect resync is one snapshot + the frames after it**.
 *
 * The hub keeps no per-connection buffer: `hello` *is* the connect-time snapshot, and it carries
 * the `live` block, so a reader who was down while a revision, a stage and a decision happened
 * comes back to the server's own state rather than to a gap. An in-place `resync{since}` answers
 * one `state:snapshot`, and the next frame's `seq` is contiguous with it.
 *
 * The apply cursors (§3.2) are carried in the payloads — chapter `rev`, revision `hseq`, stage
 * `(passId, stageSeq)`, change `eventSeq`, filing `(commentId, at)`. The client rule is "a frame
 * whose cursor is ≤ the held one is a no-op"; this file proves the cursors exist and are
 * monotonic, and that re-feeding the same frames through a cursor map changes nothing.
 */

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

type Frame = { type: string; seq: number; data: Record<string, unknown> };

class FakeSocket {
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

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

type Rig = {
  fixture: Fixture;
  hub: WsHub;
  state: StateService;
  config: ReturnType<typeof loadConfig>;
  connect: () => Promise<FakeSocket>;
  close: () => void;
};

function rig(): Rig {
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
    idFactory: () => 'ws_resync',
  });
  const connect = async (): Promise<FakeSocket> => {
    const socket = new FakeSocket();
    const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' } as unknown as FastifyRequest;
    hub.attach(socket as unknown as WebSocket, request);
    await flush();
    return socket;
  };
  return { fixture, hub, state, config, connect, close: () => {
    hub.close();
    fixture.close();
  } };
}

/** What the server would answer for the same viewer right now: the `hello.live` of this tick. */
function serverLive(r: Rig): LivePayload {
  return liveSnapshot(
    {
      db: r.fixture.db,
      dataDir: r.fixture.dataDir,
      now: () => T0,
      queueSoftCap: r.config.queueSoftCap,
      maxPasses: r.config.writerMaxPasses,
    },
    null,
  );
}

/** The client's apply cursors (§3.2), as the page would hold them. */
type Cursors = {
  chapter: Map<number, number>;
  revision: number;
  stage: Map<string, number>;
  change: number;
  filing: Map<string, number>;
};

function emptyCursors(): Cursors {
  return { chapter: new Map(), revision: 0, stage: new Map(), change: 0, filing: new Map() };
}

/** Apply one frame to the cursors; a cursor ≤ the held one is a no-op (§3.2). */
function applyFrame(cursors: Cursors, frame: Frame): boolean {
  if (frame.type === 'chapter:created' || frame.type === 'chapter:revision' || frame.type === 'chapter:applied') {
    const n = Number(frame.data.n);
    const rev = Number(frame.data.rev);
    const held = cursors.chapter.get(n) ?? 0;
    if (rev <= held) return false;
    cursors.chapter.set(n, rev);
    const hseq = frame.data.hseq;
    if (typeof hseq === 'number' && hseq > cursors.revision) cursors.revision = hseq;
    return true;
  }
  if (frame.type === 'pass:stage' || frame.type === 'pass:accepted' || frame.type === 'pass:closed') {
    const passId = String(frame.data.passId ?? frame.data.stepId);
    const held = cursors.stage.get(passId) ?? 0;
    const seq = frame.type === 'pass:stage' ? Number(frame.data.stageSeq) : Number.MAX_SAFE_INTEGER;
    if (seq <= held) return false;
    cursors.stage.set(passId, seq);
    return true;
  }
  if (frame.type === 'change:queued' || frame.type === 'change:processing' || frame.type === 'change:adapted' || frame.type === 'change:stale' || frame.type === 'change:decided') {
    const eventSeq = Number(frame.data.eventSeq);
    if (eventSeq <= cursors.change) return false;
    cursors.change = eventSeq;
    return true;
  }
  if (frame.type === 'filing:update' || frame.type === 'comment:decision') {
    const key = String(frame.data.commentId ?? frame.data.id);
    const at = Number(frame.data.at);
    if (at <= (cursors.filing.get(key) ?? 0)) return false;
    cursors.filing.set(key, at);
    return true;
  }
  return false;
}

describe('reconnect resync', () => {
  it('hello carries the live block the server holds', async () => {
    const r = rig();
    try {
      const socket = await r.connect();
      const hello = socket.frames()[0] as Frame;
      expect(hello.type).toBe('hello');
      expect(hello.data.live).toEqual(serverLive(r));
      r.close();
    } finally {
      /* closed in the try */
    }
  });

  it('a reconnect after a write, a stage and a decision has no gap: hello.live is the server', async () => {
    const r = rig();
    try {
      const first_ = await r.connect();
      const boot = first_.frames()[0] as Frame;
      const bootRev = (boot.data.state as { front: { rev: number } }).front.rev;

      // The socket goes down; the book does not.
      first_.emit('close');
      r.hub.tick();

      // A revision (a create), a stage row and a decision happen while nobody listens.
      applyChapterFile({
        db: r.fixture.db,
        dataDir: r.fixture.dataDir,
        n: 5,
        raw: longProse(['Первый абзац главы, записанный без сокета.']),
        mtimeMs: T0,
        nowMs: T0,
      });
      r.fixture.db
        .prepare(
          `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, outcome,
             rev_before, rev_after, seams_in, seams_out, tokens_in, tokens_out, cost_rub, at, cycle, closed_at)
           VALUES ('stp_live', NULL, 1, 0, 'forward', 'draft', 5, '5', NULL, 1, NULL, '[]', '[]', 0, 0, 0, ?, 0, NULL)`,
        )
        .run(new Date(T0).toISOString());
      r.fixture.db
        .prepare(`INSERT INTO pass_stages (pass_id, chapter, stage_seq, stage, at, actor_process, summary)
                  VALUES ('stp_live', 5, 1, 'read', ?, 'writer', 'промпт собран')`)
        .run(new Date(T0 + 1_000).toISOString());
      r.fixture.db
        .prepare(
          `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
             premise, status, relevance, outcome, cascade_id, model, tokens_in, tokens_out, cost_rub, enqueued_at,
             started_at, finished_at, attempts)
           VALUES (1, 'chg_live', 'accepted_comment', 5, 'правка', 1, 'sha', '[]', 'phrase', 0, 'pending', NULL, NULL, NULL, NULL, 0, 0, 0, ?, NULL, NULL, 0)`,
        )
        .run(new Date(T0).toISOString());
      appendChangeEvent(r.fixture.db, 'chg_live', 'queued', {}, T0 + 2_000);

      const again = await r.connect();
      const hello = again.frames()[0] as Frame;
      const live = hello.data.live as LivePayload;
      expect(live).toEqual(serverLive(r));
      expect(live.passes).toEqual([
        expect.objectContaining({ chapter: 5, passId: 'stp_live', stage: 'read', stageSeq: 1, since: T0 + 1_000 }),
      ]);
      expect(live.queue.pending?.map((entry) => entry.id)).toEqual(['chg_live']);
      // The revision itself heals from the snapshot, not from a replayed frame.
      expect(r.state.snapshot().front.rev).toBe(bootRev);
      expect(hello.data.state).toMatchObject({ chapters: { written: [5] } });
    } finally {
      r.close();
    }
  });

  it('replaying the post-hello frames twice applies each cursor once', async () => {
    const r = rig();
    try {
      applyChapterFile({
        db: r.fixture.db,
        dataDir: r.fixture.dataDir,
        n: 5,
        raw: longProse(['Абзац, который пришёл один раз.']),
        mtimeMs: T0,
        nowMs: T0,
      });
      const socket = await r.connect();
      const hello = socket.frames()[0] as Frame;
      // `hello` carries the state and the live block; the frames that follow are the deltas.
      socket.sent = [];
      const frames: Frame[] = [];
      const bridge = new EngineBridge({
        db: r.fixture.db,
        emit: (type, data) => {
          frames.push({ type, seq: frames.length + 1, data: data as Record<string, unknown> });
          r.hub.publish(type, data);
        },
        dataDir: r.fixture.dataDir,
        replay: true,
        progressThrottleMs: 0,
        now: () => T0,
      });
      bridge.prime();
      bridge.tick();
      const live = socket.frames().filter((frame) => frame.type !== 'state:updated');
      expect(live.some((frame) => frame.type === 'chapter:created')).toBe(true);

      const firstPass = emptyCursors();
      for (const frame of live) applyFrame(firstPass, frame);
      const afterFirst = JSON.stringify([...firstPass.chapter]);
      const secondPass = emptyCursors();
      // A second pass over the *same* frames, on a client that already applied them.
      for (const frame of live) applyFrame(secondPass, frame);
      for (const frame of live) expect(applyFrame(secondPass, frame)).toBe(false);
      expect(JSON.stringify([...secondPass.chapter])).toBe(afterFirst);
      expect(hello.data.state).toBeDefined();
    } finally {
      r.close();
    }
  });

  it('prints a pass’s write, never an import: a stepless revision is not `live.applied` (BOOK-220 m9)', () => {
    const r = rig();
    try {
      applyChapterFile({
        db: r.fixture.db,
        dataDir: r.fixture.dataDir,
        n: 5,
        raw: longProse(['Первый импорт главы.']),
        mtimeMs: T0,
        nowMs: T0,
      });
      applyChapterFile({
        db: r.fixture.db,
        dataDir: r.fixture.dataDir,
        n: 5,
        raw: longProse(['Второй импорт главы, уже поверх текста.']),
        mtimeMs: T0 + 10,
        nowMs: T0 + 10,
      });
      // The rows are a write, but no pass wrote them: a fresh page joins no ink.
      expect(serverLive(r).applied).toBeNull();
      // The same rows under a pass's own step are the write a reader's page joins.
      r.fixture.db
        .prepare(
          `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, outcome,
             rev_before, rev_after, seams_in, seams_out, tokens_in, tokens_out, cost_rub, at, cycle, closed_at)
           VALUES ('stp_w', NULL, 1, 0, 'forward', 'draft', 5, '5', NULL, 1, NULL, '[]', '[]', 0, 0, 0, ?, 0, NULL)`,
        )
        .run(new Date(T0).toISOString());
      r.fixture.db.prepare("UPDATE revisions SET step_id = 'stp_w' WHERE chapter = 5 AND rev = 2").run();
      expect(serverLive(r).applied).toMatchObject({ n: 5, rev: 2 });
    } finally {
      r.close();
    }
  });

  it('an in-place resync{since} answers one state:snapshot and the next seq is contiguous', async () => {
    const r = rig();
    try {
      const socket = await r.connect();
      const hello = socket.frames()[0] as Frame;
      socket.sent = [];

      socket.emit('message', Buffer.from(JSON.stringify({ type: 'resync', data: { since: 7 } })), false);
      const frames = socket.frames();
      expect(frames).toHaveLength(1);
      expect(frames[0]?.type).toBe('state:snapshot');
      expect(frames[0]?.data).toMatchObject({ since: 7 });
      expect(frames[0]?.data).toHaveProperty('live');
      expect(frames[0]?.seq).toBe(hello.seq + 1);

      r.hub.publish('history:event', { hseq: 11, at: new Date(T0).toISOString() });
      const after = socket.frames().at(-1) as Frame;
      expect(after.type).toBe('history:event');
      expect(after.seq).toBe((frames[0]?.seq ?? 0) + 1);
    } finally {
      r.close();
    }
  });
});
