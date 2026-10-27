/**
 * The **public** shape of the writing engine (ARCHITECTURE.md §6A.8, §6B.6, §9, §10.3a).
 *
 * The site renders changes, a queue and a ripple from these objects; the engine keeps the
 * internal ones (`shared/src/change.ts`). BOOK-76 amends the old rule: **one** fact about a
 * gate is now public — the physics pass, as the single word `scienceCheck` — and the name of
 * the role that answers it lives in web copy (`web/src/lib/science.ts`), never here. No field
 * in this file carries a verdict, a finding, a severity or a price.
 *
 * Everything is derived from rows the engine already writes:
 * `changes`, `cascades`, `steps`, `change_events`, `gate_verdicts` (that one word) and the
 * public part of `events`.
 */

import type { InterventionKind } from './intervention.ts';
import type {
  AppliesVerdict,
  AnchorState,
  CascadeStatus,
  ChangeKind,
  ChangeOutcome,
  ChangeStatus,
  RelevanceGrade,
  RetroMode,
  SeamBoundary,
  SeamRef,
  StepOutcome,
  StepPass,
} from './change.ts';
import type { CascadeWingsDto, EngineStatus } from './types.ts';

/** §10.3a caps the quoted intent at 280 characters on every public surface. */
export const PUBLIC_INTENT_MAX_CHARS = 280;

/** The outcome vocabulary a reader's thread uses; never a status code and never a reason. */
export type ChangeDecisionOutcome =
  | 'applied'
  | 'adapted'
  | 'dropped'
  | 'superseded'
  | 'escalated'
  | 'failed';

/** Relevance evidence as it is shown on the change card (§6A.7). */
export type PublicRelevance = {
  grade: RelevanceGrade;
  revAtRecord: number;
  revNow: number;
  anchor: AnchorState;
  applies: AppliesVerdict;
  overlap: number;
  chapterRewritten: boolean;
  evidence: string[];
  reason: string | null;
};

/** A seam as the reader can check it: the boundary and the writer's one clause. */
export type PublicSeam = { boundary: SeamBoundary; reason: string; resolved: boolean };

/**
 * A change's own numbers (BOOK-DOC-4 «Honesty about cost»): the model, the tokens it spent,
 * and the money **only if it was measured**.
 *
 * `rub: null` means no price was applied to these tokens — the row's `cost_rub` is the
 * column's placeholder zero and its `cost_priced` marker is 0 — so no surface may print a
 * ₽ figure for it. A priced contribution that happened to cost nothing is the number `0`,
 * and only a measured zero prints «0,00 ₽».
 */
export type ChangeCostDto = {
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  rub: number | null;
};

/**
 * The one place that decides whether a stored amount is a measurement: only a row carrying
 * the `cost_priced` marker has a price, and a priced zero is a real «0,00 ₽». No price source
 * exists yet, so every row written today is unpriced and its money travels as `null`.
 */
export function measuredRub(stored: number | null | undefined, priced: boolean): number | null {
  if (!priced) return null;
  if (typeof stored !== 'number' || !Number.isFinite(stored) || stored < 0) return null;
  return stored;
}

/**
 * One step of a ripple — what the step did, and whether a finding survived it. Never a
 * verdict word, a finding's text, a severity or a role (§6B.6); the physics pass travels as
 * one word on the change itself (`ChangeDto.scienceCheck`).
 */
export type ChangeStepDto = {
  seq: number;
  wave: number;
  wing: 'downward' | 'upward' | null;
  chapter: number | 'front' | null;
  pass: StepPass;
  boundary: SeamBoundary;
  outcome: StepOutcome | null;
  revBefore: number | null;
  revAfter: number | null;
  seamsIn: SeamRef[];
  seamsOut: SeamRef[];
  charsDelta: number | null;
  note: string | null;
  at: string;
  /** Aggregate only: how many writer revisions the step took («правка 3»). */
  cycles: number;
  /** Aggregate only: «замечание сохранено» — never which gate said what. */
  findingSurvived: boolean;
};

export type ChangeCascadeDto = {
  id: string;
  status: CascadeStatus;
  outcome: string | null;
  wave: number;
  depth: { forward: number; backward: number };
  chaptersChecked: number[];
  chaptersRewritten: number[];
  seams: PublicSeam[];
  /** Both wings of the ripple: each frontier, its own wave, its state and what it reached. */
  wings: CascadeWingsDto;
  /**
   * The retroactive causes the change was filed with, in the fixed mode order — a plain list
   * per change. Never the finding text, never a role (§6B.6).
   */
  modes: RetroMode[];
  /**
   * Aggregate only (§6A.8) — the iteration count and whether a finding survived the cap,
   * never the findings themselves and never which role said what.
   */
  gates: { cycles: number; findingSurvived: boolean };
  tokens: { total: number };
  ms: number;
};

/**
 * `GET /api/changes/:id` and the payload behind the change card (§9, §11.7).
 */
