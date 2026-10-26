import { describe, expect, it } from 'vitest';

import type { Db } from '../src/db/db.ts';
import { EngineBridge } from '../src/engineState/bridge.ts';
import { appendChangeEvent, appendEvent } from '../src/history/log.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * M4: the bridge turns engine rows into the reader's narrative (§10.3a) without ever
 * carrying a gate fact. The fixtures are the rows `book-engine` writes; the assertions are
 * the frames a browser would receive, in order.
 */

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

type Frame = { type: string; data: Record<string, unknown> };

function insertChange(
  db: Db,
  change: { id: string; seq: number; chapter: number; status: string; intent: string; outcome?: string | null; relevance?: string | null; cascadeId?: string | null; finishedAt?: string | null; tokensIn?: number },
): void {
  db.prepare(
    `INSERT INTO changes
       (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, status,
        relevance, outcome, cascade_id, model, tokens_in, tokens_out, cost_rub, enqueued_at, started_at, finished_at, attempts)
     VALUES (?, ?, 'accepted_comment', ?, ?, 2, 'sha', '[]', 'phrase', ?,
        ?, ?, ?, 'deepseek-flash', ?, 0, 0, ?, ?, ?, 0)`,
  ).run(
    change.seq,
    change.id,
    change.chapter,
    change.intent,
    change.status,
    change.relevance ?? null,
    change.outcome ?? null,
    change.cascadeId ?? null,
    change.tokensIn ?? 0,
    new Date(T0).toISOString(),
    new Date(T0).toISOString(),
    change.finishedAt ?? null,
  );
}

function insertCascade(db: Db, id: string, changeId: string): void {
  db.prepare(
    `INSERT INTO cascades (id, change_id, status, outcome, wave, depth_fwd, depth_bwd, step_count, tokens, budget, opened_at, closed_at)
     VALUES (?, ?, 'open', NULL, 2, 1, 2, 3, 0, ?, ?, NULL)`,
  ).run(
    id,
    changeId,
    JSON.stringify({ maxSteps: 8, maxWallMs: 1_800_000 }),
    new Date(T0).toISOString(),
  );
}

function insertStep(
  db: Db,
  step: { id: string; cascadeId: string; seq: number; lane: 'forward' | 'backward'; chapter: number; boundary: number; outcome: 'rewritten' | 'holds' | null },
): void {
  db.prepare(
    `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, outcome,
       rev_before, rev_after, seams_in, seams_out, tokens_in, tokens_out, cost_rub, at, cycle, closed_at)
     VALUES (?, ?, ?, 1, ?, 'cascade', ?, ?, ?, 1, 2, '[]', ?, 0, 0, 0, ?, 0, ?)`,
  ).run(
    step.id,
    step.cascadeId,
    step.seq,
    step.lane,
    step.chapter,
    String(step.boundary),
    step.outcome,
    JSON.stringify([{ boundary: step.chapter - 1, reason: 'соседняя глава изменена' }]),
    new Date(T0).toISOString(),
    step.outcome === null ? null : new Date(T0).toISOString(),
  );
}

function boot(replay = true, prime = true): { fixture: Fixture; frames: Frame[]; bridge: EngineBridge; state: StateService } {
  const fixture = createFixture({});
  const state = new StateService(fixture.db, () => new Date(T0));
  const frames: Frame[] = [];
  const bridge = new EngineBridge({
    db: fixture.db,
    emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
    snapshot: () => state.snapshot(),
    replay,
    progressThrottleMs: 0,
    now: () => T0,
  });
  if (prime) bridge.prime();
  return { fixture, frames, bridge, state };
}

