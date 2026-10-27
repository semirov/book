/**
 * The book's outlay (BOOK-114): the arithmetic of the footer's cost line, and the one query
 * that feeds it.
 *
 * The aggregate is `GROUP BY model` — one row per model that has written anything — because
 * the honest total needs the split per rate: input and output are priced differently. Reading
 * the step rows one by one would be the same number at a cost page views cannot pay; this is
 * one indexed scan of a table that grows by a few rows a day.
 */

import type { BookCostDto } from '@book/shared';

import type { Db } from '../db/db.ts';
import { bookStateKey } from '../db/bookKey.ts';
import { USD_RATES_PER_MILLION, rateFor } from './rates.ts';

/** One model's whole spend in the book, as a model-spend query groups it. */
export type ModelSpend = { model: string | null; tokensIn: number; tokensOut: number; steps: number };

/**
 * The one aggregate: GROUP BY model over the **spend ledger** (`pass_spend`, BOOK-117), never a
 * per-step read. The ledger is written inside the transaction that closes a pass, carries the
 * money the engine actually charged and survives a step whose row was later rewritten — it is
 * the book's outlay, and this line is its public reading.
 */
const READ_SQL = `
  SELECT model,
         COALESCE(SUM(tokens_in), 0) AS tokens_in,
         COALESCE(SUM(tokens_out), 0) AS tokens_out,
         COUNT(*) AS steps,
         COALESCE(SUM(usd), 0) AS usd,
         COALESCE(SUM(CASE WHEN priced = 0 AND (tokens_in + tokens_out) > 0 THEN 1 ELSE 0 END), 0) AS unpriced
    FROM pass_spend
   GROUP BY model`;

/** Models sort as names; a row with no model is not a name, so it leads. */
export function compareModels(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : 1;
}

/**
 * Pure: the DTO is a function of the step rows and the rate table, nothing else.
 *
 * An empty book cost nothing: `0` is a measurement here, not a placeholder (§BOOK-DOC-4
 * «Honesty about cost»). The money is rounded **once**, at the end, so the client's `toFixed(2)`
 * and the response's ETag are the same number.
 */
export function costFrom(
  spends: ModelSpend[],
  rates: Readonly<Record<string, { input: number; output: number }>> = USD_RATES_PER_MILLION,
): BookCostDto {
  let tokensIn = 0;
  let tokensOut = 0;
  let steps = 0;
  let usd = 0;
  const unpriced: Array<string | null> = [];

  for (const spend of spends) {
    tokensIn += spend.tokensIn;
    tokensOut += spend.tokensOut;
    steps += spend.steps;
    const rate = rateFor(spend.model, rates);
    if (rate === null) {
      // Only a model that actually spent tokens blanks the price: a zero-token step on an
      // unknown model (a probe, an aborted draft) is not a missing rate.
      if (spend.tokensIn + spend.tokensOut > 0) unpriced.push(spend.model);
      continue;
    }
    usd += (spend.tokensIn / 1_000_000) * rate.input + (spend.tokensOut / 1_000_000) * rate.output;
  }

  return {
    tokens: tokensIn + tokensOut,
    tokensIn,
    tokensOut,
    steps,
    usd: unpriced.length > 0 ? null : Math.round(usd * 100) / 100,
    unpriced: unpriced.sort(compareModels),
  };
}

type LedgerRow = {
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  steps: number;
  usd: number;
  unpriced: number;
};

/** One model's whole spend as the ledger groups it, in the shape the pure function reads. */
export type LedgerSpend = { model: string | null; tokensIn: number; tokensOut: number; steps: number; usd: number; unpriced: number };

/**
 * Pure: the DTO of the ledger aggregate. The money is the ledger's own `usd` (priced once, at
 * close, from the one rate table), summed and rounded **once** here, so the line, the ETag and
 * the client's `toFixed(2)` are the same number. An unpriced pass still counts its tokens and
 * blanks the money (BOOK-114's AC3), never pretending it was free.
 */
export function costFromLedger(rows: LedgerSpend[]): BookCostDto {
  let tokensIn = 0;
  let tokensOut = 0;
  let steps = 0;
  let usd = 0;
  const unpriced: Array<string | null> = [];
  for (const row of rows) {
    tokensIn += row.tokensIn;
    tokensOut += row.tokensOut;
    steps += row.steps;
    usd += row.usd;
    if (row.unpriced > 0) unpriced.push(row.model);
  }
  return {
    tokens: tokensIn + tokensOut,
    tokensIn,
    tokensOut,
    steps,
    usd: unpriced.length > 0 ? null : Math.round(usd * 100) / 100,
    unpriced: unpriced.sort(compareModels),
  };
}

/** The whole book's outlay, from the ledger's one aggregate. */
export function readBookCost(db: Db): BookCostDto {
  const rows = db.prepare(READ_SQL).all() as LedgerRow[];
  return costFromLedger(
    rows.map((row) => ({
      model: row.model,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      steps: row.steps,
      usd: row.usd,
      unpriced: row.unpriced,
    })),
  );
}

/**
 * The cost route's memo key: the book state `GET /api/front` uses, plus the book's clock.
 *
 * Tokens are written into an existing `steps` row when the step **closes**, and a `holds` or
 * `evaluated` close applies no prose — no chapter `rev` moves, no `block_versions` row is
 * appended — so `bookStateKey` alone cannot see the total change and the route would keep
 * serving (and 304-ing) the previous number. `close.ts` writes the tokens and appends
 * `step.closed` in one transaction, and `events.hseq` is the primary key, so `MAX(hseq)` is one
 * indexed read that advances on every step open and close. The byline has no such dependency,
 * which is why this widening lives here and not in `bookStateKey`.
 */
export function costKey(db: Db, frontRev: number): string {
  const events = db.prepare('SELECT COALESCE(MAX(hseq), 0) AS hseq FROM events').get() as { hseq: number };
  return `${bookStateKey(db, frontRev)}|e${events.hseq}`;
}
