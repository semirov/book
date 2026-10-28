/**
 * The money bound (BOOK-117): the `pass_spend` ledger, the DTO, the guard and the lines.
 *
 * Everything runs on a real SQLite database with the real migrations, the real engine and the
 * fixture's clock seam (`engine/types.ts`) — no ledger is mocked. A "day" is the UTC date of a
 * close, so the clock is the only way to test a resume, and it is moved, not worked around.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET_CAPS,
  assertBudgetAllowsPass,
  budgetCapsFromEnv,
  budgetSnapshot,
  formatUsd,
  nextUtcMidnight,
  recordPassSpend,
  type BudgetCaps,
} from '../src/budget.ts';
import type { Db } from '../src/db/db.ts';
import type { GateAssignment } from '../src/engine/gates.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createEngineFixture, type Fixture } from './engine/helpers.ts';
import { createFixture as createSiteFixture } from './helpers.ts';

/** The console's numbers are the defaults; a test states its own when it needs a small cap. */
const CAPS: BudgetCaps = DEFAULT_BUDGET_CAPS;

const at = (iso: string): number => Date.parse(iso);

/** One ledger row, written with the table's own SQL — the shape the engine writes. */
let seeded = 0;
function seedSpend(db: Db, when: string, usd: number, tokens = 0): void {
  seeded += 1;
  db.prepare(
    `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced)
     VALUES (?, ?, ?, NULL, 'draft', NULL, 'deepseek/deepseek-v4-pro', ?, 0, ?, 1)`,
  ).run(when, when.slice(0, 10), `stp_seed_${String(seeded)}`, tokens, usd);
}

function refusalOf(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    const shaped = error as { code?: string; message?: string };
    return { code: shaped.code ?? 'NO_CODE', message: shaped.message ?? '' };
  }
  return { code: 'NO_REFUSAL', message: '' };
}

/**
 * One whole pass through the engine: open the chapter, land the prose, both verdicts, close
 * with the given spend. The gates answer with zero tokens so the ledger's row is exactly the
 * step's own numbers.
 */
function runPass(fixture: Fixture, chapter: number, spend: { tokensIn: number; tokensOut: number }): void {
  const assignment = fixture.engine.openChapterPass(chapter, `writer-${String(chapter)}`) as WriterAssignment | null;
  if (!assignment) throw new Error('expected a pass');
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(chapter, `Глава ${String(chapter)}`, [
    `Глава ${String(chapter)} начинается со служебного абзаца.`,
    'Служебный абзац для проверки объёма страницы.',
  ]);
  fixture.engine.land(assignment.leaseId);
  for (const role of ['editor', 'consultant'] as const) {
    const gate = fixture.engine.next({ role, session: `${role}-${String(chapter)}` }) as GateAssignment | null;
    if (!gate) throw new Error(`no ${role} assignment`);
    fixture.engine.verdict(gate.stepId, {
      role,
      session: gate.session,
      verdict: 'HOLDS',
      findings: [],
      // ADR-038 (BOOK-62) refuses a gate verdict from any model but the pipeline's.
      model: 'deepseek/deepseek-v4-pro',
      tokensIn: 0,
      tokensOut: 0,
    });
  }
  fixture.engine.done(assignment.leaseId, {
    seams: [],
    note: 'budget test',
    model: 'deepseek/deepseek-v4-pro',
    tokensIn: spend.tokensIn,
    tokensOut: spend.tokensOut,
  });
}

function rows(db: Db): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM pass_spend ORDER BY id').all() as Array<Record<string, unknown>>;
}

