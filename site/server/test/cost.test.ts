import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BookCostDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { costFrom, readBookCost, type ModelSpend } from '../src/cost/book.ts';
import { USD_RATES_PER_MILLION, rateFor } from '../src/cost/rates.ts';
import type { Db } from '../src/db/db.ts';
import { appendEvent } from '../src/history/log.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

/**
 * `GET /api/cost` — the book's outlay (BOOK-114).
 *
 * Two halves, one file: the arithmetic is a pure function of the step rows and the rate table,
 * and the route is the arithmetic served under the title page's own freshness rules. The
 * numbers below are whole cents by construction — every rate is a whole number of cents per
 * million tokens and every fixture count is a whole multiple of 500 000 — so the assertions
 * are exact rather than approximate, and a rounding change cannot pass as float noise.
 */

/** `deepseek-flash`: 15 ¢ per 1M input, 60 ¢ per 1M output. */
const FLASH = USD_RATES_PER_MILLION['deepseek-flash'];
/** `deepseek-v4-pro`: 66 ¢ per 1M input, 198 ¢ per 1M output. */
const PRO = USD_RATES_PER_MILLION['deepseek-v4-pro'];

function spend(model: string | null, tokensIn: number, tokensOut: number, steps = 1): ModelSpend {
  return { model, tokensIn, tokensOut, steps };
}

describe('the cost arithmetic', () => {
  it('prices two models exactly, and counts every step row', () => {
    expect(FLASH).toEqual({ input: 0.15, output: 0.6 });
    expect(PRO).toEqual({ input: 0.66, output: 1.98 });

    const cost = costFrom([
      // 2M input = 30 ¢, 1M output = 60 ¢ → 0,90 $.
      spend('deepseek-flash', 2_000_000, 1_000_000, 2),
      // 1M input = 66 ¢, 0,5M output = 99 ¢ → 1,65 $.
      spend('deepseek-v4-pro', 1_000_000, 500_000, 1),
    ]);

    expect(cost).toEqual({
      tokens: 4_500_000,
      tokensIn: 3_000_000,
      tokensOut: 1_500_000,
      steps: 3,
      usd: 2.55,
      unpriced: [],
    });
  });

  it('counts an unknown model’s tokens, blanks the money, and names the model', () => {
    const cost = costFrom([spend('deepseek-flash', 1_000_000, 0), spend('mystery-llm', 500_000, 0)]);
    expect(cost.tokens).toBe(1_500_000);
    expect(cost.usd).toBeNull();
    expect(cost.unpriced).toEqual(['mystery-llm']);
  });

  it('costs nothing when no step has run: zero is a measurement, not a placeholder', () => {
    expect(costFrom([])).toEqual({ tokens: 0, tokensIn: 0, tokensOut: 0, steps: 0, usd: 0, unpriced: [] });
  });

  it('prices the driver’s `provider/model` name and the bare name the same', () => {
    const prefixed = costFrom([spend('deepseek/deepseek-flash', 1_000_000, 0)]);
    const bare = costFrom([spend('deepseek-flash', 1_000_000, 0)]);
    expect(rateFor('deepseek/deepseek-flash')).toEqual(FLASH);
    expect(rateFor('deepseek-flash')).toEqual(FLASH);
    expect(prefixed.usd).toBe(0.15);
    expect(prefixed.usd).toBe(bare.usd);
  });

  it('does not blank the price for a zero-token step on an unknown model', () => {
    const cost = costFrom([spend('deepseek-flash', 1_000_000, 0), spend('mystery-llm', 0, 0)]);
    expect(cost.usd).toBe(0.15);
    expect(cost.steps).toBe(2);
    expect(cost.unpriced).toEqual([]);
  });

  it('lists an unmodelled spend as a null entry, sorted, and never prices it', () => {
    const cost = costFrom([spend('zeta', 10, 0), spend(null, 20, 0), spend('alpha', 30, 0)]);
    expect(cost.usd).toBeNull();
    // `null` is not a name, so it leads the list; the names follow in plain order.
    expect(cost.unpriced).toEqual([null, 'alpha', 'zeta']);
    expect(cost.tokens).toBe(60);
    // A model nobody named is not a price even when asked for directly.
    expect(rateFor(null)).toBeNull();
    expect(rateFor('toString')).toBeNull();
  });

  it('orders names both ways, and treats a repeated name as the same model', () => {
    // A descending pair covers the other arm of the comparator; one name twice is a total
    // order, not a second model (the SQL groups by model, so production never sees it).
    expect(costFrom([spend('zeta', 1, 0), spend('alpha', 1, 0)]).unpriced).toEqual(['alpha', 'zeta']);
    expect(costFrom([spend('dup', 1, 0), spend('dup', 2, 0)]).unpriced).toEqual(['dup', 'dup']);
  });

  it('reads a name with the driver’s whitespace as the same model', () => {
    expect(rateFor('  deepseek-flash  ')).toEqual(FLASH);
    expect(costFrom([spend(' deepseek/deepseek-v4-pro ', 1_000_000, 0)]).usd).toBe(0.66);
  });

  it('reads the same numbers from the one aggregate', () => {
    const fixture = createFixture({});
    try {
      insertStep(fixture.db, { id: 'stp_a', seq: 1, model: 'deepseek-flash', tokensIn: 2_000_000, tokensOut: 1_000_000 });
      insertStep(fixture.db, { id: 'stp_b', seq: 2, model: 'deepseek-v4-pro', tokensIn: 1_000_000, tokensOut: 500_000 });
      expect(readBookCost(fixture.db)).toEqual({
        tokens: 4_500_000,
        tokensIn: 3_000_000,
        tokensOut: 1_500_000,
        steps: 2,
        usd: 2.55,
        unpriced: [],
      });
    } finally {
      fixture.close();
    }
  });
});

