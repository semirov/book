/**
 * The cascade scheduler (ARCHITECTURE.md §6A.6, ADR-015/023/030) — the ripple.
 *
 * A **pure** function of the cascade's recorded steps: no clock, no SQL, no model. That is
 * deliberate. `planCascade` is where "how far does the consequence travel" is decided, and
 * the stop table of §6A.6 is only trustworthy if it can be enumerated in a test with a
 * fixed seam graph and a fixed budget. The service calls it after every step closes; it
 * either opens exactly one step per wing, waits, or closes the cascade with one outcome.
 *
 * Geometry: one step per wing per wave, the upward wing trailing the downward one by
 * `upwardLagWaves` — but the lag never becomes a stall: if the downward wing cannot move
 * (the beginning, an empty slot, a bound), the upward wing starts at once. A wing only ever
 * moves one chapter away from the origin, so "no wholesale rewrite" is structural rather
 * than a promise: the scheduler has no expression that could plan a distant chapter.
 */

import { TOTAL_CHAPTERS } from '@book/shared';
import type {
  CascadeBudget,
  CascadeOutcome,
  Lane,
  SeamBoundary,
  SeamRef,
  StepOutcome,
  StepPass,
} from '@book/shared';

import { budgetBreach, budgetReason, type BudgetBreach } from './budget.ts';

export type CascadeStepFact = {
  seq: number;
  pass: StepPass;
  chapter: number | null;
  lane: Lane | null;
  wave: number;
  outcome: StepOutcome | null;
  seamsIn: SeamRef[];
  seamsOut: SeamRef[];
};

export type CascadeFacts = {
  origin: number;
  budget: CascadeBudget;
  openedAtMs: number;
  tokens: number;
  steps: CascadeStepFact[];
};

export type PlannedStep = {
  pass: 'cascade' | 'front' | 'ending';
  chapter: number | null;
  isFront: boolean;
  lane: Lane | null;
  wave: number;
  boundary: SeamBoundary;
  seamsIn: SeamRef[];
};

export type CascadePlan =
  | { kind: 'wait' }
  | { kind: 'open'; steps: PlannedStep[] }
  | { kind: 'close'; outcome: CascadeOutcome; reason: string; alert: boolean };

export type PlanContext = {
  nowMs: number;
  written: ReadonlySet<number>;
  /** Set by the service when a rule outside the geometry stops the ripple (C2, gate, delta). */
  forceOutcome?: CascadeOutcome | null;
  forceReason?: string | null;
};

type WingState = {
  steps: CascadeStepFact[];
  frontier: number;
  last: CascadeStepFact | null;
  /** The last step reported no new seam: the wing is done, nothing further to repair. */
  held: boolean;
  /** The wing stepped onto the edge of the book (chapter 1 or `TOTAL_CHAPTERS`). */
  reachedEdge: boolean;
  /** The next chapter exists but is empty: the ripple stops at the drafting frontier (§6A.10). */
  atFrontier: boolean;
};

const CLOSE_COPY = {
  local: 'правка осталась в своей главе',
  consistent: 'правка прошла по книге и дальше держится',
  absorbed: 'правка осталась в соседних главах',
  frontier: 'правка дошла до ещё не написанной главы',
  budget: 'правка остановлена бюджетом — нужно решение',
  oscillation: 'правка ходит по кругу — нужно решение',
  origin: 'починка требует главы позади волны — нужно решение',
  finding: 'замечание сохранено, правка опубликована',
  delta: 'починка задела слишком много текста — нужно решение',
  ending: 'финал проверен, но требует решения',
  // BOOK-76: the claim itself did not enter the book — never «правка опубликована».
  science: 'не входит в книгу — правка ждёт решения',
  // BOOK-61: Gate B's one word (§5). The card's reason carries the rule's own fixed
  // sentence; this line is the fallback when a close names no rule.
  rights: 'не принято',
  gate: 'проверка не ответила вовремя — шаг остановлен',
} as const;

const SEAM_FALLBACK = 'соседняя глава изменена';

export type CloseCopyKey = keyof typeof CLOSE_COPY;

/** The Russian one-liner a change carries for a stop reason (§12.6 — public, no internals). */
export function closeReason(kind: CloseCopyKey): string {
  return CLOSE_COPY[kind];
}

function chapterOf(step: CascadeStepFact): number | null {
  return step.chapter;
}

