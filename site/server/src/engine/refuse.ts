/**
 * The refusal — one of the two ends a filing has (owner's invariant, 2026-10-29).
 *
 * «У нас не должно быть вариантов зайти в тупик — всегда должны прийти в два варианта: или
 * отклонён, или принят и написан.» A filing is written (`done`, its text in the chapter) or
 * refused (`void · dropped`, no text of it in the book) — nothing else is a resting place. So
 * every stop the engine owns is *this* function, and it does both halves in one transaction:
 *
 *   1. **the text**: a step that landed goes back to its pre-pass revision through the operator's
 *      own restore path (`restore.ts`, a new revision, never a file put back). A restore that
 *      cannot be made stops the refusal with `TEXT_STUCK` — nobody closes a filing over text
 *      that moved;
 *   2. **the decision**: the step closes `escalated` (the engine's word for «stopped by a rule»),
 *      the change closes `void · dropped` with the caller's public sentence, one alert is
 *      recorded, the lane and the lease are released, and the rows the site reads are written —
 *      `change_events('decided')` is what its bridge turns into a `comment:decision`, so the
 *      reader who filed hears «не принято» in words, not a code.
 *
 * Who calls it: the writer's own stop (`service.escalate`), the reaper's wall, the gate window
 * and the lost session, and the queue's own deadline and money stop. A cascade stop reaches the
 * same sink through `closeCascade`.
 */

import {
  NOTE_MAX_CHARS,
  REASON_MAX_CHARS,
  type CascadeOutcome,
  type ChangeStatus,
  type SeamRef,
} from '@book/shared';

import { changeForStep } from './helpers.ts';
import { closeStep } from './close.ts';
import { stopChange } from './changeClose.ts';
import { lastLeaseOfStep, openStepForClose, stampEscalatedRelease } from './leases.ts';
import type { Provenance } from './model.ts';
import * as store from './store.ts';
import { refuse, type EngineDeps, type PremiseCause } from './types.ts';

// ── the public sentences ─────────────────────────────────────────────────────
//
// A refusal is a sentence the reader may print: no code, no constant, no config name. The
// numbers come from the config (a minute count an operator can read), the rest is words.

/** The queue's own deadline: a filing that never reached a pass is not kept forever. */
export function queueDeadlineReason(hours: number): string {
  return `не дошло до прохода за ${String(hours)} ч — заявка отклонена`;
}

/** The step wall (BOOK-34): the pass outlived its window, so its text does not stand. */
export function stepWallReason(minutes: number): string {
  return `шаг не закрылся за отведённое время (${String(minutes)} мин) — текст возвращён к прежней редакции, заявка отклонена`;
}

/** The gate window: the reading gate never answered. */
export function gateWindowReason(minutes: number): string {
  return `проверка не ответила за ${String(minutes)} мин — текст возвращён к прежней редакции, заявка отклонена`;
}

/** The session that did not come back to its step, three attempts in a row. */
export function lostSessionReason(landed: boolean): string {
  return landed
    ? 'сессия не вернулась к шагу за три попытки — текст возвращён к прежней редакции, заявка отклонена'
    : 'сессия не вернулась к шагу за три попытки — заявка отклонена';
}

/** The book's money cap: writing stops for good, so a queued filing cannot wait for a day. */
export const BUDGET_STOP_REASON = 'потолок книги исчерпан — заявка отклонена';

