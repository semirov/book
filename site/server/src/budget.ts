/**
 * The money bound (BOOK-117, `docs/writer-lane.md` §6): the `pass_spend` ledger, its two
 * caps, the DTO the site prints and the guard that hands out passes.
 *
 * One rule shapes the module: **totals are always `SUM(usd)` over the ledger**, never a
 * counter. A day's sum is keyed by the UTC date of the close, so the day's cap lifts by
 * itself at 00:00 UTC — no flag, no intervention, and a re-close cannot charge twice
 * (`pass_id` is UNIQUE and the insert is `OR IGNORE`).
 *
 * The numbers here are the environment's (`BOOK_BUDGET_DAY_USD`, `BOOK_BUDGET_BOOK_USD`), not
 * data: a deployment states its caps once at boot, and every surface reads them from `Config`.
 * The arithmetic of one pass is the pipeline's (`costUsd`), so a pass cannot be charged two
 * different ways.
 */

import type { BudgetDto, BudgetScope, BudgetState } from '@book/shared';

import type { Db } from './db/db.ts';
import { refuse } from './engine/types.ts';
import { rateFor } from './cost/rates.ts';
import { toIso } from './util/time.ts';

export type { BudgetDto, BudgetScope, BudgetState };

/** The two caps, in USD. One shape, so the guard, the snapshot and the boot share a value. */
export type BudgetCaps = { dayUsd: number; bookUsd: number };

/** The owner's numbers (2026-10-27): $10 a day, $1000 for the whole book. */
export const DEFAULT_BUDGET_CAPS: BudgetCaps = { dayUsd: 10, bookUsd: 1_000 };

/** The warning threshold: four fifths of a cap is worth one sentence, never a refusal. */
export const WARN_RATIO = 0.8;

const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/u;