function wingState(steps: CascadeStepFact[], origin: number, direction: 'downward' | 'upward'): WingState {
  const lane: Lane = direction === 'downward' ? 'backward' : 'forward';
  const own = steps.filter((step) => step.pass === 'cascade' && step.lane === lane && step.chapter !== null);
  const last = own.length > 0 ? (own[own.length - 1] ?? null) : null;
  const frontier =
    own.length === 0
      ? origin
      : direction === 'downward'
        ? Math.min(...own.map((step) => chapterOf(step) ?? origin))
        : Math.max(...own.map((step) => chapterOf(step) ?? origin));
  const edge = direction === 'downward' ? 1 : TOTAL_CHAPTERS;
  return {
    steps: own,
    frontier,
    last,
    held: last !== null && last.seamsOut.length === 0,
    reachedEdge: frontier === edge,
    atFrontier: false,
  };
}

function seamsFor(steps: CascadeStepFact[], boundary: number, originSeams: SeamRef[]): SeamRef[] {
  for (const step of [...steps].reverse()) {
    const match = step.seamsOut.find((seam) => seam.boundary === boundary);
    if (match) return [match];
  }
  const fallback = originSeams[0]?.reason ?? SEAM_FALLBACK;
  return [{ boundary, reason: fallback }];
}

function startsUp(facts: CascadeFacts): boolean {
  const steps = facts.steps;
  const down = steps.filter((step) => step.pass === 'cascade' && step.lane === 'backward');
  const up = steps.filter((step) => step.pass === 'cascade' && step.lane === 'forward');
  const downHeld = down.some((step) => step.seamsOut.length === 0);
  // Nothing below the origin: there is no downward wing to wait for.
  if (facts.origin === 1 || downHeld) return true;
  // `upwardLagWaves` is a fact the budget freezes and the planner obeys: the upward wing
  // starts once the downward frontier is that many steps ahead. One step is one wave, so the
  // difference of the two wings' step counts is the lag in the book. A lag of 0 is legal and
  // means "both wings at once" — the field is never decoration.
  const lag = Math.max(0, Math.trunc(facts.budget.upwardLagWaves));
  return down.length - up.length >= lag;
}

/**
 * Decide the next move of one ripple. Call only when no step of the cascade is open;
 * otherwise the answer is `wait` and the caller must let the running step finish first.
 */
