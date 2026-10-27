/**
 * Closing a step, advancing its ripple, closing the change (ARCHITECTURE.md §6A.4 steps 7–9,
 * §6B.4).
 *
 * One rule shapes this module: **a step is closed only by the engine**, and every close has
 * a cause that is already a row — the two verdicts, the seam report, the cascade plan. The
 * cascade is a projection of its steps (`advanceCascade`), and no timer moves a ripple, so
 * replaying the rows replays the cascade.
 */

import type {
  CascadeOutcome,
  CascadeStatus,
  ChangeOutcome,
  ChangeStatus,
  SeamRef,
  StepOutcome,
} from '@book/shared';
import { parseSeams } from '@book/shared';

import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { recordImpact } from '../history/impact.ts';
import { passSpendOf, recordPassSpend, spendOfClose } from '../budget.ts';
import { publishIndexNotices } from './indexNotice.ts';
import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { newCascadeId, newStepId } from '../util/ulid.ts';
import { alertKind, recordAlert } from './alerts.ts';
import { budgetFromConfig } from './budget.ts';
import {
  closeReason,
  planCascade,
  type CascadeFacts,
  type CascadeStepFact,
  type CloseCopyKey,
} from './cascade.ts';
import { leaseForClose, releaseForExpiredClose, releaseLease } from './leases.ts';
import { settleDraftPremise } from './premise.ts';
import * as store from './store.ts';
import { assertEndingFreeze } from './freeze.ts';
import { isWritten } from './text.ts';
import { refuse, type EngineDeps, type PremiseCause } from './types.ts';

// ── small readers ────────────────────────────────────────────────────────────

export function changeOutcomeOf(cascade: CascadeOutcome): ChangeOutcome {
  if (!cascade.startsWith('escalated:')) return 'applied';
  const reason = cascade.slice('escalated:'.length);
  if (
    reason === 'budget' || reason === 'oscillation' || reason === 'origin' || reason === 'delta' ||
    reason === 'finding' || reason === 'ending' || reason === 'science' || reason === 'rights' ||
    reason === 'gate_timeout'
  ) {
    return reason;
  }
  return 'origin';
}

const ESCALATION_COPY: Record<string, CloseCopyKey> = {
  budget: 'budget',
  oscillation: 'oscillation',
  origin: 'origin',
  delta: 'delta',
  ending: 'ending',
  finding: 'finding',
  // BOOK-76: a stop by the physics pass reads «не входит в книгу», not «правка опубликована».
  science: 'science',
  // BOOK-61: Gate B's stop reads «не принято» — never the prose gates' two outcomes.
  rights: 'rights',
  gate_timeout: 'gate',
};

/** The public reason for a stop, in the words the stop table uses (§6A.6). */
export function escalationCopy(outcome: CascadeOutcome): string {
  const suffix = outcome.startsWith('escalated:') ? outcome.slice('escalated:'.length) : 'origin';
  return closeReason(ESCALATION_COPY[suffix] ?? 'origin');
}

export function currentRev(db: Db, chapter: number): number {
  const row = db.prepare('SELECT rev FROM chapters WHERE n = ?').get(chapter) as { rev: number } | undefined;
  return row?.rev ?? 0;
}

export function stepFacts(row: store.StepRow): CascadeStepFact {
  return {
    seq: row.seq,
    pass: row.pass,
    chapter: row.chapter,
    lane: row.lane,
    wave: row.wave,
    outcome: row.outcome,
    seamsIn: parseSeams(safeJson(row.seams_in)),
    seamsOut: parseSeams(safeJson(row.seams_out)),
  };
}

function safeJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

// ── change close ─────────────────────────────────────────────────────────────

export function releaseLane(deps: EngineDeps, changeId: string): void {
  const lane = store.readLane(deps.db);
  if (lane.holder === changeId) store.releaseLaneRow(deps.db, changeId);
}

export function closeChange(
  deps: EngineDeps,
  change: store.ChangeRow,
  status: ChangeStatus,
  outcome: ChangeOutcome,
  reason: string | null,
  now: number,
): void {
  // Tokens and the model are frozen here, once (§6D.5); cost stays the placeholder zero and the
  // row is not priced, so BOOK-23 reads it as «not measured» (`measuredRub`), never as free.
  const steps = store.stepsOfChange(deps.db, change.id);
  const tokensIn = steps.reduce((sum, step) => sum + step.tokens_in, 0);
  const tokensOut = steps.reduce((sum, step) => sum + step.tokens_out, 0);
  const writerModel = steps.find((step) => step.pass === 'change' && step.model !== null)?.model ?? null;
  store.updateChange(deps.db, change.id, {
    status,
    outcome,
    reason,
    finished_at: toIso(now),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    model: writerModel,
  });
  appendChangeEvent(deps.db, change.id, status === 'escalated' ? 'escalated' : 'decided', { outcome, reason }, now);
  appendEvent(
    deps.db,
    {
      kind: 'change.decided',
      changeId: change.id,
      cascadeId: change.cascade_id,
      payload: { status, outcome, reason },
    },
    now,
  );
  // BOOK-18: one public statement when a document's status moved, then the artifact is
  // refreshed. Both live inside the index module's own guard and cannot fail this close.
  publishIndexNotices(deps, change, now);
  // §6F.5: the impact is materialized once, at close, and is a projection (§T-impact).
  recordImpact(deps.db, change.id, now);
  releaseLane(deps, change.id);
}

