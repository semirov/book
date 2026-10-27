import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  STAGE_SPAN_MAX_CHARS,
  STAGE_SUMMARY_MAX_CHARS,
  type PassStageEvent,
} from '@book/shared';

import { buildApp } from '../src/app.ts';
import type { Db } from '../src/db/db.ts';
import { buildControl } from '../src/engine/control.ts';
import { isReadLimited } from '../src/http/readLimit.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { ManuscriptWatcher, type IngestEvent } from '../src/ingest/watcher.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { appendStage, listStages, maxStageSeq, nextStageSeq, resolvePass, StageInputError } from '../src/stages/repo.ts';
import { createFixture, type Fixture } from './helpers.ts';
import { createEngineFixture, type Fixture as EngineFixture } from './engine/helpers.ts';

/**
 * The stage store (docs/writer-lane.md §2–§3): the event shape, the pass-local counter, the
 * one-write-door rule, and the replay the reader's page asks for. Everything runs on a real
 * database; the engine fixture is only how `buildControl` gets the same db the site reads.
 */

const TOKEN = 'stage-token';
/** Whole milliseconds: `at` must come back exactly as the lane observed it. */
const T0 = Date.UTC(2026, 9, 27, 9, 0, 0, 123);

type Ctx = {
  db: Db;
  control: FastifyInstance;
  app: FastifyInstance;
};

let engineFixture: EngineFixture | null = null;
let ctx: Ctx | null = null;

/** One engine row set: a step, and (optionally) the change with a live lease that owns it. */
function seedPass(db: Db, stepId: string, chapter: number, changeId: string | null = null): void {
  db.prepare(
    `INSERT INTO steps (step_id, seq, wave, lane, pass, chapter, boundary, at)
     VALUES (?, 1, 1, 'forward', 'change', ?, ?, '2026-10-27T09:00:00Z')`,
  ).run(stepId, chapter, String(chapter));
  if (changeId === null) return;
  db.prepare(
    `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
       status, enqueued_at)
     VALUES (1, ?, 'continuity', ?, 'сшить соседние главы', 1, 'sha', '[]', 'phrase', 'processing',
       '2026-10-27T09:00:00Z')`,
  ).run(changeId, chapter);
  db.prepare(
    `INSERT INTO leases (id, step_id, change_id, lane, chapter, is_front, kind, session, expected_rev,
       acquired_at, heartbeat_at, expires_at)
     VALUES ('lea_s', ?, ?, 'forward', ?, 0, 'change', 'writer-fwd', 1,
       '2026-10-27T09:00:00Z', '2026-10-27T09:00:00Z', '2030-01-01T00:00:00Z')`,
  ).run(stepId, changeId, chapter);
}

beforeEach(async () => {
  engineFixture = createEngineFixture({});
  const db = engineFixture.db;
  const control = await buildControl({ engine: engineFixture.engine, db, token: TOKEN, logger: false });
  const state = new StateService(db);
  const app = await buildApp({
    config: { ...engineFixture.config, webDist: engineFixture.dataDir },
    db,
    state,
    version: 'test',
    logger: false,
  });
  await app.ready();
  ctx = { db, control, app };
});

afterEach(async () => {
  await ctx?.control.close();
  await ctx?.app.close();
  engineFixture?.close();
  ctx = null;
  engineFixture = null;
});

function stageInput(overrides: Record<string, unknown> = {}): Parameters<typeof appendStage>[1] {
  return {
    chapter: 8,
    passId: 'stp_a',
    stage: 'read',
    at: T0,
    actor: { process: 'writer', model: 'deepseek-flash' },
    summary: 'собрано: канон, соседи, задание',
    ...overrides,
  } as Parameters<typeof appendStage>[1];
}

function refusalOf(run: () => unknown): StageInputError {
  try {
    run();
  } catch (error) {
    if (error instanceof StageInputError) return error;
    throw error;
  }
  throw new Error('the store accepted an input it must refuse');
}