export function planCascade(facts: CascadeFacts, context: PlanContext): CascadePlan {
  const { budget, origin } = facts;
  const steps = facts.steps;

  if (context.forceOutcome) {
    return {
      kind: 'close',
      outcome: context.forceOutcome,
      reason: context.forceReason ?? CLOSE_COPY.origin,
      alert: true,
    };
  }

  const originStep = steps.find((step) => step.pass === 'change');
  if (originStep === undefined) {
    // Nothing has been recorded yet: the origin step is created by the lane, not here.
    return { kind: 'wait' };
  }
  if (steps.some((step) => step.outcome === null)) return { kind: 'wait' };

  const finding = steps.some((step) => step.outcome === 'published_with_finding');
  const frontStep = steps.find((step) => step.pass === 'front');
  const endingStep = steps.find((step) => step.pass === 'ending');
  const originSeams = originStep.seamsOut;

  // The origin reported no seam: it was a local change and no ripple opens (§6A.4 step 7).
  if (originSeams.length === 0 && steps.length === 1) {
    return { kind: 'close', outcome: 'local', reason: CLOSE_COPY.local, alert: false };
  }

  const down = wingState(steps, origin, 'downward');
  const up = wingState(steps, origin, 'upward');
  const touched = new Set<number>([origin]);
  for (const step of steps) {
    const chapter = chapterOf(step);
    if (chapter !== null && step.pass === 'cascade') touched.add(chapter);
  }

  const currentWave = steps.reduce((max, step) => Math.max(max, step.wave), 0);
  const elapsedMs = Math.max(0, context.nowMs - facts.openedAtMs);

  const planned: PlannedStep[] = [];
  let stop: CascadeOutcome | null = null;
  let stopReason: string | null = null;

  const budgetStop = (outcome: CascadeOutcome, reason: string): void => {
    stop = outcome;
    stopReason = reason;
  };
  /** Which bound (if any) one more step would cross. `addsChapter` is false for the edges. */
  const crosses = (addsChapter: 1 | 0): BudgetBreach => {
    return budgetBreach(
      budget,
      {
        wave: currentWave,
        steps: steps.length + planned.length,
        chapters: touched.size,
        tokens: facts.tokens,
        elapsedMs,
      },
      addsChapter === 1,
    );
  };

  // ── downward wing ────────────────────────────────────────────────────────────
  const downNeedsFront = down.reachedEdge && frontStep === undefined;
  const downDone = down.held || down.reachedEdge;
  if (!downDone) {
    const next = down.frontier - 1;
    if (next >= 1 && context.written.has(next) && !touched.has(next)) {
      const breach = crosses(1);
      if (breach !== null) {
        budgetStop('escalated:budget', budgetReason(breach, budget));
      } else {
        planned.push({
          pass: 'cascade',
          chapter: next,
          isFront: false,
          lane: 'backward',
          wave: currentWave + 1,
          boundary: down.frontier,
          seamsIn: seamsFor(steps, down.frontier, originSeams),
        });
      }
    } else if (next >= 1 && touched.has(next)) {
      budgetStop('escalated:oscillation', CLOSE_COPY.oscillation);
    } else if (next < 1) {
      // The origin or the last step sits on chapter 1: the beginning is reached.
    } else {
      down.atFrontier = true;
    }
  }

  // ── upward wing (one wave behind, but never stalled by the downward wing) ─────
  const lagOk = startsUp(facts) || down.reachedEdge || down.held || down.atFrontier;
  let upNeedsEnding = up.reachedEdge && endingStep === undefined;
  const upDone = up.held || up.reachedEdge;
  if (lagOk && !upDone) {
    const next = up.frontier + 1;
    if (next === TOTAL_CHAPTERS) {
      // ADR-024: a ripple that reaches the end evaluates it — it never rewrites the last chapter.
      upNeedsEnding = endingStep === undefined;
    } else if (next <= TOTAL_CHAPTERS && context.written.has(next) && !touched.has(next)) {
      const breach = crosses(1);
      if (breach !== null) {
        budgetStop('escalated:budget', budgetReason(breach, budget));
      } else {
        planned.push({
          pass: 'cascade',
          chapter: next,
          isFront: false,
          lane: 'forward',
          wave: currentWave + 1,
          boundary: next,
          seamsIn: seamsFor(steps, next, originSeams),
        });
      }
    } else if (next <= TOTAL_CHAPTERS && touched.has(next)) {
      budgetStop('escalated:oscillation', CLOSE_COPY.oscillation);
    } else if (next > TOTAL_CHAPTERS) {
      // The last chapter is reached: the ending is evaluated, never rewritten (ADR-024).
    } else {
      up.atFrontier = true;
    }
  }

  if (stop !== null) {
    return { kind: 'close', outcome: stop, reason: stopReason ?? CLOSE_COPY.budget, alert: true };
  }
  if (planned.length > 0) {
    // The two mandatory boundary steps are issued only when the wings have come to rest:
    // a front step is the proof that the ripple reached the beginning, not a mid-wave job.
    return { kind: 'open', steps: planned };
  }

  // ── the edges: exactly one front step, exactly one ending evaluation ─────────
  // A boundary proof is not a wave: it reports the wave the ripple rests in, never `+1`, or a
  // ripple resting in its last wave at the book edge would record one wave more than it ran.
  // That is why these two steps are not run through `crosses()`: there is no wave to cross.
  const boundary: PlannedStep[] = [];
  if (downNeedsFront) {
    if (steps.length + 1 > budget.maxSteps) {
      return { kind: 'close', outcome: 'escalated:budget', reason: CLOSE_COPY.budget, alert: true };
    }
    boundary.push({
      pass: 'front',
      chapter: null,
      isFront: true,
      lane: null,
      wave: currentWave,
      boundary: 'front',
      seamsIn: [{ boundary: 'front', reason: originSeams[0]?.reason ?? SEAM_FALLBACK }],
    });
  }
  if (upNeedsEnding) {
    if (steps.length + boundary.length + 1 > budget.maxSteps) {
      return { kind: 'close', outcome: 'escalated:budget', reason: CLOSE_COPY.budget, alert: true };
    }
    boundary.push({
      pass: 'ending',
      chapter: TOTAL_CHAPTERS,
      isFront: false,
      lane: null,
      wave: currentWave,
      boundary: 'ending',
      seamsIn: [{ boundary: 'ending', reason: originSeams[0]?.reason ?? SEAM_FALLBACK }],
    });
  }
  if (boundary.length > 0) {
    if (elapsedMs >= budget.maxWallMs || facts.tokens >= budget.maxTokens) {
      return { kind: 'close', outcome: 'escalated:budget', reason: CLOSE_COPY.budget, alert: true };
    }
    return { kind: 'open', steps: boundary };
  }

  // ── nothing left to open: close with the honest outcome ──────────────────────
  if (finding) {
    return { kind: 'close', outcome: 'escalated:finding', reason: CLOSE_COPY.finding, alert: true };
  }
  if (down.atFrontier || up.atFrontier) {
    return { kind: 'close', outcome: 'frontier', reason: CLOSE_COPY.frontier, alert: false };
  }
  const visited = steps.filter((step) => step.pass === 'cascade' && step.chapter !== null);
  const maxDepth = visited.reduce(
    (depth, step) => Math.max(depth, Math.abs((step.chapter ?? origin) - origin)),
    0,
  );
  return {
    kind: 'close',
    outcome: maxDepth <= 1 ? 'absorbed' : 'consistent',
    reason: maxDepth <= 1 ? CLOSE_COPY.absorbed : CLOSE_COPY.consistent,
    alert: false,
  };
}
