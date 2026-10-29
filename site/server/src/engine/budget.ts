/**
 * The bounds of a cascade (ARCHITECTURE.md §6A.6, §6D.2, ADR-015/030).
 *
 * Every number is frozen into `cascades.budget` when the cascade opens, so a retune of the
 * environment cannot change the rules of a ripple already in flight — the trace must
 * explain the run that happened, not a later build's defaults.
 */

import { FAILURE_LINES, type BudgetScope, type CascadeBudget } from '@book/shared';

import type { Config } from '../config.ts';
import { WARN_RATIO, budgetSnapshot, budgetWarnLine, type BudgetCaps } from '../budget.ts';
import { recordAlert } from './alerts.ts';
import { getMeta, setMeta } from './rows.ts';
import { toIso } from '../util/time.ts';
import type { EngineDeps } from './types.ts';

export function budgetFromConfig(config: Config): CascadeBudget {
  return {
    maxWave: config.budgetMaxWave,
    maxChapters: config.budgetMaxChapters,
    maxSteps: config.budgetMaxSteps,
    maxRewritesPerChapter: config.maxRewritesPerChapter,
    upwardLagWaves: config.upwardLagWaves,
    maxWallMs: config.budgetMaxWallMs,
    maxTokens: config.budgetMaxTokens,
    maxDeltaRatio: config.maxDeltaRatio,
  };
}

export type BudgetState = {
  wave: number;
  steps: number;
  chapters: number;
  tokens: number;
  elapsedMs: number;
};

export type BudgetBreach = 'wave' | 'steps' | 'chapters' | 'tokens' | 'wall' | null;

/** Which bound (if any) a *next* step would cross. Order matters only for the message. */
export function budgetBreach(budget: CascadeBudget, state: BudgetState, addsChapter: boolean): BudgetBreach {
  if (state.steps + 1 > budget.maxSteps) return 'steps';
  if (state.chapters + (addsChapter ? 1 : 0) > budget.maxChapters) return 'chapters';
  if (state.wave + 1 > budget.maxWave) return 'wave';
  if (state.tokens >= budget.maxTokens) return 'tokens';
  if (state.elapsedMs >= budget.maxWallMs) return 'wall';
  return null;
}

/** The public, one-line reason a change carries when the ripple was stopped by a bound. */
export function budgetReason(breach: Exclude<BudgetBreach, null>, budget: CascadeBudget): string {
  switch (breach) {
    case 'wave':
      // BOOK-59: with one wave the bound is not a failure — it is where a deeper change asks
      // for the owner's decision. The line says so, and never names a budget or a number run.
      return budget.maxWave === 1
        ? 'правка сделала одну волну — вторая волна только по решению владельца'
        : `правка ушла глубже ${String(budget.maxWave)} волн — дальше только по решению владельца`;
    // BOOK-218 — the only reason vocabulary: a bound is our failure, never «нужно решение».
    case 'wall':
      return FAILURE_LINES.outOfTime;
    case 'steps':
    case 'chapters':
    case 'tokens':
    default:
      return FAILURE_LINES.ourFailure;
  }
}

/**
 * BOOK-117 — the 80 % sentence, once per scope and never once per pass. A marker in `meta`
 * is the whole mechanism (`budget.warned.day.<day>`, `budget.warned.book`): the second pass
 * over the same threshold finds it and stays quiet, and the next UTC day starts unmarked.
 *
 * The engine raises it on its own tick, next to the heartbeat: the sentence arrives with the
 * spend that crossed the threshold, and a warning never depends on a caller asking for it.
 */
export function noteBudgetWarnings(deps: EngineDeps, caps: BudgetCaps, nowMs: number): void {
  const dto = budgetSnapshot(deps.db, caps, nowMs);
  const warn = (key: string, scope: BudgetScope, which: 'day' | 'book'): void => {
    // At or past the cap the scope is not a warning any more: the pause/stop line is the
    // refusal's own message, and a sentence «израсходован на 171 %» would be noise.
    if (scope.ratio < WARN_RATIO || scope.spentUsd >= scope.capUsd) return;
    if (getMeta(deps.db, key) !== null) return;
    setMeta(deps.db, key, toIso(nowMs));
    recordAlert(deps, {
      kind: 'budget',
      at: toIso(nowMs),
      changeId: null,
      cascadeId: null,
      stepId: null,
      detail: budgetWarnLine(scope, which),
    });
  };
  warn(`budget.warned.day.${dto.day.day}`, dto.day, 'day');
  warn('budget.warned.book', dto.book, 'book');
}