describe('the stage store (§3)', () => {
  it('round-trips one stage through the table and keeps `at` in milliseconds', () => {
    const event = appendStage(ctx!.db, stageInput());
    expect(event).toEqual({
      passId: 'stp_a',
      chapter: 8,
      stageSeq: 1,
      stage: 'read',
      at: T0,
      actor: { process: 'writer', model: 'deepseek-flash' },
      changeId: null,
      summary: 'собрано: канон, соседи, задание',
      span: null,
      tokens: null,
      costUsd: null,
    });
    expect(listStages(ctx!.db, 8)).toEqual([event]);
    expect(maxStageSeq(ctx!.db)).toBe(1);
    expect(nextStageSeq(ctx!.db, 'stp_a')).toBe(2);
  });

  it('assigns stage_seq per pass, never per chapter', () => {
    seedPass(ctx!.db, 'stp_a', 8);
    seedPass(ctx!.db, 'stp_b', 8);
    expect(appendStage(ctx!.db, stageInput({ passId: 'stp_a' })).stageSeq).toBe(1);
    expect(appendStage(ctx!.db, stageInput({ passId: 'stp_a', stage: 'drafting' })).stageSeq).toBe(2);
    expect(appendStage(ctx!.db, stageInput({ passId: 'stp_b' })).stageSeq).toBe(1);
    expect(appendStage(ctx!.db, stageInput({ passId: 'stp_a', stage: 'landed' })).stageSeq).toBe(3);
    expect(appendStage(ctx!.db, stageInput({ passId: 'stp_b', stage: 'drafting' })).stageSeq).toBe(2);
  });

  it('returns the stored row on a repeated (pass_id, stage_seq) instead of throwing', () => {
    const first = appendStage(ctx!.db, stageInput({ passId: 'stp_r', stageSeq: 1, summary: 'первый' }));
    const second = appendStage(ctx!.db, stageInput({ passId: 'stp_r', stageSeq: 1, summary: 'второй' }));
    expect(second).toEqual(first);
    expect(second.summary).toBe('первый');
    const count = ctx!.db.prepare('SELECT COUNT(*) AS n FROM pass_stages WHERE pass_id = ?').get('stp_r') as { n: number };
    expect(count.n).toBe(1);
  });

  it('cuts the summary at 200 chars and each span side at 2000, flagging the cut', () => {
    const summary = 'а'.repeat(STAGE_SUMMARY_MAX_CHARS + 1);
    const event = appendStage(
      ctx!.db,
      stageInput({
        passId: 'stp_bounds',
        stage: 'landed',
        summary,
        span: [
          { blockId: 'ch08#aaaa', before: 'б'.repeat(STAGE_SPAN_MAX_CHARS + 1), after: 'в' },
          { blockId: null, before: 'г'.repeat(STAGE_SPAN_MAX_CHARS), after: '' },
          { before: '', after: 'новая строка', truncated: true },
        ],
        tokens: { in: 9_120, out: 8_400 },
        costUsd: 0.42,
      }),
    );
    expect(STAGE_SUMMARY_MAX_CHARS).toBe(200);
    expect(STAGE_SPAN_MAX_CHARS).toBe(2_000);
    expect(event.summary).toHaveLength(200);
    expect(event.span?.[0]).toEqual({
      blockId: 'ch08#aaaa',
      before: 'б'.repeat(2_000),
      after: 'в',
      truncated: true,
    });
    expect(event.span?.[1]).toMatchObject({ blockId: null, truncated: false });
    expect(event.span?.[1]?.before).toHaveLength(2_000);
    expect(event.span?.[2]).toMatchObject({ before: '', after: 'новая строка', truncated: true });
    expect(event.tokens).toEqual({ in: 9_120, out: 8_400 });
    expect(event.costUsd).toBe(0.42);
  });

  it('refuses an unknown stage, an unknown actor and an empty summary without writing a row', () => {
    expect(refusalOf(() => appendStage(ctx!.db, stageInput({ stage: 'thinking' }))).code).toBe('UNKNOWN_STAGE');
    expect(refusalOf(() => appendStage(ctx!.db, stageInput({ actor: { process: 'robot' } }))).code).toBe('UNKNOWN_ACTOR');
    expect(refusalOf(() => appendStage(ctx!.db, stageInput({ summary: '   ' }))).code).toBe('INVALID_STAGE');
    expect(refusalOf(() => appendStage(ctx!.db, stageInput({ tokens: { in: 1 } as never }))).code).toBe('INVALID_STAGE');
    expect(refusalOf(() => appendStage(ctx!.db, stageInput({ costUsd: -1 }))).code).toBe('INVALID_STAGE');
    expect(refusalOf(() => appendStage(ctx!.db, stageInput({ at: 1e16 }))).code).toBe('INVALID_STAGE');
    expect(maxStageSeq(ctx!.db)).toBe(0);
    // An empty span is "nothing replaced": the event carries null, not [].
    expect(appendStage(ctx!.db, stageInput({ stage: 'landed', span: [] })).span).toBeNull();
  });

  it('reads the pass chapter and its change from the step, not from the caller', () => {
    seedPass(ctx!.db, 'stp_c', 8, 'chg_c');
    const pass = resolvePass(ctx!.db, 'stp_c');
    expect(pass).toEqual({ chapter: 8, changeId: 'chg_c' });
    expect(resolvePass(ctx!.db, 'stp_missing')).toBeNull();
    const event = appendStage(ctx!.db, {
      ...stageInput({ passId: 'stp_c' }),
      chapter: pass!.chapter,
      changeId: pass!.changeId,
    });
    expect(event.chapter).toBe(8);
    expect(event.changeId).toBe('chg_c');
  });
});

