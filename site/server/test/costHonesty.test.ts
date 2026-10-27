import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db/db.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * «Honesty about cost» (BOOK-DOC-4, BOOK-23): the change's own numbers in `GET /api/changes/:id`.
 *
 * The rows below are written by SQL, as the engine writes them; the route, the projection and
 * the JSON are the production path. The point of the file is the fourth state: a contribution
 * that was **priced and free** (`cost_priced = 1`, `cost_rub = 0`) travels as `0`, while a
 * placeholder zero on an unpriced row travels as `null` — the card cannot print «0,00 ₽» for
 * something nobody measured, and cannot hide a measured zero either.
 */

const AT = '2026-10-25T12:00:00Z';

type CostCase = {
  id: string;
  seq: number;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  costPriced: number;
};

function insertChange(db: Db, change: CostCase): void {
  db.prepare(
    `INSERT INTO changes
       (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, status,
        outcome, model, tokens_in, tokens_out, cost_rub, cost_priced, enqueued_at, finished_at, attempts)
     VALUES
       (@seq, @id, 'accepted_comment', 4, 'ключ теперь у другого человека', 1, 'sha', '[]', 'phrase',
        'done', 'applied', @model, @tokensIn, @tokensOut, @costRub, @costPriced, @at, @at, 0)`,
  ).run({ ...change, at: AT });
}

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

async function boot(): Promise<Fixture> {
  fixture = createFixture({});
  app = await buildApp({
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: fixture.dataDir }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
  });
  return fixture;
}

async function costOf(id: string): Promise<Record<string, unknown> | null> {
  const response = await app!.inject({ method: 'GET', url: `/api/changes/${id}` });
  expect(response.statusCode).toBe(200);
  return (response.json() as { cost: Record<string, unknown> | null }).cost;
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

describe('the cost the API serves', () => {
  it('says nothing when nothing was spent', async () => {
    const booted = await boot();
    insertChange(booted.db, { id: 'chg_empty', seq: 1, model: null, tokensIn: 0, tokensOut: 0, costRub: 0, costPriced: 0 });
    expect(await costOf('chg_empty')).toBeNull();
  });

  it('keeps the model and the tokens and drops an unpriced zero', async () => {
    const booted = await boot();
    insertChange(booted.db, {
      id: 'chg_unpriced',
      seq: 2,
      model: 'deepseek-flash',
      tokensIn: 120,
      tokensOut: 60,
      costRub: 0,
      costPriced: 0,
    });
    expect(await costOf('chg_unpriced')).toEqual({
      model: 'deepseek-flash',
      tokensIn: 120,
      tokensOut: 60,
      rub: null,
    });
  });

  it('treats a positive amount without the marker as unmeasured, not as a price', async () => {
    // Nothing writes a price today; a number nobody marked is not a measurement.
    const booted = await boot();
    insertChange(booted.db, {
      id: 'chg_unmarked',
      seq: 3,
      model: 'deepseek-flash',
      tokensIn: 10,
      tokensOut: 2,
      costRub: 12.5,
      costPriced: 0,
    });
    expect((await costOf('chg_unmarked'))?.rub).toBeNull();
  });

  it('serves a measured amount, and a measured zero as a real 0', async () => {
    const booted = await boot();
    insertChange(booted.db, {
      id: 'chg_measured',
      seq: 4,
      model: 'deepseek-flash',
      tokensIn: 90,
      tokensOut: 10,
      costRub: 0.42,
      costPriced: 1,
    });
    insertChange(booted.db, {
      id: 'chg_free',
      seq: 5,
      model: 'deepseek-flash',
      tokensIn: 10,
      tokensOut: 2,
      costRub: 0,
      costPriced: 1,
    });
    expect((await costOf('chg_measured'))?.rub).toBe(0.42);
    const free = await costOf('chg_free');
    expect(free).toEqual({ model: 'deepseek-flash', tokensIn: 10, tokensOut: 2, rub: 0 });
    expect(free?.rub).not.toBeNull();
  });
});
