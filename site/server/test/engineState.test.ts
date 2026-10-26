import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db/db.ts';
import { readEngineHealth } from '../src/engineState/reader.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * M4: the site reads the engine's rows and serves only the public projection (§9, §10.3a).
 * The fixtures below are engine rows — written with SQL here, written by `book-engine` in
 * production — plus one `gate_verdicts` row whose findings must never reach a payload.
 */

const AT = '2026-10-25T12:00:00Z';
const LATER = '2026-10-25T12:05:00Z';
const RELEVANCE_PARTIAL = JSON.stringify({
  grade: 'partial',
  revAtRecord: 3,
  revNow: 5,
  anchor: 'edited',
  applies: 'partial',
  overlap: 0.55,
  chapterRewritten: true,
  evidence: ['абзац переписан в ревизии 5', 'одно упоминание уже убрано'],
  decidedBy: 'writer',
  reason: 'осталось второе упоминание',
});

const BUDGET = JSON.stringify({ maxWave: 3, maxChapters: 5, maxSteps: 8, maxUpwardLag: 1, maxWallMs: 1_800_000 });

function insertChange(
  db: Db,
  change: {
    id: string;
    seq: number;
    chapter: number;
    status: string;
    intent: string;
    relevance?: string | null;
    outcome?: string | null;
    reason?: string | null;
    cascadeId?: string | null;
    tokensIn?: number;
    tokensOut?: number;
    model?: string | null;
    enqueuedAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    commentId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO changes
       (seq, id, kind, chapter, intent, source_comment, base_rev, base_sha256, base_blocks,
        scope_hint, status, relevance, outcome, reason, cascade_id, model, tokens_in, tokens_out,
        cost_rub, enqueued_at, started_at, finished_at, attempts)
     VALUES
       (@seq, @id, 'accepted_comment', @chapter, @intent, @commentId, 3, 'sha', '[]',
        'phrase', @status, @relevance, @outcome, @reason, @cascadeId, @model, @tokensIn, @tokensOut,
        0, @enqueuedAt, @startedAt, @finishedAt, 0)`,
  ).run({
    seq: change.seq,
    id: change.id,
    chapter: change.chapter,
    intent: change.intent,
    commentId: change.commentId ?? null,
    status: change.status,
    relevance: change.relevance ?? null,
    outcome: change.outcome ?? null,
    reason: change.reason ?? null,
    cascadeId: change.cascadeId ?? null,
    model: change.model ?? null,
    tokensIn: change.tokensIn ?? 0,
    tokensOut: change.tokensOut ?? 0,
    enqueuedAt: change.enqueuedAt ?? AT,
    startedAt: change.startedAt ?? null,
    finishedAt: change.finishedAt ?? null,
  });
}

function insertCascade(
  db: Db,
  cascade: { id: string; changeId: string; status: string; outcome: string | null; wave?: number },
): void {
  db.prepare(
    `INSERT INTO cascades (id, change_id, status, outcome, wave, depth_fwd, depth_bwd, step_count, tokens, budget, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, 2, 0, ?, ?, ?)`,
  ).run(
    cascade.id,
    cascade.changeId,
    cascade.status,
    cascade.outcome,
    cascade.wave ?? 1,
    BUDGET,
    AT,
    cascade.status === 'open' ? null : LATER,
  );
}

function insertStep(
  db: Db,
  step: {
    id: string;
    cascadeId: string | null;
    seq: number;
    wave?: number;
    lane?: 'forward' | 'backward' | null;
    pass?: string;
    chapter: number | null;
    boundary: string;
    outcome: string | null;
    revBefore?: number | null;
    revAfter?: number | null;
    seamsOut?: unknown;
    seamsIn?: unknown;
    cycle?: number;
    hseqFrom?: number | null;
    hseqTo?: number | null;
    note?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO steps
       (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, outcome, rev_before, rev_after,
        seams_in, seams_out, blocks_touched, chars_delta, model, tokens_in, tokens_out, cost_rub,
        hseq_from, hseq_to, lease_id, session, at, ms, note, cycle, closed_at)
     VALUES
       (@id, @cascadeId, @seq, @wave, @lane, @pass, @chapter, @boundary, @outcome, @revBefore, @revAfter,
        @seamsIn, @seamsOut, 2, 41, NULL, 100, 40, 0,
        @hseqFrom, @hseqTo, NULL, 'fwd', @at, 1000, @note, @cycle, @closedAt)`,
  ).run({
    id: step.id,
    cascadeId: step.cascadeId,
    seq: step.seq,
    wave: step.wave ?? 0,
    lane: step.lane ?? null,
    pass: step.pass ?? 'cascade',
    chapter: step.chapter,
    boundary: step.boundary,
    outcome: step.outcome,
    revBefore: step.revBefore ?? null,
    revAfter: step.revAfter ?? null,
    seamsIn: JSON.stringify(step.seamsIn ?? []),
    seamsOut: JSON.stringify(step.seamsOut ?? []),
    hseqFrom: step.hseqFrom ?? null,
    hseqTo: step.hseqTo ?? null,
    note: step.note ?? null,
    cycle: step.cycle ?? 0,
    at: AT,
    closedAt: step.outcome === null ? null : LATER,
  });
}

