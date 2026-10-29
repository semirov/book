/**
 * BOOK-187 AC5 — the writer's counter is one row behind two routes.
 *
 * The writer process holds no database handle (one writer kernel per process, BOOK-183), so this
 * file proves the pair an outside reader can see: `GET /internal/writer-state` answers the caller's
 * day, `POST` counts one pass in one transaction, `/internal/health` prints the row. The day is the
 * caller's clock, so a row from yesterday is a fresh day — no reset job exists to be forgotten.
 */

import type { FastifyInstance } from 'fastify';
import type { Response } from 'light-my-request';
import { afterEach, describe, expect, it } from 'vitest';

import { buildControl } from '../../src/engine/control.ts';
import { createEngineFixture } from './helpers.ts';

const TOKEN = 'writer-state-token';
const DAY = '2026-10-28';

let closeApp: (() => Promise<void>) | null = null;

afterEach(async () => {
  await closeApp?.();
  closeApp = null;
});

async function appOf(options: { withDb?: boolean } = {}): Promise<{
  fixture: ReturnType<typeof createEngineFixture>;
  app: FastifyInstance;
  get: (day: string) => Promise<Response>;
  post: (body: Record<string, unknown>) => Promise<Response>;
}> {
  const fixture = createEngineFixture();
  const app = await buildControl({
    engine: fixture.engine,
    ...(options.withDb === false ? {} : { db: fixture.db }),
    token: TOKEN,
    logger: false,
  });
  closeApp = async () => {
    await app.close();
    fixture.close();
  };
  const get = async (day: string) =>
    app.inject({ method: 'GET', url: `/internal/writer-state?day=${day}`, headers: { authorization: `Bearer ${TOKEN}` } });
  const post = async (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/internal/writer-state', headers: { authorization: `Bearer ${TOKEN}` }, payload: body });
  return { fixture, app, get, post };
}

describe('GET /internal/writer-state', () => {
  it('answers a fresh day when no row exists, and refuses a day that is not a date', async () => {
    const { get } = await appOf();
    const fresh = await get(DAY);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({ ok: true, data: { day: DAY, passes: 0, lastPassAt: null, pauseUntil: null } });

    for (const bad of ['2026-02-30', '2026-13-01', 'yesterday', '2026-10-28T10:00:00Z', '']) {
      const refused = await get(bad);
      expect(refused.statusCode, bad).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'INVALID' });
    }
  });

  it('keeps its own day: a row for yesterday reads as today’s fresh start', async () => {
    const { get, post } = await appOf();
    await post({ day: '2026-10-27', spent: true, now: Date.UTC(2026, 9, 27, 23, 50) });
    const yesterday = await get('2026-10-27');
    expect(yesterday.json().data).toMatchObject({ day: '2026-10-27', passes: 1 });

    const today = await get(DAY);
    expect(today.json().data).toEqual({ day: DAY, passes: 0, lastPassAt: null, pauseUntil: null });
  });
});