describe('POST /internal/stage (§3)', () => {
  function post(payload: Record<string, unknown>, token = TOKEN) {
    return ctx!.control.inject({
      method: 'POST',
      url: '/internal/stage',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it('requires the bearer token', async () => {
    const response = await post({ ...stageInput() }, 'nope');
    expect(response.statusCode).toBe(401);
  });

  it('refuses an unknown pass with 422 UNKNOWN_PASS', async () => {
    const response = await post({ ...stageInput({ passId: 'stp_nowhere' }) });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'UNKNOWN_PASS' });
  });

  it('takes the chapter from the step, ignores a chapter in the body, and resolves the change', async () => {
    seedPass(ctx!.db, 'stp_http', 8, 'chg_http');
    const base = stageInput({ passId: 'stp_http', stage: 'drafting' });
    const response = await post({
      passId: base.passId,
      stage: base.stage,
      at: base.at,
      actor: base.actor,
      summary: base.summary,
      chapter: 66,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; data: PassStageEvent };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ passId: 'stp_http', chapter: 8, stageSeq: 1, changeId: 'chg_http' });
    const stored = ctx!.db.prepare('SELECT chapter FROM pass_stages WHERE pass_id = ?').get('stp_http') as { chapter: number };
    expect(stored.chapter).toBe(8);
  });

  it('refuses an unknown stage with the validator’s code, not a 500', async () => {
    seedPass(ctx!.db, 'stp_http2', 8);
    const response = await post({ ...stageInput({ passId: 'stp_http2', stage: 'thinking' }) });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'UNKNOWN_STAGE' });
  });

  it('is idempotent: a retried call with the same stageSeq returns the same event', async () => {
    seedPass(ctx!.db, 'stp_http3', 8);
    const payload = { ...stageInput({ passId: 'stp_http3', stageSeq: 1 }) };
    const first = await post(payload);
    const second = await post(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const rows = ctx!.db.prepare('SELECT COUNT(*) AS n FROM pass_stages WHERE pass_id = ?').get('stp_http3') as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('GET /api/chapters/:n/stages (§3)', () => {
  it('returns newest pass first, stage_seq order inside a pass, `at` in ms', async () => {
    seedPass(ctx!.db, 'stp_old', 8);
    seedPass(ctx!.db, 'stp_new', 8);
    appendStage(ctx!.db, stageInput({ passId: 'stp_old', stage: 'queued', at: T0 }));
    appendStage(ctx!.db, stageInput({ passId: 'stp_old', stage: 'read', at: T0 + 1_000 }));
    appendStage(ctx!.db, stageInput({ passId: 'stp_new', stage: 'queued', at: T0 + 2_000 }));
    appendStage(ctx!.db, stageInput({ passId: 'stp_new', stage: 'drafting', at: T0 + 3_000 }));

    const response = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/8/stages' });
    expect(response.statusCode).toBe(200);
    const stages = (response.json() as { stages: PassStageEvent[] }).stages;
    expect(stages.map((stage) => stage.passId)).toEqual(['stp_new', 'stp_new', 'stp_old', 'stp_old']);
    expect(stages.map((stage) => stage.stageSeq)).toEqual([1, 2, 1, 2]);
    expect(stages.map((stage) => stage.at)).toEqual([T0 + 2_000, T0 + 3_000, T0, T0 + 1_000]);
    expect(stages[2]?.stage).toBe('queued');
  });

  it('honours ?limit and ?pass, and answers 404 for a chapter out of range', async () => {
    seedPass(ctx!.db, 'stp_lim_a', 8);
    seedPass(ctx!.db, 'stp_lim_b', 8);
    appendStage(ctx!.db, stageInput({ passId: 'stp_lim_a', stage: 'queued', at: T0 }));
    appendStage(ctx!.db, stageInput({ passId: 'stp_lim_a', stage: 'read', at: T0 + 1 }));
    appendStage(ctx!.db, stageInput({ passId: 'stp_lim_b', stage: 'queued', at: T0 + 2 }));

    const limited = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/8/stages?limit=1' });
    expect((limited.json() as { stages: PassStageEvent[] }).stages).toHaveLength(1);

    const capped = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/8/stages?limit=9999' });
    expect(capped.statusCode).toBe(200);
    expect((capped.json() as { stages: PassStageEvent[] }).stages).toHaveLength(3);

    const onePass = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/8/stages?pass=stp_lim_a' });
    const stages = (onePass.json() as { stages: PassStageEvent[] }).stages;
    expect(stages.map((stage) => stage.stage)).toEqual(['queued', 'read']);

    const missing = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/68/stages' });
    expect(missing.statusCode).toBe(400);
    const empty = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/9/stages' });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { stages: unknown[] }).stages).toEqual([]);
  });

  it('keeps the ETag stable across a repeat and changes it when a row lands', async () => {
    seedPass(ctx!.db, 'stp_etag', 8);
    appendStage(ctx!.db, stageInput({ passId: 'stp_etag', stage: 'queued', at: T0 }));
    const first = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/8/stages' });
    const etag = first.headers.etag;
    expect(typeof etag).toBe('string');

    const repeat = await ctx!.app.inject({
      method: 'GET',
      url: '/api/chapters/8/stages',
      headers: { 'if-none-match': String(etag) },
    });
    expect(repeat.statusCode).toBe(304);

    appendStage(ctx!.db, stageInput({ passId: 'stp_etag', stage: 'read', at: T0 + 5 }));
    const after = await ctx!.app.inject({
      method: 'GET',
      url: '/api/chapters/8/stages',
      headers: { 'if-none-match': String(etag) },
    });
    expect(after.statusCode).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
    expect((after.json() as { stages: PassStageEvent[] }).stages).toHaveLength(2);
  });

  it('sits under the read limiter: one call is fine at 60/min, the 61st in the window is refused', async () => {
    expect(engineFixture!.config.readPerMinute).toBe(60);
    expect(isReadLimited('/api/chapters/8/stages')).toBe(true);
    expect(isReadLimited('/api/chapters/8')).toBe(false);

    for (let index = 0; index < 60; index += 1) {
      const response = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/8/stages' });
      expect(response.statusCode, `call ${index + 1}`).toBe(200);
    }
    const refused = await ctx!.app.inject({ method: 'GET', url: '/api/chapters/8/stages' });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
  });
});

describe('the typing stage the site emits (docs/writer-lane.md §1–§3)', () => {
  let fixture: Fixture | null = null;
  let watcher: ManuscriptWatcher | null = null;
  let events: IngestEvent[] = [];

  async function start(): Promise<Fixture> {
    fixture = createFixture({});
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const state = new StateService(fixture.db);
    events = [];
    watcher = new ManuscriptWatcher({
      db: fixture.db,
      state,
      bookRoot: fixture.root,
      dataDir: fixture.dataDir,
      pollMs: 20,
      stabilityMs: 20,
      coalesceMs: 40,
      emit: (event) => events.push(event),
      log: () => undefined,
    });
    await watcher.start();
    // Polling keeps no baseline for a path until its first scan: let it settle before the
    // test creates a chapter in the same directory (the harness in watcher.test.ts does the same).
    await new Promise((resolve) => setTimeout(resolve, 30));
    return fixture;
  }

  async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 8_000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = check();
      if (value !== null && value !== undefined && value !== false) return value;
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the watcher');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function seedChapterChange(db: Db, chapter: number, changeId: string | null): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO steps (step_id, seq, wave, lane, pass, chapter, boundary, at)
       VALUES ('stp_t', 1, 1, 'forward', 'change', ?, ?, ?)`,
    ).run(chapter, String(chapter), now);
    if (changeId !== null) {
      db.prepare(
        `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
           status, enqueued_at)
         VALUES (1, ?, 'continuity', ?, 'сшить соседние главы', 1, 'sha', '[]', 'phrase', 'processing', ?)`,
      ).run(changeId, chapter, now);
    }
    db.prepare(
      `INSERT INTO leases (id, step_id, change_id, lane, chapter, is_front, kind, session, expected_rev,
         acquired_at, heartbeat_at, expires_at)
       VALUES ('lea_t', 'stp_t', ?, 'forward', ?, 0, ?, 'writer-fwd', 1, ?, ?, ?)`,
    ).run(changeId, chapter, changeId === null ? 'draft' : 'change', now, now, new Date(Date.now() + 120_000).toISOString());
  }

  afterEach(async () => {
    await watcher?.stop();
    watcher = null;
    fixture?.close();
    fixture = null;
  });

  it('writes exactly one typing stage for a change-driven revision', async () => {
    const stageFixture = await start();
    seedChapterChange(stageFixture.db, 4, 'chg_t');
    stageFixture.write('ch04.md', 'Четвёртая\n\nСлужебный абзац для проверки объёма страницы.\n');

    await waitFor(() => events.find((event) => event.type === 'chapter:created'));
    const rows = await waitFor(() => {
      const found = stageFixture.db.prepare('SELECT * FROM pass_stages WHERE chapter = 4').all() as Array<
        Record<string, unknown>
      >;
      return found.length > 0 ? found : null;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stored = stageFixture.db.prepare('SELECT * FROM pass_stages WHERE chapter = 4').all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      pass_id: 'stp_t',
      chapter: 4,
      stage_seq: 1,
      stage: 'typing',
      actor_process: 'site',
      actor_model: null,
      change_id: 'chg_t',
    });
    expect(String(stored[0]?.summary)).toContain('ревизия 1');
  }, 15_000);

  it('writes no typing stage when the revision carries no change', async () => {
    const stageFixture = await start();
    seedChapterChange(stageFixture.db, 6, null);
    stageFixture.write('ch06.md', 'Шестая\n\nСлужебный абзац для проверки объёма страницы.\n');

    await waitFor(() => events.find((event) => event.type === 'chapter:created'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const stored = stageFixture.db.prepare('SELECT * FROM pass_stages WHERE chapter = 6').all();
    expect(stored).toHaveLength(0);
  }, 15_000);
});