function insertLease(
  db: Db,
  lease: { id: string; stepId: string; changeId: string; cascadeId: string | null; lane: string | null; chapter: number | null; kind: string },
): void {
  db.prepare(
    `INSERT INTO leases (id, step_id, change_id, cascade_id, lane, chapter, is_front, kind, session,
       expected_rev, acquired_at, heartbeat_at, expires_at, released_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'fwd', 3, ?, ?, ?, NULL)`,
  ).run(lease.id, lease.stepId, lease.changeId, lease.cascadeId, lease.lane, lease.chapter, lease.kind, AT, AT, '2026-10-25T12:02:00Z');
}

/** The engine's writer side of the fixtures: one open ripple and one escalated seam. */
function seed(db: Db): void {
  insertChange(db, {
    id: 'chg_pending',
    seq: 1,
    chapter: 8,
    status: 'pending',
    intent: '  в абзаце дважды «намок» —   оставить одно упоминание  ',
  });
  insertChange(db, {
    id: 'chg_open',
    seq: 2,
    chapter: 9,
    status: 'processing',
    intent: 'ключ теперь у другого человека',
    relevance: RELEVANCE_PARTIAL,
    cascadeId: 'csc_open',
    startedAt: AT,
    tokensIn: 120,
    tokensOut: 60,
    model: 'deepseek-flash',
  });
  insertCascade(db, { id: 'csc_open', changeId: 'chg_open', status: 'open', outcome: null });
  insertStep(db, {
    id: 'stp_origin',
    cascadeId: 'csc_open',
    seq: 1,
    chapter: 9,
    boundary: '9',
    pass: 'change',
    outcome: 'rewritten',
    revBefore: 3,
    revAfter: 4,
    seamsOut: [{ boundary: 10, reason: 'в главе 10 сказано, что ключ у него' }],
    hseqFrom: 10,
    hseqTo: 11,
    cycle: 2,
  });
  insertStep(db, {
    id: 'stp_up',
    cascadeId: 'csc_open',
    seq: 2,
    wave: 1,
    lane: 'forward',
    chapter: 10,
    boundary: '10',
    outcome: 'rewritten',
    revBefore: 1,
    revAfter: 2,
    seamsIn: [{ boundary: 10, reason: 'в главе 10 сказано, что ключ у него' }],
    hseqFrom: 12,
    hseqTo: 13,
  });
  insertLease(db, {
    id: 'lea_up',
    stepId: 'stp_up',
    changeId: 'chg_open',
    cascadeId: 'csc_open',
    lane: 'forward',
    chapter: 10,
    kind: 'cascade',
  });
  db.prepare(
    `INSERT INTO gate_verdicts (step_id, role, verdict, findings, cycles, model, tokens_in, tokens_out, at)
     VALUES ('stp_origin', 'editor', 'GAP', ?, 2, 'deepseek-flash', 10, 5, ?)`,
  ).run(
    JSON.stringify([{ severity: 'blocker', location: 'глава 9', defect: 'секретный вывод редактора', fix: 'переписать' }]),
    AT,
  );

  // An escalated ripple: its seam must survive a reload as a dashed marker.
  insertChange(db, {
    id: 'chg_escalated',
    seq: 3,
    chapter: 7,
    status: 'escalated',
    intent: 'довести до конца',
    outcome: 'budget',
    reason: 'правка остановлена бюджетом — нужно решение',
    cascadeId: 'csc_escalated',
    enqueuedAt: '2026-10-25T11:00:00Z',
    startedAt: '2026-10-25T11:01:00Z',
    finishedAt: LATER,
  });
  insertCascade(db, { id: 'csc_escalated', changeId: 'chg_escalated', status: 'escalated', outcome: 'escalated:budget' });
  insertStep(db, {
    id: 'stp_down',
    cascadeId: 'csc_escalated',
    seq: 1,
    wave: 1,
    lane: 'backward',
    chapter: 7,
    boundary: '7',
    outcome: 'rewritten',
    revBefore: 2,
    revAfter: 3,
    seamsOut: [{ boundary: 6, reason: 'ключ теперь у другого' }],
  });
}

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