describe('pass_spend — one row per pass, from the pipeline’s rate', () => {
  it('writes exactly one row for a closed pass, priced at the model’s rate', () => {
    const fixture = createEngineFixture();
    try {
      runPass(fixture, 3, { tokensIn: 8_000, tokensOut: 9_000 });
      const ledger = rows(fixture.db);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        day: '2026-10-25',
        chapter: 3,
        pass: 'draft',
        model: 'deepseek/deepseek-v4-pro',
        tokens_in: 8_000,
        tokens_out: 9_000,
        priced: 1,
      });
      // (8 000 × 0.66 + 9 000 × 1.98) / 1 000 000, the pipeline's own arithmetic.
      expect(ledger[0]?.usd).toBe(0.0231);
      expect(ledger[0]?.pass_id).toBe(
        (fixture.db.prepare('SELECT step_id FROM steps').get() as { step_id: string }).step_id,
      );
    } finally {
      fixture.close();
    }
  });

  it('charges a re-close nothing: a second insert for the same pass is ignored', () => {
    const fixture = createEngineFixture();
    try {
      const input = {
        passId: 'stp_twice',
        at: '2026-10-25T09:00:00Z',
        chapter: 4,
        pass: 'change' as const,
        changeId: null,
        model: 'deepseek/deepseek-v4-pro',
        tokensIn: 1_000,
        tokensOut: 100,
      };
      expect(recordPassSpend(fixture.db, input)).toBe(true);
      // The same pass, closed again (a retried report): the row stays one and the money stays
      // one charge — `INSERT OR IGNORE` on the pass id, not a counter that could double.
      expect(recordPassSpend(fixture.db, input)).toBe(false);
      expect(rows(fixture.db)).toHaveLength(1);
      expect(budgetSnapshot(fixture.db, CAPS, at('2026-10-25T09:00:00Z')).day.spentUsd).toBe(0.000858);
    } finally {
      fixture.close();
    }
  });

  it('counts the tokens of an unpriced model and charges nothing for them (BOOK-23)', () => {
    const fixture = createEngineFixture();
    try {
      expect(
        recordPassSpend(fixture.db, {
          passId: 'stp_unknown',
          at: '2026-10-25T09:00:00Z',
          chapter: 5,
          pass: 'change',
          changeId: null,
          model: 'openai/gpt-9',
          tokensIn: 4_000,
          tokensOut: 500,
        }),
      ).toBe(true);
      expect(rows(fixture.db)[0]).toMatchObject({ usd: 0, priced: 0, tokens_in: 4_000, tokens_out: 500 });
      const dto = budgetSnapshot(fixture.db, CAPS, at('2026-10-25T09:00:00Z'));
      expect(dto.day.spentUsd).toBe(0);
      expect(dto.tokens.today).toBe(4_500);
    } finally {
      fixture.close();
    }
  });

  it('sums the rows to the cent, 0.1 + 0.2 style rows included', () => {
    const fixture = createEngineFixture();
    try {
      seedSpend(fixture.db, '2026-10-25T08:00:00Z', 0.1);
      seedSpend(fixture.db, '2026-10-25T09:00:00Z', 0.2);
      seedSpend(fixture.db, '2026-10-24T09:00:00Z', 1.5);
      const dto = budgetSnapshot(fixture.db, CAPS, at('2026-10-25T12:00:00Z'));
      expect(dto.day.spentUsd).toBe(0.3);
      expect(dto.book.spentUsd).toBe(1.8);
    } finally {
      fixture.close();
    }
  });
});

