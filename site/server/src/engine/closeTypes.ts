/**
 * The two shapes a close takes and answers (ARCHITECTURE.md §6A.4 steps 7–9). They live apart
 * from `close.ts` so that module stays the rule and not its type catalogue; `close.ts`
 * re-exports them, so a caller imports from one place.
 */

import type { CascadeOutcome, ChangeOutcome, ChangeStatus, SeamRef, StepOutcome, WriteMode } from '@book/shared';

import type { VerificationRecord } from '../ledger/graph/verification.ts';
import type { Provenance } from './model.ts';
import type { PremiseCause } from './types.ts';

/** What `done` states about a close — the model triple, the seams, and how the pass wrote. */
export type DoneOptions = {
  seams: unknown;
  note?: string;
  /** ADR-038: required in the type, so `tsc` lists every caller of a close. */
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  now?: number;
  /** BOOK-117: `pipeline` (the lane, ADR-038 applies) or `operator` (a repair, its own model). */
  provenance?: Provenance;
  /**
   * BOOK-173 §4/§5 — how the pass wrote. `rewrite` on a text **byte-identical to the pre-image**
   * is the silent `no-op` (BOOK-DOC-65 §4); a step with no plan (a draft) keeps this word on its
   * close, because `change_plans.mode` only exists where a plan does.
   */
  mode?: WriteMode;
  /**
   * BOOK-173, BOOK-DOC-80: which gates judged this pass. `local only` is a close the full pair
   * never read — the local judge's `HOLDS` is the verdict the two prose gates would otherwise
   * have written, and the close is the one place that can say so atomically. Absent for every
   * caller that ran both gates (the operator, a re-run of an old step), and then nothing changes.
   */
  verification?: VerificationRecord;
};

/** BOOK-62: `seen` closes a prose step through the same path, so it takes the same options. */
export type SeenOptions = Omit<DoneOptions, 'seams' | 'note'>;

/** ADR-038 §2: a stop reports the same triple; BOOK-117 adds `cause` (broken ≠ refused). */
export type EscalateOptions = {
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  now?: number;
  cause?: PremiseCause;
};

export type CloseStepInput = {
  outcome: StepOutcome;
  seamsOut: SeamRef[];
  note: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Who ran the pass (`pipeline` | `operator`): the history answers «machine or repair». */
  provenance?: 'pipeline' | 'operator' | null;
  /** The change's outcome, decided from relevance before the write (void/dropped or applied). */
  changeOutcome?: ChangeOutcome | null;
  /** Overrides for a step that closes a change without editing it (void/dropped). */
  changeStatus?: ChangeStatus;
  changeReason?: string | null;
  /** Why the step is escalated; also the cascade outcome when it belongs to one. */
  escalation?: CascadeOutcome | null;
  /** BOOK-173 §4: how the pass wrote, recorded on the close for a step that has no plan (a draft). */
  mode?: WriteMode | null;
  /**
   * BOOK-DOC-80: which gates judged the pass — written to `change_plans` in this transaction,
   * keyed by `(change_id, chapter)`: a ripple chapter's close writes nothing and carries the
   * refusal code on `step.closed` (`verificationRefused`).
   */
  verification?: VerificationRecord;
  /** A broken pass is not a refusal; `failed` settles a written premise and queues an unwritten one. */
  premiseCause?: PremiseCause;
  /**
   * BOOK-34: the id of a lease that had already expired when this close arrived — the release
   * then reads `expired-close` and `step.closed` says so.
   */
  expiredLeaseId?: string | null;
};

export type CloseStepResult = {
  cascadeId: string | null;
  outcome: StepOutcome;
  changeStatus: ChangeStatus | null;
};