function readCap(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) return fallback;
  const value = DECIMAL.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid configuration: ${name} must be a positive decimal`);
  }
  return value;
}

/** The caps as the environment states them; a bad value fails the boot naming the variable. */
export function budgetCapsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetCaps {
  return {
    dayUsd: readCap(env, 'BOOK_BUDGET_DAY_USD', DEFAULT_BUDGET_CAPS.dayUsd),
    bookUsd: readCap(env, 'BOOK_BUDGET_BOOK_USD', DEFAULT_BUDGET_CAPS.bookUsd),
  };
}

/** The caps a loaded `Config` carries — the one conversion every caller shares. */
export function budgetCapsOf(config: { budgetDayUsd: number; budgetBookUsd: number }): BudgetCaps {
  return { dayUsd: config.budgetDayUsd, bookUsd: config.budgetBookUsd };
}

/**
 * Money as the site prints it: two decimals with a comma, thousands by a no-break space
 * (`10,00`, `1 000,00`) — the same number convention as `web/src/lib/format.ts`. Half a cent
 * rounds away from zero at the cent (`0.005` → `0,01`), so a row that is not free never
 * prints as free.
 */
export function formatUsd(value: number): string {
  const cents = Math.round(Math.abs(value) * 100) / 100;
  const [whole, fraction] = cents.toFixed(2).split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/gu, '\u00A0');
  return `${value < 0 ? '−' : ''}${grouped},${fraction ?? '00'}`;
}

/** `YYYY-MM-DD` (UTC) of an instant — the ledger's `day` column and the DTO's `day.day`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The next 00:00 UTC after this instant: when a day's pause lifts by itself. */
export function nextUtcMidnight(ms: number): string {
  const start = new Date(ms);
  start.setUTCHours(0, 0, 0, 0);
  return toIso(start.getTime() + 86_400_000);
}

/** Six decimals, so `0.1 + 0.2` sums to `0.3` and a total never drifts past the cent. */
function money(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * A scope: what was spent, against which cap, and the share. The share is rounded to six
 * decimals so the JSON carries `0.0082`, not `0.008199999999999999` — the comparison against
 * the 80 % threshold reads the same number the client renders.
 */
function scopeOf(spentUsd: number, capUsd: number): BudgetScope {
  return { spentUsd, capUsd, ratio: Math.round((spentUsd / capUsd) * 1_000_000) / 1_000_000 };
}

/** `дневной потолок 10,00 $ израсходован на 82 %` — a fact, no exclamation. */
export function budgetWarnLine(scope: BudgetScope, which: 'day' | 'book'): string {
  const label = which === 'book' ? 'потолок книги' : 'дневной потолок';
  // Floored: a sentence about money may understate a percentage, never overstate it.
  return `${label} ${formatUsd(scope.capUsd)} $ израсходован на ${String(Math.floor(scope.ratio * 100))} %`;
}

function pauseLine(capUsd: number): string {
  return `пауза · дневной потолок ${formatUsd(capUsd)} $ · возобновится в 00:00 UTC`;
}

function stopLine(capUsd: number): string {
  return `остановлено · потолок книги ${formatUsd(capUsd)} $`;
}

function decide(day: BudgetScope, book: BudgetScope): { state: BudgetState; line: string } {
  // The book's cap wins: it ends the whole book, not a day of it.
  if (book.spentUsd >= book.capUsd) return { state: 'stop', line: stopLine(book.capUsd) };
  if (day.spentUsd >= day.capUsd) return { state: 'pause', line: pauseLine(day.capUsd) };
  if (book.ratio >= WARN_RATIO) return { state: 'warn', line: budgetWarnLine(book, 'book') };
  if (day.ratio >= WARN_RATIO) return { state: 'warn', line: budgetWarnLine(day, 'day') };
  return { state: 'ok', line: '' };
}

/**
 * The one money answer (BOOK-117): the day's sum and the book's sum, both from the ledger,
 * plus the states and the single line the site prints.
 */
export function budgetSnapshot(db: Db, caps: BudgetCaps, nowMs: number): BudgetDto {
  const day = utcDay(nowMs);
  const spent = db
    .prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens FROM pass_spend')
    .get() as { usd: number; tokens: number };
  const today = db
    .prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens FROM pass_spend WHERE day = ?')
    .get(day) as { usd: number; tokens: number };
  const dayScope = scopeOf(money(today.usd), caps.dayUsd);
  const bookScope = scopeOf(money(spent.usd), caps.bookUsd);
  const { state, line } = decide(dayScope, bookScope);
  return {
    state,
    line,
    day: { ...dayScope, day, resumesAt: nextUtcMidnight(nowMs) },
    book: bookScope,
    tokens: { today: today.tokens },
  };
}

/**
 * May a pass be handed out now? A pause refuses the pass and touches nothing else: no step,
 * no lease, no queue transition — the pending change stays pending (BOOK-117).
 */
export function assertBudgetAllowsPass(db: Db, caps: BudgetCaps, nowMs: number): void {
  const dto = budgetSnapshot(db, caps, nowMs);
  if (dto.state === 'stop') refuse('BUDGET_STOPPED', 409, dto.line);
  if (dto.state === 'pause') refuse('BUDGET_PAUSED', 409, dto.line);
}

/** One pass, as `closeStep` knows it: the ledger row is written from these facts alone. */
export type PassSpendInput = {
  /** The engine's step id — the ledger's primary key for the pass. */
  passId: string;
  /** ISO UTC, when the pass closed; the `day` column is derived from it. */
  at: string;
  chapter: number | null;
  pass: 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep';
  changeId: string | null;
  /** The model the step closed with; null when no model ran (then the pass is not priced). */
  model: string | null;
  tokensIn: number;
  tokensOut: number;
};

/**
 * The ledger row of a step that is closing, mapped in one place: the engine's own facts
 * (its step row and its close input) become the eleven columns, and nothing else may build
 * them. `at` is the close's time, so the row's `day` is the day the pass finished.
 */
export function passSpendOf(
  step: { step_id: string; chapter: number | null; pass: PassSpendInput['pass'] },
  close: { model: string | null; tokensIn: number; tokensOut: number },
  changeId: string | null,
  now: number,
): PassSpendInput {
  return {
    passId: step.step_id,
    at: toIso(now),
    chapter: step.chapter,
    pass: step.pass,
    changeId,
    model: close.model,
    tokensIn: close.tokensIn,
    tokensOut: close.tokensOut,
  };
}

/** One pass's money from the book's own rate table; an unknown model is counted, not priced. */
export function usdOfModel(
  model: string | null,
  tokensIn: number,
  tokensOut: number,
): { usd: number; priced: boolean } {
  const rate = rateFor(model);
  if (rate === null) return { usd: 0, priced: false };
  const usd = (tokensIn / 1_000_000) * rate.input + (tokensOut / 1_000_000) * rate.output;
  return { usd: Math.round(usd * 1_000_000) / 1_000_000, priced: true };
}

/**
 * What a closing step actually spent (the owner's rule, 2026-10-28: «a step that wrote a chapter
 * cannot read as free»). The close reports what its own session believes; the database answers
 * what it knows — every model call the pass made left a `drafting` stage row with its tokens and
 * its model, and each gate left its verdict row. So a reaper close that names no model still
 * books the calls, and a caller that under-reports can never shrink them.
 *
 * The protocol keeps the two parts apart: a close reports the writer's own calls, each gate's are
 * its verdict row. So the report and the stage sum describe the same calls — the larger wins, a
 * missing stage cannot erase a report — and the gate rows are added on top, once.
 * The model is the reported one, else the pass's first drafting model.
 *
 * Only `drafting` rows are summed: one per model call, its own usage. A `landed` row is the pass's
 * whole money line (writer and gates together), so counting it here would charge the gates twice.
 */
export function spendOfClose(
  db: Db,
  stepId: string,
  reported: { model: string | null; tokensIn: number; tokensOut: number },
): { model: string | null; tokensIn: number; tokensOut: number } {
  const stages = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_in), 0) AS tokensIn, COALESCE(SUM(tokens_out), 0) AS tokensOut,
              (SELECT actor_model FROM pass_stages
                WHERE pass_id = ? AND stage = 'drafting' AND actor_model IS NOT NULL
                ORDER BY seq LIMIT 1) AS model
         FROM pass_stages WHERE pass_id = ? AND stage = 'drafting'`,
    )
    .get(stepId, stepId) as { tokensIn: number; tokensOut: number; model: string | null };
  const gates = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_in), 0) AS tokensIn, COALESCE(SUM(tokens_out), 0) AS tokensOut
         FROM gate_verdicts WHERE step_id = ?`,
    )
    .get(stepId) as { tokensIn: number; tokensOut: number };
  return {
    model: reported.model ?? stages.model ?? null,
    tokensIn: Math.max(reported.tokensIn, stages.tokensIn) + gates.tokensIn,
    tokensOut: Math.max(reported.tokensOut, stages.tokensOut) + gates.tokensOut,
  };
}

/**
 * The close's one money fact: attribute what the pass spent (reported ∪ drafting stages ∪ gate
 * verdicts) and write the ledger row — in the close's own transaction, for every close path
 * (`done`, `seen`, `escalate`, the wall, the gate window). `spendOfClose` and `passSpendOf` are
 * the two halves; this keeps `close.ts` to one call.
 */
export function recordCloseSpend(
  db: Db,
  input: {
    step: { step_id: string; chapter: number | null; pass: PassSpendInput['pass'] };
    changeId: string | null;
    now: number;
    model: string | null;
    tokensIn?: number;
    tokensOut?: number;
  },
): boolean {
  const spend = spendOfClose(db, input.step.step_id, {
    model: input.model,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
  });
  return recordPassSpend(db, passSpendOf(input.step, spend, input.changeId, input.now));
}

/**
 * Write the pass's one ledger row, inside the close's own transaction.
 *
 * `INSERT OR IGNORE` on `pass_id`: a re-close is not a second charge. The provider's cache
 * split is not recorded on a step, so the prompt is priced as fresh — the ledger may overstate
 * a pass slightly, never understate the day it has to bound.
 */
export function recordPassSpend(db: Db, input: PassSpendInput): boolean {
  // BOOK-114's table is the one price list (`cost/rates.ts`); the step holds no cache split, so
  // the prompt is priced as fresh — the ledger may overstate a pass, never understate a day.
  const { usd, priced } = usdOfModel(input.model, input.tokensIn, input.tokensOut);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO pass_spend
         (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced)
       VALUES (@at, @day, @passId, @chapter, @pass, @changeId, @model, @tokensIn, @tokensOut, @usd, @priced)`,
    )
    .run({
      at: input.at,
      day: utcDay(Date.parse(input.at)),
      passId: input.passId,
      chapter: input.chapter,
      pass: input.pass,
      changeId: input.changeId,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      usd,
      priced: priced ? 1 : 0,
    });
  return result.changes === 1;
}