describe('POST /internal/writer-state', () => {
  it('counts a spent pass, then a second one, in the row', async () => {
    const { get, post, fixture } = await appOf();
    const first = await post({ day: DAY, spent: true, now: Date.UTC(2026, 9, 28, 10, 0) });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toEqual({
      day: DAY,
      passes: 1,
      lastPassAt: '2026-10-28T10:00:00Z',
      pauseUntil: null,
    });

    const second = await post({ day: DAY, spent: true, now: Date.UTC(2026, 9, 28, 11, 0) });
    expect(second.json().data).toMatchObject({ passes: 2, lastPassAt: '2026-10-28T11:00:00Z' });

    // One row, moved in place — the table is the lane's single counter, not a log.
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM writer_state').get()).toEqual({ n: 1 });
    expect((await get(DAY)).json().data.passes).toBe(2);
  });

  it('counts an idle pass as no pass, and moves only the day and the update', async () => {
    const { post } = await appOf();
    // The first write of a day that never spends: a row exists, and it says nothing happened.
    const idleFirst = await post({ day: DAY, spent: false, now: Date.UTC(2026, 9, 28, 9, 0) });
    expect(idleFirst.json().data).toEqual({ day: DAY, passes: 0, lastPassAt: null, pauseUntil: null });
    await post({ day: DAY, spent: true, now: Date.UTC(2026, 9, 28, 10, 0) });
    const idle = await post({ day: DAY, spent: false, now: Date.UTC(2026, 9, 28, 10, 5) });
    expect(idle.json().data).toMatchObject({ passes: 1, lastPassAt: '2026-10-28T10:00:00Z' });

    // A new day with no spend: passes reset, the last spending moment stays the truth it was.
    const nextDay = await post({ day: '2026-10-29', spent: false, now: Date.UTC(2026, 9, 29, 0, 1) });
    expect(nextDay.json().data).toEqual({
      day: '2026-10-29',
      passes: 0,
      lastPassAt: '2026-10-28T10:00:00Z',
      pauseUntil: null,
    });
    const spentOnNewDay = await post({ day: '2026-10-29', spent: true, now: Date.UTC(2026, 9, 29, 0, 2) });
    expect(spentOnNewDay.json().data).toMatchObject({ passes: 1, lastPassAt: '2026-10-29T00:02:00Z' });
  });

  it('sets, keeps and clears the pause without touching the counter', async () => {
    const { post } = await appOf();
    await post({ day: DAY, spent: true, pauseUntil: '2026-10-28T12:00:00Z', now: Date.UTC(2026, 9, 28, 10, 0) });
    const kept = await post({ day: DAY, spent: false, now: Date.UTC(2026, 9, 28, 10, 1) });
    expect(kept.json().data).toMatchObject({ passes: 1, pauseUntil: '2026-10-28T12:00:00Z' });

    const cleared = await post({ day: DAY, spent: false, pauseUntil: null, now: Date.UTC(2026, 9, 28, 12, 1) });
    expect(cleared.json().data).toMatchObject({ passes: 1, pauseUntil: null });
  });

  it('refuses a bad day, a bad pause and a missing field, and writes nothing', async () => {
    const { post, fixture } = await appOf();
    for (const body of [
      { day: '2026-02-30', spent: true },
      { day: '2026-10-28', spent: 'yes' },
      { day: '2026-10-28', spent: true, pauseUntil: 'tomorrow' },
      { spent: true },
    ]) {
      const response = await post(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM writer_state').get()).toEqual({ n: 0 });
  });

  it('refuses a request with no day and one with no body at all', async () => {
    const { app } = await appOf();
    const headers = { authorization: `Bearer ${TOKEN}` };
    // No query, no body: the schema is the door, and it says which part is missing.
    expect((await app.inject({ method: 'GET', url: '/internal/writer-state', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/internal/writer-state', headers })).statusCode).toBe(400);
  });

  it('refuses with 503 when the control app holds no database', async () => {
    const { app } = await appOf({ withDb: false });
    const headers = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: 'GET', url: `/internal/writer-state?day=${DAY}`, headers })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/internal/writer-state', headers, payload: { day: DAY, spent: true } })).statusCode).toBe(503);
    // The health answer keeps its shape: `writer` is null rather than an invented zero.
    const health = await app.inject({ method: 'GET', url: '/internal/health', headers });
    expect(health.json()).toMatchObject({ ok: true, writer: null });
  });

  it('requires the bearer token, like every other internal route', async () => {
    const { app } = await appOf();
    const response = await app.inject({ method: 'GET', url: `/internal/writer-state?day=${DAY}` });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /internal/health', () => {
  it('prints the lane’s row, and null before the first pass', async () => {
    const { app, post } = await appOf();
    const headers = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: 'GET', url: '/internal/health', headers })).json()).toMatchObject({ writer: null });

    await post({ day: DAY, spent: true, now: Date.UTC(2026, 9, 28, 10, 0) });
    const health = await app.inject({ method: 'GET', url: '/internal/health', headers });
    expect(health.json()).toMatchObject({
      ok: true,
      state: { status: 'running' },
      writer: { day: DAY, passes: 1, lastPassAt: '2026-10-28T10:00:00Z', pauseUntil: null },
    });
  });
});