async function boot(): Promise<Fixture> {
  fixture = createFixture({});
  seed(fixture.db);
  app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: fixture.dataDir,
      PORT: '8080',
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
  });
  return fixture;
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

describe('GET /api/queue', () => {
  it('reports depth, head, live stage and the state counts', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/queue' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.depth).toBe(1);
    expect(body.byState).toMatchObject({ pending: 1, processing: 1, escalated: 1 });
    expect(body.head).toMatchObject({ id: 'chg_pending', chapter: 8 });
    expect(body.processing).toMatchObject({ id: 'chg_open', chapter: 9, stage: 'cascade' });
    expect(body.lastDecidedAt).toBe(LATER);
  });
});

describe('GET /api/changes', () => {
  it('lists newest first, caps the intent and carries the ripple reach', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/changes' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<Record<string, unknown>>;
    expect(body.map((row) => row.id)).toEqual(['chg_escalated', 'chg_open', 'chg_pending']);
    expect(body[2]).toMatchObject({ chapter: 8, status: 'pending', position: 1 });
    expect(body[2]?.intent).toBe('в абзаце дважды «намок» — оставить одно упоминание');
    expect(body[1]).toMatchObject({ status: 'processing', position: null });
    expect(body[1]?.chapters).toEqual([9, 10]);
    expect(body[0]).toMatchObject({ reason: 'правка остановлена бюджетом — нужно решение' });
  });

  it('filters by status and chapter and refuses an invalid filter', async () => {
    await boot();
    const byStatus = await app!.inject({ method: 'GET', url: '/api/changes?status=escalated' });
    expect((byStatus.json() as Array<{ id: string }>).map((row) => row.id)).toEqual(['chg_escalated']);

    const byChapter = await app!.inject({ method: 'GET', url: '/api/changes?chapter=8' });
    expect((byChapter.json() as Array<{ id: string }>).map((row) => row.id)).toEqual(['chg_pending']);

    expect((await app!.inject({ method: 'GET', url: '/api/changes?status=wat' })).statusCode).toBe(400);
    expect((await app!.inject({ method: 'GET', url: '/api/changes?chapter=99' })).statusCode).toBe(400);
    expect((await app!.inject({ method: 'GET', url: '/api/changes?limit=0' })).statusCode).toBe(400);
  });
});

