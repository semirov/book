/**
 * The money bound at the control door (BOOK-117): a paused day and a stopped book refuse a
 * pass with a stable code and the exact line, and the day's pause lifts by itself when the
 * clock crosses 00:00 UTC — no flag, no operator, no queue state touched.
 *
 * No mocks: the real control app, the real engine and a real database; the ledger's rows are
 * the table's own SQL, exactly as `recordPassSpend` writes them.
 */

import { describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { buildControl } from '../../src/engine/control.ts';
import { createEngineFixture, type Fixture } from './helpers.ts';

const TOKEN = 'test-token';
const PAUSE_LINE = 'пауза · дневной потолок 10,00 $ · возобновится в 00:00 UTC';
const STOP_LINE = 'остановлено · потолок книги 1\u00A0000,00 $';

/** One ledger row, written with the table's own SQL — the shape the engine writes. */
let seeded = 0;
function seedSpend(db: Db, when: string, usd: number): void {
  seeded += 1;
  db.prepare(
    `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced)
     VALUES (?, ?, ?, NULL, 'draft', NULL, 'deepseek/deepseek-v4-pro', 0, 0, ?, 1)`,
  ).run(when, when.slice(0, 10), `stp_guard_${String(seeded)}`, usd);
}

function stepCount(fixture: Fixture): { n: number } {
  return fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get() as { n: number };
}

describe('POST /internal/pass — the money bound at the door', () => {
  it('pauses the day at 10.01, with the exact line, and resumes when the clock crosses midnight', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      seedSpend(fixture.db, '2026-10-25T09:00:00Z', 10.01);

      const paused = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 20, session: 'writer-seed' },
      });
      expect(paused.statusCode).toBe(409);
      expect(paused.json()).toMatchObject({ code: 'BUDGET_PAUSED', message: PAUSE_LINE });
      // A pause touches nothing: no step, no lease, the chapter still open for a later pass.
      expect(stepCount(fixture)).toEqual({ n: 0 });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 });

      // The next UTC day: the same call, the same chapter, no intervention in between.
      fixture.clock.advance(24 * 60 * 60 * 1000);
      const resumed = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 20, session: 'writer-seed' },
      });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().data).toMatchObject({ pass: 'draft', chapter: 20 });
      expect(stepCount(fixture)).toEqual({ n: 1 });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('stops the book at 1000.00 on both doors, even on a fresh day', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      // Yesterday's money: today's sum is zero and the book's cap still ends the book.
      seedSpend(fixture.db, '2026-10-24T09:00:00Z', 1_000);

      const pass = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 20, session: 'writer-seed' },
      });
      expect(pass.statusCode).toBe(409);
      expect(pass.json()).toMatchObject({ code: 'BUDGET_STOPPED', message: STOP_LINE });

      const next = await app.inject({
        method: 'POST',
        url: '/internal/next',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { for: 'fwd', session: 'writer-fwd' },
      });
      expect(next.statusCode).toBe(409);
      expect(next.json()).toMatchObject({ code: 'BUDGET_STOPPED', message: STOP_LINE });

      expect(stepCount(fixture)).toEqual({ n: 0 });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('answers the state with the same money the guard reads', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      seedSpend(fixture.db, '2026-10-25T09:00:00Z', 8.2);
      const state = await app.inject({
        method: 'GET',
        url: '/internal/state',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(state.statusCode).toBe(200);
      expect(state.json().data.budget).toEqual({
        state: 'warn',
        line: 'дневной потолок 10,00 $ израсходован на 82 %',
        day: { spentUsd: 8.2, capUsd: 10, ratio: 0.82, day: '2026-10-25', resumesAt: '2026-10-26T00:00:00Z' },
        book: { spentUsd: 8.2, capUsd: 1_000, ratio: 0.0082 },
        tokens: { today: 0 },
      });
      // The token figure stays information next to it, never the bound (BOOK-117).
      expect(state.json().data.tokens).toMatchObject({ today: 0, dailyBudget: 24_000_000 });
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