const AT = '2026-10-27T09:00:00Z';
const CHAPTER_ONE = longProse(['Первый абзац главы.']);

/** A step row as the engine writes it; only the cost columns matter here. */
function insertStep(
  db: Db,
  step: { id: string; seq: number; model: string | null; tokensIn: number; tokensOut: number },
): void {
  db.prepare(
    `INSERT INTO steps (step_id, seq, wave, pass, boundary, at, model, tokens_in, tokens_out)
     VALUES (@id, @seq, 1, 'draft', '5', @at, @model, @tokensIn, @tokensOut)`,
  ).run({ ...step, at: AT });
}

/** The prose facts `bookStateKey` watches: the chapter `rev` sum and the last block version. */
function proseState(fresh: Fixture): { revs: number; block: number } {
  const revs = fresh.db.prepare('SELECT COALESCE(SUM(rev), 0) AS revs FROM chapters').get() as { revs: number };
  const block = fresh.db.prepare('SELECT COALESCE(MAX(hseq), 0) AS hseq FROM block_versions').get() as { hseq: number };
  return { revs: revs.revs, block: block.hseq };
}

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

/** The book, without the site: rows are inserted between `boot()` and `start()`. */
async function boot(): Promise<Fixture> {
  fixture = createFixture({ 'ch01.md': CHAPTER_ONE });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  return fixture;
}

async function start(bookCost?: () => BookCostDto): Promise<void> {
  webDist = mkdtempSync(join(tmpdir(), 'book-web-'));
  app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture!.root,
      DATA_DIR: fixture!.dataDir,
      WEB_DIST: webDist,
      PORT: '8080',
    }),
    db: fixture!.db,
    state: new StateService(fixture!.db),
    version: 'test',
    logger: false,
    ...(bookCost === undefined ? {} : { bookCost }),
  });
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  webDist = null;
});

/** A cost reader that counts its own scans: the spy that proves a 304 costs nothing. */
function countingCost(db: Db): { read: () => BookCostDto; calls: () => number } {
  let calls = 0;
  return {
    read: () => {
      calls += 1;
      return readBookCost(db);
    },
    calls: () => calls,
  };
}

