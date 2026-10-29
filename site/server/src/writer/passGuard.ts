/**
 * The pass's money guard (`docs/writer-lane.md` §6, BOOK-117): a pass that would cross a cap
 * never asks the engine for a job.
 *
 * It lives apart from `pass.ts` because the pass was at the file-size wall, and because the rule
 * is one rule with one answer: `idle` (the day's budget says stop), `refused` (nothing could be
 * priced) or the estimate the pass then carries to the ledger.
 */

import type { BudgetDto, WriterAssignment } from '@book/shared';

import type { EngineClient, EngineStateView } from './client.ts';
import { capLine, estimateLine, estimatePassUsd, type PassEstimate } from './estimate.ts';
import type { PassResult } from './laneTypes.ts';
import type { WriteMode } from './mode.ts';
import { readerFallbacks, readerReason } from './reasons.ts';
import type { WriterConfig } from './config.ts';

export type Guarded =
  | { ok: true; budget: BudgetDto | null; estimate: PassEstimate | null }
  | { ok: false; result: PassResult };

export async function moneyGuard(input: {
  config: WriterConfig;
  bookRoot: string;
  engine: EngineClient;
  log: (line: string) => void;
}): Promise<Guarded> {
  let state: EngineStateView;
  try {
    state = await input.engine.state();
  } catch (error) {
    return { ok: false, result: { status: 'refused', reason: error instanceof Error ? error.message : 'движок не ответил' } };
  }
  // Tokens are information, not a bound (2026-10-27): the $ cap is, so `tokens.today` is unread.
  const budget: BudgetDto | null = state.budget ?? null;
  if (budget === null) {
    // An engine from before the cap reports no money: say so — a silent pretend-bound is worse.
    input.log('[writer] бюджет недоступен: движок не отдаёт потолки — проход идёт без денежной проверки');
    return { ok: true, budget, estimate: null };
  }
  if (budget.state === 'stop' || budget.state === 'pause') {
    input.log(`[writer] idle ${budget.line}`);
    return { ok: false, result: { status: 'idle', reason: budget.line } };
  }
  // The estimate precedes the assignment: a pass that would not fit is never opened.
  let priced: PassEstimate;
  try {
    priced = estimatePassUsd({
      pricing: input.config.pipeline.pricing,
      bookRoot: input.bookRoot,
      continueMax: input.config.continueMax,
    });
  } catch (error) {
    return {
      ok: false,
      result: { status: 'refused', reason: error instanceof Error ? error.message : 'оценка прохода не собрана' },
    };
  }
  input.log(estimateLine(priced, budget));
  const crossed = capLine(budget, priced.usd);
  if (crossed !== null) {
    input.log(`[writer] idle ${crossed}`);
    return { ok: false, result: { status: 'idle', reason: crossed } };
  }
  return { ok: true, budget, estimate: priced };
}

/**
 * BOOK-206 + BOOK-173 §4 — the read before the patch.
 *
 * `null` means the pass may go on. A **patch** over a change whose filing is still waiting for
 * its read is refused: the writer is the only triage caller, so an attempt that is `submitted`
 * with no verdict is a judgement nobody has made, and a patch would key the reader's words to a
 * reading that does not exist. A rewrite is main's own path and is not what this guard owns; a
 * settled attempt with no verdict is a read (an operator's decision) and passes.
 */
export function triageGuard(
  job: Pick<WriterAssignment, 'stepId' | 'changeId' | 'triage'>,
  mode: WriteMode,
  log: (line: string) => void,
): PassResult | null {
  if (mode !== 'patch' || !job.triage.awaitingRead) return null;
  log(`[writer] TRIAGE_REQUIRED: заявка ${job.changeId ?? '—'} ещё не прочитана — правка не внесена`);
  return {
    status: 'refused',
    stepId: job.stepId,
    changeId: job.changeId,
    reason: readerReason('TRIAGE_REQUIRED', readerFallbacks.stopped),
    code: 'TRIAGE_REQUIRED',
  };
}