/** `because` as the reader will see it: one line, bounded, never empty. */
export function publicSentence(raw: string): string {
  const text = raw.replace(/\s+/gu, ' ').trim();
  if (text.length === 0) refuse('INVALID_REASON', 422, 'a refusal carries one public sentence');
  return text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS - 1)}…` : text;
}

/**
 * The stop vocabulary of the writer's own words (§6A.6): the alert kind and the cascade's
 * outcome come from the sentence the writer sent, exactly as they did before the refusal became
 * one function.
 */
export function stopCauseOf(because: string): CascadeOutcome {
  const reason = because.toLowerCase();
  if (reason.includes('budget')) return 'escalated:budget';
  if (reason.includes('oscillation')) return 'escalated:oscillation';
  if (reason.includes('delta')) return 'escalated:delta';
  if (reason.includes('ending')) return 'escalated:ending';
  if (reason.includes('timeout')) return 'escalated:gate_timeout';
  return 'escalated:origin';
}

// ── the door ─────────────────────────────────────────────────────────────────

export type RefuseInput = ({ stepId: string } | { leaseId: string } | { changeId: string }) & {
  /** The public sentence the reader is told, and the one the operator's alert carries. */
  because: string;
  /** The step's own note, when the caller has a detail beyond the sentence (an operator's copy). */
  note?: string;
  now?: number;
  /** The stop's own vocabulary (alert kind, cascade outcome); `escalated:origin` by default. */
  cause?: CascadeOutcome;
  /** A broken pass is not a refusal of the work — a draft keeps the chapter it wrote (BOOK-7). */
  premiseCause?: PremiseCause;
  seamsOut?: SeamRef[];
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  provenance?: Provenance | null;
  /** BOOK-34: a close that arrived after its lease expired — the release then reads `expired-close`. */
  expiredLeaseId?: string | null;
};

export type RefusalResult = {
  stepId: string | null;
  cascadeId: string | null;
  changeId: string | null;
  /** `void` once the change is refused; the row's own status when it was already decided. */
  changeStatus: ChangeStatus | null;
  /** `false` for a second refusal of a queued change: a no-op, never a second decision. */
  applied: boolean;
};

/** The step this refusal acts on, with the lease its close attributes to (if any). */
function targetStep(deps: EngineDeps, input: RefuseInput): { step: store.StepRow; expiredLeaseId: string | null } {
  if ('leaseId' in input) {
    // The writer's own door: an expired lease of a still-open step is closeable (§BOOK-34).
    const { lease, step, expired } = openStepForClose(deps, input.leaseId);
    return { step, expiredLeaseId: expired ? lease.id : null };
  }
  if (!('stepId' in input)) refuse('STEP_NOT_FOUND', 404, 'a refusal names a step, a lease or a change');
  const step = store.getStep(deps.db, input.stepId);
  if (!step) refuse('STEP_NOT_FOUND', 404, `no step ${input.stepId}`);
  if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${input.stepId} is already closed`);
  return { step, expiredLeaseId: input.expiredLeaseId ?? null };
}

export function refuseChange(deps: EngineDeps, input: RefuseInput): RefusalResult {
  const at = input.now ?? deps.clock.now();
  const because = publicSentence(input.because);
  const cause = input.cause ?? 'escalated:origin';
  // One transaction: the restore, the step, the change, the alert and the events are one fact.
  // A restore that cannot be made (`TEXT_STUCK`) rolls the whole refusal back — the step stays
  // open and the text keeps its owner, exactly so an operator can see what is stuck.
  return deps.db.transaction((): RefusalResult => {
    if ('changeId' in input) return refuseQueued(deps, input.changeId, because, at, cause);
    const { step, expiredLeaseId } = targetStep(deps, input);
    const result = closeStep(
      deps,
      step.step_id,
      {
        outcome: 'escalated',
        seamsOut: input.seamsOut ?? [],
        note: input.note === undefined ? because : input.note.slice(0, NOTE_MAX_CHARS),
        model: input.model ?? null,
        tokensIn: input.tokensIn ?? 0,
        tokensOut: input.tokensOut ?? 0,
        ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
        escalation: cause,
        changeReason: because,
        ...(input.premiseCause === undefined ? {} : { premiseCause: input.premiseCause }),
        expiredLeaseId: expiredLeaseId ?? input.expiredLeaseId ?? null,
      },
      at,
    );
    // A lease the reaper had already released as `expired` now says how the step really ended:
    // the step says `escalated`, and the lock must not tell a different story (§BOOK-34).
    const lease = lastLeaseOfStep(deps.db, step.step_id);
    if (lease !== undefined && lease.released_at !== null) stampEscalatedRelease(deps.db, lease.id);
    const change = changeForStep(deps.db, step);
    return {
      stepId: step.step_id,
      cascadeId: result.cascadeId,
      changeId: change?.id ?? null,
      changeStatus: result.changeStatus,
      applied: true,
    };
  })();
}

/**
 * A change that never reached a pass: the queue's deadline and the book's money stop. There is
 * no step and no text — the refusal is the filing's own row, its one sentence and the same
 * `change_events('decided')` the site's bridge reads.
 */
function refuseQueued(
  deps: EngineDeps,
  changeId: string,
  because: string,
  at: number,
  cause: CascadeOutcome,
): RefusalResult {
  const change = store.getChange(deps.db, changeId);
  if (change === undefined) refuse('CHANGE_MISSING', 404, `no change ${changeId}`);
  const applied = stopChange(deps, change, because, at, cause, 'pending');
  const after = store.getChange(deps.db, changeId);
  return {
    stepId: null,
    cascadeId: change.cascade_id,
    changeId,
    changeStatus: (after?.status ?? change.status) as ChangeStatus,
    applied,
  };
}