// ── cascade close ────────────────────────────────────────────────────────────

function cascadeDepth(cascadeId: string, origin: number, steps: store.StepRow[]): { down: number; up: number } {
  const down = steps.filter((step) => step.cascade_id === cascadeId && step.lane === 'backward');
  const up = steps.filter((step) => step.cascade_id === cascadeId && step.lane === 'forward');
  const lowest = down.reduce((min, step) => Math.min(min, step.chapter ?? origin), origin);
  const highest = up.reduce((max, step) => Math.max(max, step.chapter ?? origin), origin);
  return { down: origin - lowest, up: highest - origin };
}

/** Cancel steps of a cascade that is over: a closed ripple owns no work in flight. */
function cancelOpenSteps(deps: EngineDeps, cascadeId: string, now: number): void {
  for (const step of store.listCascadeSteps(deps.db, cascadeId)) {
    if (step.outcome !== null) continue;
    store.updateStep(deps.db, step.step_id, { outcome: 'interrupted', closed_at: toIso(now), note: 'cascade closed' });
    const lease = store.liveLeaseForStep(deps.db, step.step_id);
    if (lease) releaseLease(deps.db, lease.id, 'escalated', now);
    appendEvent(
      deps.db,
      { kind: 'step.closed', stepId: step.step_id, cascadeId, chapter: step.chapter, payload: { outcome: 'interrupted' } },
      now,
    );
  }
}

export function closeCascade(
  deps: EngineDeps,
  cascadeId: string,
  outcome: CascadeOutcome,
  reason: string,
  now: number,
): void {
  const db = deps.db;
  const cascade = store.getCascade(db, cascadeId);
  if (!cascade || cascade.status !== 'open') return;
  const change = store.getChange(db, cascade.change_id);
  const steps = store.listCascadeSteps(db, cascadeId);
  const tokens = steps.reduce((sum, step) => sum + step.tokens_in + step.tokens_out, 0);
  const depth = change ? cascadeDepth(cascadeId, change.chapter, steps) : { down: 0, up: 0 };
  const escalated = outcome.startsWith('escalated:');

  store.updateCascade(db, cascadeId, {
    status: (escalated ? 'escalated' : 'closed') satisfies CascadeStatus,
    outcome,
    // The recorded wave is the deepest step of the ripple; a front/ending proof carries the
    // wave it rests in, so this never exceeds the frozen `budget.maxWave` (BOOK-DOC-4 rule 3).
    wave: steps.reduce((max, step) => Math.max(max, step.wave), cascade.wave),
    depth_bwd: depth.down,
    depth_fwd: depth.up,
    step_count: steps.length,
    tokens,
    closed_at: toIso(now),
  });
  appendEvent(db, { kind: 'cascade.closed', changeId: cascade.change_id, cascadeId, payload: { outcome, reason } }, now);

  if (change) {
    const changeOutcome = escalated
      ? changeOutcomeOf(outcome)
      : ((change.outcome as ChangeOutcome | null) ?? 'applied');
    closeChange(
      deps,
      change,
      escalated ? 'escalated' : 'done',
      changeOutcome,
      escalated ? reason : null,
      now,
    );
    if (escalated) {
      recordAlert(deps, {
        kind: alertKind(outcome),
        at: toIso(now),
        changeId: change.id,
        cascadeId,
        stepId: null,
        detail: reason,
      });
    }
  }
  cancelOpenSteps(deps, cascadeId, now);
}

// ── cascade advance ──────────────────────────────────────────────────────────

