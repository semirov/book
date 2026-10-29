/**
 * BOOK-158 — what triage owes the ledger after an answer.
 *
 * Each submission is an attempt (`comments/attempts.ts`); the answer to it is one act: the
 * attempt is closed with what the gate decided, and — when a model read it — the call is
 * charged to the same `pass_spend` ledger the writer lane closes into (`pass = 'triage'`,
 * `pass_id = 'triage:<commentId>:<n>'`). A **refused** pass still writes its row: the money was
 * spent whether or not the filing was accepted, and a ledger that hides a refusal would
 * understate the day it has to bound (BOOK-117, BOOK-23: `priced = 0` means «not measured»).
 *
 * One write per attempt: `INSERT OR IGNORE` on `pass_id` and a conditional update on the row's
 * `submitted` state, so a retried CLI call cannot charge twice or overwrite a first answer.
 */

import type { Db } from '../db/db.ts';
import { utcDay } from '../budget.ts';
import { openAttempt, setAttemptOutcome } from '../comments/attempts.ts';

export type TriageOutcome = 'accepted' | 'refused' | 'held';

/** The optional `--model/--tokens-in/--tokens-out/--usd` facts of one triage pass. */
export type TriageSpend = {
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  usd: number;
};

export type SettleInput = {
  commentId: string;
  chapter: number;
  outcome: TriageOutcome;
  at: string;
  /** Absent when the answer cost no model call (a plain refusal, an operator's hold). */
  spend?: TriageSpend;
};

export type SettledAttempt = { n: number; passId: string };

/**
 * `--model`, `--tokens-in`, `--tokens-out`, `--usd`, read once from a command line. Absent
 * means «no model ran, nothing measured» — a zero amount, priced 0. A value that is not a
 * non-negative number refuses the call instead of being silently dropped: the ledger is money.
 */
export function spendFromFlags(flags: Map<string, string>): { spend: TriageSpend } | { error: string } {
  const tokensIn = countFlag(flags.get('tokens-in'), '--tokens-in');
  if ('error' in tokensIn) return tokensIn;
  const tokensOut = countFlag(flags.get('tokens-out'), '--tokens-out');
  if ('error' in tokensOut) return tokensOut;
  const rawUsd = flags.get('usd');
  const usd = rawUsd === undefined ? 0 : Number(rawUsd);
  if (!Number.isFinite(usd) || usd < 0) return { error: '--usd must be a number ≥ 0' };
  return {
    spend: {
      model: flags.get('model') ?? null,
      tokensIn: tokensIn.value,
      tokensOut: tokensOut.value,
      usd: Math.round(usd * 1_000_000) / 1_000_000,
    },
  };
}

function countFlag(raw: string | undefined, name: string): { value: number } | { error: string } {
  if (raw === undefined) return { value: 0 };
  if (!/^\d+$/u.test(raw)) return { error: `${name} must be a whole number ≥ 0` };
  return { value: Number(raw) };
}

/**
 * Close the filing's latest open attempt and charge the pass. `null` means there was no open
 * attempt to close (a row stored before the ledger, or one a gate already decided), and then
 * nothing is written — no attempt, no charge, no invented number.
 */
export function settleAttempt(db: Db, input: SettleInput): SettledAttempt | null {
  const run = db.transaction((): SettledAttempt | null => {
    const open = openAttempt(db, input.commentId);
    if (open === undefined) return null;
    if (!setAttemptOutcome(db, input.commentId, open.n, input.outcome, input.at)) return null;
    const passId = `triage:${input.commentId}:${open.n}`;
    if (input.spend !== undefined) chargeTriageSpend(db, { ...input.spend, chapter: input.chapter, passId, at: input.at });
    return { n: open.n, passId };
  });
  return run();
}

/**
 * One row of the money ledger for one triage call: `pass = 'triage'`, a `pass_id` per attempt,
 * `INSERT OR IGNORE` so a retried caller cannot charge twice. BOOK-206's engine writes it from
 * the answer it stored — the same row the CLI's `--usd` writes, through the same function.
 */
export function chargeTriageSpend(
  db: Db,
  input: TriageSpend & { chapter: number; passId: string; at: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO pass_spend
       (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced)
     VALUES (?, ?, ?, ?, 'triage', NULL, ?, ?, ?, ?, ?)`,
  ).run(
    input.at,
    utcDay(Date.parse(input.at)),
    input.passId,
    input.chapter,
    input.model,
    input.tokensIn,
    input.tokensOut,
    input.usd,
    // An amount above zero is a measurement; a zero is the honest «never priced» (BOOK-23).
    input.usd > 0 ? 1 : 0,
  );
}
