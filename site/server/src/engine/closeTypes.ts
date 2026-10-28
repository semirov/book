/**
 * The two shapes a close takes and answers (ARCHITECTURE.md §6A.4 steps 7–9). They live apart
 * from `close.ts` so that module stays the rule and not its type catalogue; `close.ts`
 * re-exports them, so a caller imports from one place.
 */

import type { CascadeOutcome, ChangeOutcome, ChangeStatus, SeamRef, StepOutcome } from '@book/shared';

import type { PremiseCause } from './types.ts';

export type CloseStepInput = {
  outcome: StepOutcome;
  seamsOut: SeamRef[];
  note: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  /** The change's outcome, decided from relevance before the write (void/dropped or applied). */
  changeOutcome?: ChangeOutcome | null;
  /** Overrides for a step that closes a change without editing it (void/dropped). */
  changeStatus?: ChangeStatus;
  changeReason?: string | null;
  /** Why the step is escalated; also the cascade outcome when it belongs to one. */
  escalation?: CascadeOutcome | null;
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