describe('change:* mapping', () => {
  it('maps the audit log to queued → processing → stale → decided, in order', () => {
    const { fixture, frames, bridge } = boot();
    try {
      insertChange(fixture.db, {
        id: 'chg_life',
        seq: 4,
        chapter: 9,
        status: 'done',
        intent: `  ключ теперь у другого человека${' x'.repeat(200)}  `,
        outcome: 'applied',
        tokensIn: 120,
        finishedAt: new Date(T0 + 60_000).toISOString(),
        relevance: JSON.stringify({
          grade: 'partial',
          revAtRecord: 2,
          revNow: 4,
          anchor: 'edited',
          applies: 'partial',
          overlap: 0.5,
          chapterRewritten: true,
          evidence: ['абзац переписан', 'одно упоминание уже убрано'],
          decidedBy: 'writer',
          reason: 'осталось второе',
        }),
      });
      insertChange(fixture.db, { id: 'chg_wait', seq: 5, chapter: 12, status: 'pending', intent: 'ещё одно' });
      appendChangeEvent(fixture.db, 'chg_life', 'queued', {}, T0);
      appendChangeEvent(fixture.db, 'chg_life', 'processing', {}, T0 + 1_000);
      appendChangeEvent(fixture.db, 'chg_life', 'stale', { grade: 'partial' }, T0 + 2_000);
      appendChangeEvent(fixture.db, 'chg_life', 'decided', { outcome: 'applied' }, T0 + 60_000);

      bridge.tick();

      const types = frames.map((frame) => frame.type);
      expect(types).toEqual(['change:queued', 'change:processing', 'change:stale', 'change:decided', 'state:updated']);

      const queued = frames[0]?.data as Record<string, unknown>;
      expect(queued).toMatchObject({
        id: 'chg_life',
        chapter: 9,
        queue: { depth: 1, ahead: 0 },
        base: { rev: 2 },
        source: { commentId: null, author: null },
      });
      expect(String(queued.intent)).toHaveLength(280);
      expect(String(queued.intent).endsWith('…')).toBe(true);

      const processing = frames[1]?.data as Record<string, unknown>;
      expect(processing).toMatchObject({ id: 'chg_life', attempt: 1 });
      expect(processing.relevance).toMatchObject({ grade: 'partial', overlap: 0.5 });

      const stale = frames[2]?.data as Record<string, unknown>;
      expect(stale).toMatchObject({ id: 'chg_life', grade: 'partial', options: ['adapt', 'drop'] });
      expect(stale.evidence).toHaveLength(2);

      const decided = frames[3]?.data as Record<string, unknown>;
      expect(decided).toMatchObject({
        id: 'chg_life',
        outcome: 'applied',
        chapters: [9],
        tokens: { total: 120 },
        cascade: null,
        relevance: { grade: 'partial' },
      });
      expect(decided.commentId).toBeNull();
      expect(decided.reason).toBeNull();

      const snapshot = frames[4]?.data as Record<string, unknown>;
      expect(snapshot.reason).toBe('engine');
      expect((snapshot.queue as { depth: number }).depth).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('says why a dropped change was dropped, and never quotes a gate', () => {
    const { fixture, frames, bridge } = boot();
    try {
      insertChange(fixture.db, {
        id: 'chg_drop',
        seq: 1,
        chapter: 8,
        status: 'void',
        intent: 'убрать второй «слово»',
        outcome: 'dropped',
        finishedAt: new Date(T0 + 5_000).toISOString(),
      });
      fixture.db.prepare(`UPDATE changes SET reason = ? WHERE id = 'chg_drop'`).run('в главе уже одно упоминание — второе убрано');
      appendChangeEvent(fixture.db, 'chg_drop', 'queued', {}, T0);
      appendChangeEvent(fixture.db, 'chg_drop', 'decided', { outcome: 'dropped' }, T0 + 5_000);

      bridge.tick();

      const decided = frames.find((frame) => frame.type === 'change:decided')?.data as Record<string, unknown>;
      expect(decided).toMatchObject({ outcome: 'dropped', reason: 'в главе уже одно упоминание — второе убрано' });
      const raw = JSON.stringify(frames);
      for (const forbidden of ['findings', 'verdict', 'HOLDS', 'GAP', 'editor', 'consultant']) {
        expect(raw).not.toContain(forbidden);
      }
    } finally {
      fixture.close();
    }
  });
});

describe('cascade:progress mapping', () => {
  it('walks both wings, reports the frontier and carries no gate fact', () => {
    const { fixture, frames, bridge } = boot();
    try {
      insertChange(fixture.db, { id: 'chg_c', seq: 2, chapter: 8, status: 'processing', intent: 'сдвинуть ключ', cascadeId: 'csc_1' });
      insertCascade(fixture.db, 'csc_1', 'chg_c');
      insertStep(fixture.db, { id: 'stp_7', cascadeId: 'csc_1', seq: 2, lane: 'backward', chapter: 7, boundary: 7, outcome: 'rewritten' });
      insertStep(fixture.db, { id: 'stp_9', cascadeId: 'csc_1', seq: 3, lane: 'forward', chapter: 9, boundary: 9, outcome: null });

      appendEvent(fixture.db, { kind: 'cascade.opened', changeId: 'chg_c', cascadeId: 'csc_1', chapter: 8 }, T0);
      appendEvent(fixture.db, { kind: 'step.opened', stepId: 'stp_7', cascadeId: 'csc_1', changeId: 'chg_c', chapter: 7 }, T0 + 1_000);
      appendEvent(fixture.db, { kind: 'step.closed', stepId: 'stp_7', cascadeId: 'csc_1', changeId: 'chg_c', chapter: 7, payload: { outcome: 'rewritten' } }, T0 + 2_000);
      appendEvent(fixture.db, { kind: 'step.opened', stepId: 'stp_9', cascadeId: 'csc_1', changeId: 'chg_c', chapter: 9 }, T0 + 3_000);

      bridge.tick();

      const progress = frames.filter((frame) => frame.type === 'cascade:progress').map((frame) => frame.data);
      expect(progress).toHaveLength(4);
      const down = progress.find((frame) => frame.chapter === 7);
      expect(down).toMatchObject({
        cascadeId: 'csc_1',
        changeId: 'chg_c',
        lane: 'backward',
        boundary: 7,
        phase: 'rewrite',
        touched: [7, 8, 9],
        rewritten: [7],
        frontier: { forward: 9, backward: 7 },
        budget: { steps: 2, maxSteps: 8 },
      });
      expect((down?.seamsOut as Array<{ reason: string }>)[0]?.reason).toBe('соседняя глава изменена');

      const up = progress.find((frame) => frame.chapter === 9);
      expect(up).toMatchObject({ lane: 'forward', phase: 'rewrite', frontier: { forward: 9, backward: 7 } });

      const raw = JSON.stringify(frames);
      for (const forbidden of ['findings', 'verdict', 'HOLDS', 'GAP', 'editor', 'consultant']) {
        expect(raw).not.toContain(forbidden);
      }
    } finally {
      fixture.close();
    }
  });
});

describe('engine:state', () => {
  it('announces a transition and republishes the snapshot once', () => {
    const { fixture, frames, bridge } = boot();
    try {
      fixture.db.prepare(`INSERT INTO meta (k, v) VALUES ('engine.heartbeat', ?), ('engine.status', 'running')`).run(
        new Date(T0).toISOString(),
      );
      bridge.tick();

      expect(frames.map((frame) => frame.type)).toEqual(['engine:state', 'state:updated']);
      expect(frames[0]?.data).toMatchObject({ status: 'running', queue: { depth: 0 } });
      expect(frames[1]?.data.reason).toBe('engine');
      expect((frames[1]?.data.engine as { status: string }).status).toBe('running');
    } finally {
      fixture.close();
    }
  });

  it('does not replay facts that were already in the database', () => {
    const { fixture, frames, bridge } = boot(false, false);
    try {
      insertChange(fixture.db, { id: 'chg_old', seq: 1, chapter: 5, status: 'pending', intent: 'старое' });
      appendChangeEvent(fixture.db, 'chg_old', 'queued', {}, T0);
      bridge.prime();
      bridge.tick();
      expect(frames).toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
