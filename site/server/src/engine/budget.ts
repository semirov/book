/**
 * The bounds of a cascade (ARCHITECTURE.md §6A.6, §6D.2, ADR-015/030).
 *
 * Every number is frozen into `cascades.budget` when the cascade opens, so a retune of the
 * environment cannot change the rules of a ripple already in flight — the trace must
 * explain the run that happened, not a later build's defaults.
 */

import type { CascadeBudget } from '@book/shared';

import type { Config } from '../config.ts';

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
    case 'steps':
      return `правка потребовала больше ${budget.maxSteps} шагов — нужно решение`;
    case 'chapters':
      return `правка задела больше ${budget.maxChapters} глав — нужно решение`;
    case 'tokens':
      return 'правка упирается в бюджет токенов — нужно решение';
    case 'wall':
      return 'правка идёт дольше отведённого времени — нужно решение';
    default:
      return 'правка остановлена бюджетом — нужно решение';
  }
}