describe('the cap lines and the states (BOOK-117)', () => {
  it('says nothing while the book is inside both caps', () => {
    const fixture = createEngineFixture();
    try {
      const dto = budgetSnapshot(fixture.db, CAPS, at('2026-10-25T12:00:00Z'));
      expect(dto).toEqual({
        state: 'ok',
        line: '',
        day: { spentUsd: 0, capUsd: 10, ratio: 0, day: '2026-10-25', resumesAt: '2026-10-26T00:00:00Z' },
        book: { spentUsd: 0, capUsd: 1_000, ratio: 0 },
        tokens: { today: 0 },
      });
      expect(nextUtcMidnight(at('2026-10-25T00:00:00Z'))).toBe('2026-10-26T00:00:00Z');
    } finally {
      fixture.close();
    }
  });

  it('warns at 80 % of the day, in one sentence, and still allows a pass', () => {
    const fixture = createEngineFixture();
    try {
      seedSpend(fixture.db, '2026-10-25T09:00:00Z', 8.2);
      const dto = budgetSnapshot(fixture.db, CAPS, at('2026-10-25T12:00:00Z'));
      expect(dto.state).toBe('warn');
      expect(dto.line).toBe('дневной потолок 10,00 $ израсходован на 82 %');
      expect(() => assertBudgetAllowsPass(fixture.db, CAPS, at('2026-10-25T12:00:00Z'))).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it('warns at 80 % of the book too, with its own sentence', () => {
    const fixture = createEngineFixture();
    try {
      // Yesterday's money: the day is clean, the book is at 80 %.
      seedSpend(fixture.db, '2026-10-24T09:00:00Z', 800);
      const dto = budgetSnapshot(fixture.db, CAPS, at('2026-10-25T12:00:00Z'));
      expect(dto.state).toBe('warn');
      expect(dto.line).toBe('потолок книги 1\u00A0000,00 $ израсходован на 80 %');
      expect(dto.day.spentUsd).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('pauses the day at the cap, with the exact line, and lifts by itself at 00:00 UTC', () => {
    const fixture = createEngineFixture();
    try {
      seedSpend(fixture.db, '2026-10-27T23:59:59Z', 10.01);
      const paused = budgetSnapshot(fixture.db, CAPS, at('2026-10-27T23:59:59Z'));
      expect(paused.state).toBe('pause');
      expect(paused.line).toBe('пауза · дневной потолок 10,00 $ · возобновится в 00:00 UTC');
      expect(paused.day.resumesAt).toBe('2026-10-28T00:00:00Z');
      expect(refusalOf(() => assertBudgetAllowsPass(fixture.db, CAPS, at('2026-10-27T23:59:59Z')))).toEqual({
        code: 'BUDGET_PAUSED',
        message: 'пауза · дневной потолок 10,00 $ · возобновится в 00:00 UTC',
      });

      // Two seconds later the date — the ledger's key — is a new day: nothing was reset, the
      // sum is simply empty.
      const fresh = budgetSnapshot(fixture.db, CAPS, at('2026-10-28T00:00:01Z'));
      expect(fresh.state).toBe('ok');
      expect(fresh.day.day).toBe('2026-10-28');
      expect(() => assertBudgetAllowsPass(fixture.db, CAPS, at('2026-10-28T00:00:01Z'))).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it('stops the whole book at its cap, even on a fresh day with nothing spent today', () => {
    const fixture = createEngineFixture();
    try {
      seedSpend(fixture.db, '2026-10-01T09:00:00Z', 1_000);
      const dto = budgetSnapshot(fixture.db, CAPS, at('2026-10-27T12:00:00Z'));
      expect(dto.state).toBe('stop');
      expect(dto.line).toBe('остановлено · потолок книги 1\u00A0000,00 $');
      expect(refusalOf(() => assertBudgetAllowsPass(fixture.db, CAPS, at('2026-10-27T12:00:00Z')))).toEqual({
        code: 'BUDGET_STOPPED',
        message: 'остановлено · потолок книги 1\u00A0000,00 $',
      });
    } finally {
      fixture.close();
    }
  });

  it('allows the small pass at 99 % and refuses the one that reaches the cap', () => {
    const fixture = createEngineFixture();
    try {
      seedSpend(fixture.db, '2026-10-25T09:00:00Z', 9.99);
      const near = at('2026-10-25T12:00:00Z');
      expect(budgetSnapshot(fixture.db, CAPS, near).state).toBe('warn');
      // A $0.005 pass is still allowed at 9.99 (99.9 %)…
      expect(() => assertBudgetAllowsPass(fixture.db, CAPS, near)).not.toThrow();
      recordPassSpend(fixture.db, {
        passId: 'stp_small',
        at: '2026-10-25T12:00:00Z',
        chapter: 6,
        pass: 'draft',
        changeId: null,
        model: 'deepseek/deepseek-v4-pro',
        tokensIn: 7_576,
        tokensOut: 0,
      });
      expect(budgetSnapshot(fixture.db, CAPS, near).day.spentUsd).toBe(9.995);
      expect(() => assertBudgetAllowsPass(fixture.db, CAPS, near)).not.toThrow();

      // …the next one takes the day to 10.00, and from there nothing opens.
      recordPassSpend(fixture.db, {
        passId: 'stp_small_2',
        at: '2026-10-25T12:00:00Z',
        chapter: 7,
        pass: 'draft',
        changeId: null,
        model: 'deepseek/deepseek-v4-pro',
        tokensIn: 7_576,
        tokensOut: 0,
      });
      expect(budgetSnapshot(fixture.db, CAPS, near).day.spentUsd).toBe(10);
      expect(refusalOf(() => assertBudgetAllowsPass(fixture.db, CAPS, near)).code).toBe('BUDGET_PAUSED');
    } finally {
      fixture.close();
    }
  });

  it('leaves a pending change pending and opens no step while the day is paused', () => {
    const fixture = createEngineFixture();
    try {
      fixture.seedChapterBlocks(2, 'Глава 2', ['Глава 2 начинается.', 'Служебный абзац для объёма.']);
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'уточнить первый абзац' });
      seedSpend(fixture.db, '2026-10-25T09:00:00Z', 10.01);

      expect(refusalOf(() => fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }))).toEqual({
        code: 'BUDGET_PAUSED',
        message: 'пауза · дневной потолок 10,00 $ · возобновится в 00:00 UTC',
      });
      expect(fixture.db.prepare('SELECT status FROM changes WHERE id = ?').get(change.id)).toEqual({ status: 'pending' });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 });
      expect(fixture.db.prepare('SELECT holder FROM lane WHERE id = 1').get()).toEqual({ holder: null });
    } finally {
      fixture.close();
    }
  });

  it('raises the 80 % sentence once per scope, not once per pass', () => {
    // A cap of one cent: the first pass lands at 85.8 %, the second takes the day to 171 %.
    const fixture = createEngineFixture({ env: { BOOK_BUDGET_DAY_USD: '0.01' } });
    try {
      runPass(fixture, 3, { tokensIn: 10_000, tokensOut: 1_000 });
      // The alert is raised on the engine's own tick, next to the heartbeat.
      fixture.engine.heartbeat();
      expect(fixture.alerts.filter((alert) => alert.kind === 'budget')).toEqual([
        expect.objectContaining({ detail: 'дневной потолок 0,01 $ израсходован на 85 %' }),
      ]);
      expect(fixture.db.prepare(`SELECT v FROM meta WHERE k = 'budget.warned.day.2026-10-25'`).get()).toBeDefined();

      runPass(fixture, 4, { tokensIn: 10_000, tokensOut: 1_000 });
      fixture.engine.heartbeat();
      // The day is now paused (171 %), and still one sentence: the marker decides, not the pass.
      expect(budgetSnapshot(fixture.db, { dayUsd: 0.01, bookUsd: 1_000 }, fixture.clock.now()).state).toBe('pause');
      expect(fixture.alerts.filter((alert) => alert.kind === 'budget')).toHaveLength(1);
      // The book's own marker is untouched: $1000 was never near.
      expect(fixture.db.prepare(`SELECT v FROM meta WHERE k = 'budget.warned.book'`).get()).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it('warns once about the book’s cap too, from the same ledger', () => {
    const fixture = createEngineFixture({ env: { BOOK_BUDGET_BOOK_USD: '0.01' } });
    try {
      runPass(fixture, 3, { tokensIn: 10_000, tokensOut: 1_000 });
      fixture.engine.heartbeat();
      fixture.engine.heartbeat();
      const budget = fixture.alerts.filter((alert) => alert.kind === 'budget');
      expect(budget.map((alert) => alert.detail)).toEqual(['потолок книги 0,01 $ израсходован на 85 %']);
      expect(fixture.db.prepare(`SELECT v FROM meta WHERE k = 'budget.warned.book'`).get()).toBeDefined();
      // The day is nowhere near its own cap, so it has no sentence and no marker.
      expect(fixture.db.prepare(`SELECT v FROM meta WHERE k = 'budget.warned.day.2026-10-25'`).get()).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it('serves the money block at /api/state from the same ledger, and it survives the ETag', async () => {
    const site = createSiteFixture({});
    const config = loadConfig({ BOOK_ROOT: site.root, DATA_DIR: site.dataDir, WEB_DIST: site.dataDir });
    const app = await buildApp({
      config,
      db: site.db,
      state: new StateService(site.db, undefined, {
        dayUsd: config.budgetDayUsd,
        bookUsd: config.budgetBookUsd,
      }),
      version: 'test',
      logger: false,
    });
    const at = new Date().toISOString();
    const insert = (passId: string, usd: number): void => {
      site.db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, model, tokens_in, tokens_out, usd, priced)
           VALUES (?, ?, ?, 4, 'draft', 'deepseek/deepseek-v4-pro', 1_000, 100, ?, 1)`,
        )
        .run(at, at.slice(0, 10), passId, usd);
    };
    try {
      insert('stp_api_1', 8.2);
      const first = await app.inject({ method: 'GET', url: '/api/state' });
      expect(first.json().budget).toMatchObject({
        state: 'warn',
        line: 'дневной потолок 10,00 $ израсходован на 82 %',
        day: { spentUsd: 8.2, capUsd: 10, ratio: 0.82, day: at.slice(0, 10) },
        book: { spentUsd: 8.2, capUsd: 1_000 },
        tokens: { today: 1_100 },
      });
      // The money is part of the snapshot's fingerprint: the same amount keeps the ETag, a new
      // charge moves both the version and the sum over the ledger. BOOK-109: the poll is always
      // answered with the body — a reused copy is the stale frame that pass removed — so the
      // ETag is compared, never traded for a 304.
      const cached = await app.inject({
        method: 'GET',
        url: '/api/state',
        headers: { 'if-none-match': first.headers.etag as string },
      });
      expect(cached.headers.etag).toBe(first.headers.etag);
      insert('stp_api_2', 0.3);
      const second = await app.inject({ method: 'GET', url: '/api/state' });
      expect(second.headers.etag).not.toBe(first.headers.etag);
      expect(second.json().budget).toMatchObject({ day: { spentUsd: 8.5 }, book: { spentUsd: 8.5 } });
    } finally {
      await app.close();
      site.close();
    }
  });

  it('formats money the way the site prints it', () => {
    expect(formatUsd(10)).toBe('10,00');
    expect(formatUsd(1_000)).toBe('1\u00A0000,00');
    expect(formatUsd(0)).toBe('0,00');
    // Half a cent rounds away from zero at the cent: a row that is not free never prints free.
    expect(formatUsd(0.005)).toBe('0,01');
    expect(formatUsd(0.004)).toBe('0,00');
    expect(formatUsd(1_234.567)).toBe('1\u00A0234,57');
    expect(formatUsd(9.99)).toBe('9,99');
  });

  it('reads the caps from the environment, refusing anything that is not a price', () => {
    expect(budgetCapsFromEnv({})).toEqual(DEFAULT_BUDGET_CAPS);
    expect(budgetCapsFromEnv({ BOOK_BUDGET_DAY_USD: '2.5' })).toEqual({ dayUsd: 2.5, bookUsd: 1_000 });
    for (const bad of ['0', '-1', 'ten', '1,5', '']) {
      if (bad === '') {
        expect(budgetCapsFromEnv({ BOOK_BUDGET_DAY_USD: '' })).toEqual(DEFAULT_BUDGET_CAPS);
        continue;
      }
      expect(() => budgetCapsFromEnv({ BOOK_BUDGET_DAY_USD: bad }), bad).toThrow(
        /BOOK_BUDGET_DAY_USD must be a positive decimal/u,
      );
    }
  });
});