export function advanceCascade(deps: EngineDeps, cascadeId: string, now: number): void {
  const db = deps.db;
  const cascade = store.getCascade(db, cascadeId);
  if (!cascade || cascade.status !== 'open') return;
  const change = store.getChange(db, cascade.change_id);
  if (!change) refuse('CHANGE_MISSING', 500, `cascade ${cascadeId} has no change`);

  const steps = store.listCascadeSteps(db, cascadeId);
  const facts: CascadeFacts = {
    origin: change.chapter,
    budget: JSON.parse(cascade.budget) as CascadeFacts['budget'],
    openedAtMs: Date.parse(cascade.opened_at),
    tokens: steps.reduce((sum, step) => sum + step.tokens_in + step.tokens_out, 0),
    steps: steps.map(stepFacts),
  };
  const written = new Set<number>();
  for (let n = 1; n <= 67; n += 1) if (isWritten(deps.bookRoot, n)) written.add(n);

  const plan = planCascade(facts, { nowMs: now, written });
  if (plan.kind === 'wait') return;
  if (plan.kind === 'close') {
    closeCascade(deps, cascadeId, plan.outcome, plan.reason, now);
    return;
  }

  let seq = steps.reduce((max, step) => Math.max(max, step.seq), 0);
  for (const planned of plan.steps) {
    seq += 1;
    const chapter = planned.chapter;
    const stepId = newStepId(now);
    store.insertStep(db, {
      stepId,
      cascadeId,
      seq,
      wave: planned.wave,
      lane: planned.lane,
      pass: planned.pass,
      chapter,
      boundary: String(planned.boundary),
      seamsIn: JSON.stringify(planned.seamsIn),
      revBefore: chapter === null ? null : currentRev(db, chapter),
      at: toIso(now),
    });
    appendEvent(
      db,
      {
        kind: 'step.opened',
        stepId,
        cascadeId,
        changeId: change.id,
        chapter,
        isFront: planned.pass === 'front',
        payload: { pass: planned.pass, wave: planned.wave, boundary: planned.boundary },
      },
      now,
    );
  }
  const depth = cascadeDepth(cascadeId, change.chapter, store.listCascadeSteps(db, cascadeId));
  store.updateCascade(db, cascadeId, {
    wave: Math.max(cascade.wave, ...plan.steps.map((step) => step.wave)),
    depth_bwd: depth.down,
    depth_fwd: depth.up,
    step_count: steps.length + plan.steps.length,
  });
}

/** Open the ripple for an origin step that reported seams (§6A.4 step 8). */
export function openCascade(deps: EngineDeps, step: store.StepRow, change: store.ChangeRow, now: number): string {
  const cascadeId = newCascadeId(now);
  store.insertCascade(deps.db, {
    id: cascadeId,
    changeId: change.id,
    budget: JSON.stringify(budgetFromConfig(deps.config)),
    openedAt: toIso(now),
  });
  store.updateStep(deps.db, step.step_id, { cascade_id: cascadeId, seq: 1 });
  store.updateChange(deps.db, change.id, { cascade_id: cascadeId });
  appendEvent(
    deps.db,
    {
      kind: 'cascade.opened',
      changeId: change.id,
      cascadeId,
      stepId: step.step_id,
      chapter: change.chapter,
      payload: { origin: change.chapter },
    },
    now,
  );
  return cascadeId;
}

// ── step close ───────────────────────────────────────────────────────────────

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