describe('GET /api/changes/:id', () => {
  it('serves steps, seams, relevance, cost and history — never a gate field', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/changes/chg_open' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: 'chg_open',
      chapter: 9,
      status: 'processing',
      base: { rev: 3 },
      source: { commentId: null, author: null },
    });
    expect(body.relevance).toMatchObject({ grade: 'partial', anchor: 'edited', overlap: 0.55 });
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0]).toMatchObject({
      chapter: 9,
      wing: null,
      outcome: 'rewritten',
      cycles: 2,
      seamsOut: [{ boundary: 10, reason: 'в главе 10 сказано, что ключ у него' }],
    });
    expect(body.cascade).toMatchObject({
      id: 'csc_open',
      status: 'open',
      chaptersRewritten: [9, 10],
      gates: { cycles: 2, findingSurvived: false },
    });
    expect(body.appliedRevs).toEqual([
      { chapter: 9, rev: 4 },
      { chapter: 10, rev: 2 },
    ]);
    expect(body.cost).toMatchObject({ model: 'deepseek-flash', tokensIn: 120, tokensOut: 60 });
    expect(body.history).toEqual({ fromHseq: 10, toHseq: 13 });

    const raw = JSON.stringify(body);
    for (const forbidden of ['findings', 'verdict', 'editor', 'consultant', 'HOLDS', 'GAP', 'секретный вывод']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('answers 404 for an unknown change', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/api/changes/chg_nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('state overlay and /healthz', () => {
  it('carries queue, the open ripple and the escalated seam into the snapshot across reloads', async () => {
    await boot();
    const first = await app!.inject({ method: 'GET', url: '/api/state' });
    const state = first.json();
    expect(state.queue).toMatchObject({ depth: 1, processing: { id: 'chg_open' } });
    expect(state.cascade).toMatchObject({
      id: 'csc_open',
      changeId: 'chg_open',
      stepChapter: null,
      frontier: { forward: 10, backward: 9 },
      touched: [9, 10],
      rewritten: [9, 10],
    });
    expect(state.unresolved).toEqual([
      {
        boundary: 6,
        reason: 'budget',
        changeId: 'chg_escalated',
        since: LATER,
        note: 'ключ теперь у другого',
      },
    ]);
    expect(state.current).toMatchObject({ chapter: 10, kind: 'cascade', lane: 'forward' });

    const second = (await app!.inject({ method: 'GET', url: '/api/state' })).json();
    expect(second.unresolved).toEqual(state.unresolved);
    expect(second.version).toBe(state.version);
  });

  it('bumps the snapshot version when the queue moves', async () => {
    const local = await boot();
    const before = (await app!.inject({ method: 'GET', url: '/api/state' })).json();
    insertChange(local.db, { id: 'chg_new', seq: 4, chapter: 12, status: 'pending', intent: 'новое замечание' });
    const after = (await app!.inject({ method: 'GET', url: '/api/state' })).json();
    expect(after.queue.depth).toBe(2);
    expect(after.version).toBeGreaterThan(before.version);
  });

  it('reports absent, running and down from the heartbeat', async () => {
    const local = await boot();
    const absent = (await app!.inject({ method: 'GET', url: '/healthz' })).json();
    // The public probe carries the status only; the heartbeat and the lane holder are
    // operator facts (audit m4) and are asserted on `readEngineHealth` below.
    expect(absent.engine).toEqual({ status: 'absent' });
    expect(absent).not.toHaveProperty('lane');

    const now = Date.now();
    local.db.prepare(`INSERT INTO meta (k, v) VALUES ('engine.heartbeat', ?), ('engine.status', 'running')`).run(
      new Date(now - 1_000).toISOString(),
    );
    expect(readEngineHealth(local.db, now).status).toBe('running');
    expect((await app!.inject({ method: 'GET', url: '/healthz' })).json().engine).toMatchObject({ status: 'running' });

    local.db.prepare(`UPDATE meta SET v = ? WHERE k = 'engine.heartbeat'`).run(new Date(now - 10 * 60_000).toISOString());
    expect(readEngineHealth(local.db, now).status).toBe('down');
    expect((await app!.inject({ method: 'GET', url: '/healthz' })).json().engine).toMatchObject({ status: 'down' });

    local.db.prepare(`UPDATE meta SET v = ? WHERE k = 'engine.heartbeat'`).run(new Date(now).toISOString());
    local.db.prepare(`UPDATE meta SET v = 'paused' WHERE k = 'engine.status'`).run();
    expect(readEngineHealth(local.db, now).status).toBe('paused');
  });
});