describe('GET /api/cost', () => {
  it('serves the whole-book total, with the ETag and no-store (BOOK-109)', async () => {
    const fresh = await boot();
    insertStep(fresh.db, { id: 'stp_a', seq: 1, model: 'deepseek-flash', tokensIn: 2_000_000, tokensOut: 1_000_000 });
    insertStep(fresh.db, { id: 'stp_b', seq: 2, model: 'deepseek-v4-pro', tokensIn: 1_000_000, tokensOut: 500_000 });
    await start();

    const response = await app!.inject({ method: 'GET', url: '/api/cost' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tokens: 4_500_000,
      tokensIn: 3_000_000,
      tokensOut: 1_500_000,
      steps: 2,
      usd: 2.55,
      unpriced: [],
    });
    // The totals are the validator: a log (or a client comparing two answers) can tell one
    // outlay from another. `4f53cda1` is the digest of the empty `unpriced` list — the fifth
    // part stands for **which** models blanked the price.
    expect(response.headers.etag).toBe('"cost-3000000-1500000-2.55-4f53cda1-2"');
    // BOOK-109: nothing a page reads is stored — the header is the app's policy, not the route's.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('says an unpriced book with a null figure, never a partial total', async () => {
    const fresh = await boot();
    insertStep(fresh.db, { id: 'stp_a', seq: 1, model: 'mystery-llm', tokensIn: 1_000_000, tokensOut: 0 });
    await start();

    const response = await app!.inject({ method: 'GET', url: '/api/cost' });
    const body = response.json();
    expect(body.usd).toBeNull();
    expect(body.unpriced).toEqual(['mystery-llm']);
    expect(body.tokens).toBe(1_000_000);
    // The money part of the validator says «not priced», so a stored line cannot turn into a
    // figure when a rate appears; the digest is of `["mystery-llm"]`, i.e. of the named model.
    expect(response.headers.etag).toBe('"cost-1000000-0-u-2bcde992-1"');
  });

  // BOOK-114 AC4 with BOOK-109's rule: a repeated page view is a real transfer of the same
  // body — no `304` to reuse a copy — but the scan of `steps` happens once per book state.
  it('answers eleven requests with the full body and scans the step table once', async () => {
    const fresh = await boot();
    insertStep(fresh.db, { id: 'stp_a', seq: 1, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 0 });
    const cost = countingCost(fresh.db);
    await start(cost.read);

    const first = await app!.inject({ method: 'GET', url: '/api/cost' });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBe('"cost-1000000-0-0.15-4f53cda1-1"');
    expect(cost.calls()).toBe(1);

    for (let view = 0; view < 10; view += 1) {
      // A conditional header is stripped by the policy above the route, so this is an ordinary
      // request: a body, not a 304, and no second scan.
      const again = await app!.inject({
        method: 'GET',
        url: '/api/cost',
        headers: { 'if-none-match': first.headers.etag as string },
      });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
      expect(again.headers['cache-control']).toBe('no-store');
    }
    expect(cost.calls()).toBe(1);
  });

  it('measures again when the prose moves, and the ETag changes', async () => {
    const fresh = await boot();
    insertStep(fresh.db, { id: 'stp_a', seq: 1, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 0 });
    const cost = countingCost(fresh.db);
    await start(cost.read);

    const first = await app!.inject({ method: 'GET', url: '/api/cost' });
    expect(first.headers.etag).toBe('"cost-1000000-0-0.15-4f53cda1-1"');
    expect(cost.calls()).toBe(1);

    // A step lands **and writes prose**: a chapter revision moves, which is the book state the
    // title page's key already watches.
    insertStep(fresh.db, { id: 'stp_b', seq: 2, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 0 });
    fresh.db.prepare('UPDATE chapters SET rev = rev + 1').run();

    const second = await app!.inject({ method: 'GET', url: '/api/cost' });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).toBe('"cost-2000000-0-0.30-4f53cda1-2"');
    expect(cost.calls()).toBe(2);
  });

  it('measures again when only a step closes, with no chapter and no block version moving', async () => {
    const fresh = await boot();
    // The step opened with no tokens; the close writes them. A `holds` close applies no prose, so
    // `bookStateKey` cannot see it — the events clock is what makes the memo stale (BOOK-114).
    insertStep(fresh.db, { id: 'stp_a', seq: 1, model: 'deepseek-flash', tokensIn: 0, tokensOut: 0 });
    appendEvent(fresh.db, { kind: 'step.opened', chapter: 1, stepId: 'stp_a', authorKind: 'writer' }, Date.parse(AT));
    const cost = countingCost(fresh.db);
    await start(cost.read);

    const proseBefore = proseState(fresh);
    const first = await app!.inject({ method: 'GET', url: '/api/cost' });
    expect(first.headers.etag).toBe('"cost-0-0-0.00-4f53cda1-1"');
    expect(cost.calls()).toBe(1);

    // What `close.ts` does in one transaction: the tokens land in the existing row, the step
    // closes, and `step.closed` is appended. No chapter `rev`, no block version.
    fresh.db
      .prepare("UPDATE steps SET tokens_in = 1000000, outcome = 'holds', closed_at = @at WHERE step_id = 'stp_a'")
      .run({ at: AT });
    appendEvent(fresh.db, { kind: 'step.closed', chapter: 1, stepId: 'stp_a', authorKind: 'writer', payload: { outcome: 'holds' } }, Date.parse(AT));

    // The claim above, asserted: the prose did not move.
    expect(proseState(fresh)).toEqual(proseBefore);

    const second = await app!.inject({ method: 'GET', url: '/api/cost' });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).toBe('"cost-1000000-0-0.15-4f53cda1-1"');
    expect(second.json()).toMatchObject({ tokens: 1_000_000, usd: 0.15, steps: 1 });
    expect(cost.calls()).toBe(2);
  });
});