export function closeStep(
  deps: EngineDeps,
  stepId: string,
  input: CloseStepInput,
  now: number,
): CloseStepResult {
  const db = deps.db;
  const step = store.getStep(db, stepId);
  if (!step) refuse('STEP_NOT_FOUND', 404, `no step ${stepId}`);
  if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${stepId} is already closed`);
  // F025: a step is never closed on top of a cascade rewrite of the ending (§6C.4).
  assertEndingFreeze(db);

  // BOOK-34: a close after expiry may name a lease the reaper already released as `expired`;
  // attribution is then that lease — a *different* live lease means the step was taken over
  // since the session last looked, and the close is refused (`LEASE_HELD`), not mis-booked.
  const { lease, live } = leaseForClose(db, step.step_id, input.expiredLeaseId);
  const gateRows = store.listVerdicts(db, step.step_id);
  // The close reports what it believes; the database says what the pass spent (owner, 2026-10-28).
  const spend = spendOfClose(db, step.step_id, { model: input.model, tokensIn: input.tokensIn, tokensOut: input.tokensOut });
  const ms = Math.max(0, now - Date.parse(step.at));

  const close = db.transaction((): CloseStepResult => {
    store.updateStep(db, step.step_id, {
      outcome: input.outcome,
      seams_out: JSON.stringify(input.seamsOut),
      note: input.note,
      model: spend.model,
      tokens_in: spend.tokensIn,
      tokens_out: spend.tokensOut,
      closed_at: toIso(now),
      ms,
      lease_id: lease?.id ?? step.lease_id,
      session: lease?.session ?? step.session,
    });
    if (input.expiredLeaseId) {
      releaseForExpiredClose(db, live, input.expiredLeaseId, now);
    } else if (live) {
      releaseLease(db, live.id, input.outcome === 'escalated' ? 'escalated' : input.outcome === 'holds' ? 'holds' : 'done', now);
    }
    store.deleteDispatches(db, step.step_id);
    // BOOK-7: a draft's first pass settles its chapter's premise from the text that now exists —
    // applied when the chapter is written, rejected when the writer refused it with one reason,
    // and left queued when the pass was interrupted or broke (a broken call is not a refusal).
    settleDraftPremise(deps, step, input.outcome, input.escalation ?? null, input.note, now, input.premiseCause);
    const span = db.prepare('SELECT MIN(hseq) AS fromHseq FROM events WHERE step_id = ?').get(step.step_id) as {
      fromHseq: number | null;
    };
    const cascadeRow = step.cascade_id ? store.getCascade(db, step.cascade_id) : undefined;
    const hseq = appendEvent(
      db,
      {
        kind: 'step.closed',
        stepId: step.step_id,
        cascadeId: step.cascade_id,
        changeId: cascadeRow?.change_id ?? lease?.change_id ?? null,
        chapter: step.chapter,
        isFront: step.pass === 'front',
        payload: {
          pass: step.pass,
          outcome: input.outcome,
          gates: gateRows.map((row) => ({ role: row.role, verdict: row.verdict })),
          ...(input.expiredLeaseId ? { expiredClose: true } : {}),
        },
      },
      now,
    );
    store.updateStep(db, step.step_id, { hseq_from: span.fromHseq, hseq_to: hseq });
    // BOOK-117: the pass's one ledger row, in this transaction — the money lives in `budget.ts`.
    recordPassSpend(db, passSpendOf(step, spend, cascadeRow?.change_id ?? lease?.change_id ?? null, now));

    if (input.outcome === 'escalated') {
      const cascade = step.cascade_id ? store.getCascade(db, step.cascade_id) : undefined;
      const change = cascade ? store.getChange(db, cascade.change_id) : findOriginChange(db, step);
      const outcome = input.escalation ?? 'escalated:origin';
      const reason = input.changeReason ?? escalationCopy(outcome);
      if (cascade) {
        closeCascade(deps, cascade.id, outcome, reason, now);
      } else if (change) {
        closeChange(deps, change, 'escalated', changeOutcomeOf(outcome), reason, now);
        recordAlert(deps, {
          kind: alertKind(outcome),
          at: toIso(now),
          changeId: change.id,
          cascadeId: null,
          stepId: step.step_id,
          detail: reason,
        });
      }
      return { cascadeId: cascade?.id ?? null, outcome: input.outcome, changeStatus: 'escalated' };
    }

    if (step.pass === 'change') {
      const change = findOriginChange(db, step);
      if (!change) refuse('CHANGE_MISSING', 500, `step ${step.step_id} has no change`);
      if (input.seamsOut.length === 0) {
        const status = input.changeStatus ?? 'done';
        const outcome = input.changeOutcome ?? 'applied';
        closeChange(deps, change, status, outcome, input.changeReason ?? null, now);
        return { cascadeId: null, outcome: input.outcome, changeStatus: status };
      }
      const cascadeId = openCascade(deps, step, change, now);
      advanceCascade(deps, cascadeId, now);
      return { cascadeId, outcome: input.outcome, changeStatus: null };
    }

    if (step.cascade_id) {
      advanceCascade(deps, step.cascade_id, now);
      const cascade = store.getCascade(db, step.cascade_id);
      const change = cascade ? store.getChange(db, cascade.change_id) : null;
      return {
        cascadeId: step.cascade_id,
        outcome: input.outcome,
        changeStatus: change && change.status !== 'processing' ? change.status : null,
      };
    }

    return { cascadeId: null, outcome: input.outcome, changeStatus: null };
  });

  return close();
}

/**
 * Before a cascade exists, the origin step's link to its change is the lease: `acquireLease`
 * records `leases.change_id`, and the origin step always has one. The fallback covers a step
 * whose lease row was lost, where the lane's single `processing` change is the only possible
 * origin.
 */
function findOriginChange(db: Db, step: store.StepRow): store.ChangeRow | null {
  const lease = db
    .prepare('SELECT change_id FROM leases WHERE step_id = ? ORDER BY acquired_at DESC LIMIT 1')
    .get(step.step_id) as { change_id: string | null } | undefined;
  if (lease?.change_id) {
    const change = store.getChange(db, lease.change_id);
    if (change) return change;
  }
  const processing = db.prepare(`SELECT * FROM changes WHERE status = 'processing' ORDER BY seq LIMIT 1`).get() as
    store.ChangeRow | undefined;
  return processing ?? null;
}
