/**
 * The wire shapes of the writer's gate and close calls, as the engine answers them.
 *
 * They live apart from `client.ts` because that file is at its arch bound; `client.ts` imports
 * and re-exports every one of them, so a caller still imports one module. A view is what a route
 * answered, narrowed to the fields the lane reads — nothing here decides anything.
 */

import type { Finding } from '@book/shared';

import type { Provenance } from '../engine/model.ts';
import type { RipplePlan } from '../ledger/graph/plan.ts';
import type { SentencePatchEdit } from '../sentences/transform.ts';

/** What a gate session receives (`engine/gates.ts` `GateAssignment`), narrowed to what we read. */
/** Gate B's assignment: its own shape (a rule, no prose findings), `rule: null` for a clean scan. */
export type RightsAssignmentView = {
  stepId: string;
  role: 'rights';
  session: string;
  pass: string;
  chapter: number | null;
  landedSha: string | null;
  rule: string | null;
  block: number | null;
  expiresAt: string;
};

/**
 * BOOK-173 §7: the plan a gate judges the change against, as the engine returns it — the closure
 * without its patches, the patches the writer produced and the caps frozen at estimate.
 */
export type GatePlanView = {
  outcome: string;
  nodes: unknown[];
  edges: unknown[];
  patches: unknown[];
  bounds: Record<string, unknown>;
};

export type GateAssignmentView = {
  stepId: string;
  role: 'editor' | 'consultant';
  session: string;
  pass: string;
  chapter: number | null;
  boundary: string;
  cycle: number;
  landedSha: string | null;
  note: string | null;
  indexSlice: string | null;
  /** BOOK-173 §7: the plan of the step's change; `null` when the step has none. */
  plan: GatePlanView | null;
  expiresAt: string;
};

/**
 * The writer's relevance answer, sent with `start` (§6A.7): under FIFO a moved base is the normal
 * case, and only the writer may say what the change still means.
 */
export type StartInput = {
  decision?: 'adapt' | 'drop' | 'void';
  reason?: string;
  intent?: string;
};


/** `--revert` as a restore revision: what the engine published, and what it replaced. */
export type RestoreView = { rev: number; sha: string; previousRev: number };

/**
 * BOOK-187 AC5: the lane's counter. A day other than the row's reads as a fresh one (`passes: 0`),
 * so the writer resets nothing at midnight.
 */
export type WriterStateView = { day: string; passes: number; lastPassAt: string | null; pauseUntil: string | null };

/** What `recordPass` sends: one pass counted, and optionally when the lane may run again. */
export type RecordPassInput = { day: string; spent: boolean; pauseUntil?: string | null };

/**
 * BOOK-187 AC7: the redacted receipt of a pass, as the writer built it — `transcript.ts`'s
 * `TranscriptRow` seen from the wire side, kept equal by the compiler, not by an import.
 */
export type TranscriptRowInput = {
  seq: number;
  at: number;
  role:
    | 'draft'
    | 'repair'
    | 'continue'
    | 'gate:editor'
    | 'gate:consultant'
    | 'gate:rights'
    | 'judge'
    | 'tier1';
  tokensIn: number;
  tokensOut: number;
  promptBundle: string | null;
  content: string;
};

export type TranscriptStored = { stored: number; pruned: number };

export type StartView = {
  leaseId: string;
  stepId?: string;
  chapter?: number | 'front';
  expectedRev?: number;
  sha: string;
  /** Absent on the landed answer (below): a step that already landed has no pre-image to size. */
  chars?: number;
  /**
   * BOOK-219: a step that already landed answers `landed: true` and makes no change — the
   * revision it stands at is `revAfter`, which is what a resumed pass's own re-landing can go
   * back to.
   */
  landed?: boolean;
  revAfter?: number | null;
};

export type LandView = {
  landed: true;
  revAfter: number;
  sha: string;
  changed: boolean;
  deltaRatio: number;
  blocksTouched: number;
  /**
   * BOOK-173: the plan the engine froze at the landing (absent when nothing was planned). The
   * writer reacts to it — it never computes a closure of its own, because it owns no ledger.
   */
  plan?: RipplePlan | null;
};

export type VerdictView = {
  action: 'close' | 'revise' | 'publish_with_finding';
  cycle: number;
  verdict: 'HOLDS' | 'GAP';
  downgraded: boolean;
  late: boolean;
};

/**
 * What a close answers. `STEP_CLOSED` from `done` is not a failure but that close: the step is
 * closed either way (`pass.ts`, the owner's rule of 2026-10-28).
 */
export type DoneView = {
  stepId: string;
  outcome: string;
  cascadeId: string | null;
  changeStatus: string | null;
};

export type VerdictInput = {
  stepId: string;
  role: 'editor' | 'consultant';
  session: string;
  verdict: 'HOLDS' | 'GAP';
  findings: Finding[];
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
};

/** BOOK-61: Gate B answers another question with another enum; `rule` accompanies a REFUSED. */
export type RightsVerdictInput = {
  stepId: string;
  role: 'rights';
  session: string;
  verdict: 'CLEAR' | 'REFUSED';
  rule?: string | null;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
};

export type DoneInput = {
  leaseId: string;
  note?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  seams?: unknown[];
  /** BOOK-173 §4/§5: how the pass wrote — `rewrite` on an unchanged text is a `no-op`. */
  mode?: 'patch' | 'rewrite';
  /** BOOK-DOC-80: which tiers judged this pass — the close records it on the change. */
  verification?: {
    gatesMode: 'local only' | 'full';
    why: string | null;
    tier1Verdict: string | null;
    tier1Usd: number | null;
  };
  /**
   * BOOK-219: `pipeline-estimated` when any call of the pass had its usage read off the text.
   * The ledger row is still priced (`priced = 1`) — the word says the numbers are an estimate.
   */
  provenance?: Provenance;
};

/**
 * What `land` sends — the writer's text, held in memory and never written to a file (BOOK-187),
 * and what a landing may say beyond the lease (BOOK-173 §2, §4).
 */
export type LandInput = {
  /** The text this landing publishes; absent means «re-land the rows». */
  text?: string;
  /** The first sheet's whole text, for a `front` step — the same rule as `text`. */
  frontRaw?: string;
  noWrite?: boolean;
  rev?: number;
  /**
   * The patch this landing applies, one entry per block: the character edit the ingest needs to
   * keep sentence ids across the write. Absent for a rewrite, a draft or a front sheet.
   */
  sentences?: ReadonlyArray<SentencePatchEdit>;
  /** The mode the pass ran and the estimate it was opened with — recorded with the plan. */
  mode?: 'patch' | 'rewrite';
  estimateUsd?: number;
};

/** What an escalation reports about the model calls it made before it parked (BOOK-117). */
export type EscalateSpend = {
  /** The model that ran; omitted when none did — the engine's own default is `null` (ADR-038 §2). */
  model?: string;
  tokensIn: number;
  tokensOut: number;
  /** BOOK-219: a park after a paid call is priced too, and says whether its numbers are estimated. */
  provenance?: Provenance;
};