export type ChangeDto = {
  id: string;
  seq: number;
  kind: ChangeKind;
  /**
   * BOOK-16 — the kind of the intervention that raised this change, as one of the four
   * stable ids; the card prints its Russian label and nothing else. Null for a change with
   * no comment and for a comment stored before BOOK-16.
   */
  interventionKind: InterventionKind | null;
  chapter: number;
  /** ≤280 chars; quoted as the author's restatement, never as site copy. */
  intent: string;
  /** BOOK-7 — a reader's premise for a chapter with no text: it never enters the lane. */
  premise: boolean;
  source: { commentId: string | null; author: string | null };
  base: { rev: number };
  scopeHint: 'phrase' | 'chapter';
  status: ChangeStatus;
  outcome: ChangeOutcome | null;
  /** The public one-liner when a change was dropped or escalated. */
  reason: string | null;
  /** 1-based place in the FIFO lane while `pending`; null otherwise. */
  position: number | null;
  relevance: PublicRelevance | null;
  cascade: ChangeCascadeDto | null;
  /** The same list as `cascade.modes`, present even for a change that raised no ripple. */
  modes: RetroMode[];
  steps: ChangeStepDto[];
  appliedRevs: Array<{ chapter: number; rev: number }>;
  /** Null when nothing was spent yet; `cost.rub` is null whenever the money is unmeasured. */
  cost: ChangeCostDto | null;
  /**
   * BOOK-76 — the physics pass on this change as one public fact: `'passed'` when every
   * step that closed carries a consultant `HOLDS`, `'failed'` when one carries `GAP`
   * (a `GAP` implies a blocker — a blockerless one is stored as `HOLDS`), `null` while a
   * step has no answer. Never a finding, never a severity, never a role, never a price.
   */
  scienceCheck: 'passed' | 'failed' | null;
  history: null | { fromHseq: number; toHseq: number };
  enqueuedAt: string;
  startedAt: string | null;
  decidedAt: string | null;
};

/** One row of `GET /api/changes` — the list view, newest first. */
export type ChangeSummaryDto = {
  id: string;
  seq: number;
  chapter: number;
  intent: string;
  /** BOOK-7 — a chapter-level premise: it waits for the chapter's first pass, not the lane. */
  premise: boolean;
  status: ChangeStatus;
  outcome: ChangeOutcome | null;
  reason: string | null;
  position: number | null;
  enqueuedAt: string;
  decidedAt: string | null;
  /** Chapters the ripple reached, origin first; empty while nothing has run. */
  chapters: number[];
  /** The subset of `chapters` actually rewritten; empty until a step landed. */
  rewritten: number[];
  /** Steps recorded for the change — the same number the card derives from `steps.length`. */
  steps: number;
  /** The retroactive causes filed with this change, in the fixed mode order. */
  modes: RetroMode[];
  cascade: null | { id: string; status: CascadeStatus; outcome: string | null };
};

/** `GET /api/queue` (§9): the head of the lane, its depth and its shape. */
export type QueueDto = {
  depth: number;
  byState: { pending: number; processing: number; stale: number; escalated: number; done24h: number };
  head: null | { id: string; chapter: number; enqueuedAt: string; waitMs: number };
  processing: null | { id: string; chapter: number; startedAt: string; stage: string };
  lastDecidedAt: string | null;
};

/** `/healthz`'s engine block: `absent` means no process has ever beaten (§9, §18). */
export type EngineHealthDto = {
  status: EngineStatus;
  heartbeatAt: string | null;
  laneId: string | null;
};

/** `engine:state` (§10.3a): rare transitions — paused, throttled, gone, back. */
export type EngineStatePayload = {
  status: EngineStatus;
  since: string | null;
  reason: string | null;
  queue: { depth: number };
};

export type ChangeQueuedPayload = {
  id: string;
  seq: number;
  kind: ChangeKind;
  chapter: number;
  intent: string;
  source: { commentId: string | null; author: string | null };
  queue: { depth: number; ahead: number };
  base: { rev: number };
  scopeHint: 'phrase' | 'chapter';
};

export type ChangeProcessingPayload = {
  id: string;
  chapter: number;
  startedAt: string;
  attempt: number;
  relevance: PublicRelevance | null;
};

export type ChangeStalePayload = {
  id: string;
  grade: RelevanceGrade;
  evidence: string[];
  options: Array<'adapt' | 'drop'>;
  survivesAs: string | null;
};

export type ChangeDecidedPayload = {
  id: string;
  commentId: string | null;
  outcome: ChangeDecisionOutcome;
  reason: string | null;
  chapters: number[];
  cascade: null | {
    id: string;
    outcome: string | null;
    waves: number;
    touched: number[];
    rewritten: number[];
    wings: CascadeWingsDto;
    seams: Array<{ boundary: SeamBoundary; resolved: boolean }>;
    finding: boolean;
  };
  relevance: null | { grade: RelevanceGrade };
  tokens: { total: number };
  decidedAt: string;
};

/** One frame per cascade stage; the ribbon's only animation source (§10.3a, §11.7). */
export type CascadeProgressPayload = {
  cascadeId: string;
  changeId: string;
  /** The chapter the ripple started in; the ribbon draws its tick here. */
  origin: number;
  wave: number;
  lane: 'forward' | 'backward' | null;
  chapter: number | 'front' | null;
  boundary: SeamBoundary;
  phase: 'rewrite' | 'holds' | 'absorbed' | 'escalated';
  outcome: StepOutcome | null;
  rev: { before: number | null; after: number | null };
  frontier: { forward: number | null; backward: number | null };
  /** Both wings as recorded so far; the ribbon draws them from this, never from a timer. */
  wings: CascadeWingsDto;
  touched: number[];
  rewritten: number[];
  seamsIn: SeamRef[];
  seamsOut: SeamRef[];
  budget: { steps: number; maxSteps: number; msLeft: number };
};
