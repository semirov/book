/**
 * Closing a step, advancing its ripple, closing the change (ARCHITECTURE.md §6A.4 steps 7–9,
 * §6B.4).
 *
 * One rule shapes this module: **a step is closed only by the engine**, and every close has
 * a cause that is already a row — the two verdicts, the seam report, the cascade plan. The
 * cascade is a projection of its steps (`advanceCascade`), and no timer moves a ripple, so
 * replaying the rows replays the cascade.
 */

import { type CascadeOutcome, type CascadeStatus, type ChangeOutcome } from '@book/shared';

import { appendEvent } from '../history/log.ts';
import { passUsdOf, recordCloseSpend, spendOfClose } from '../budget.ts';
import { sendPassEvent } from '../push/passEvent.ts';
import { budgetFromConfig } from './budget.ts';
import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { newCascadeId, newStepId } from '../util/ulid.ts';
import { planCascade, type CascadeFacts } from './cascade.ts';
import { closeChange, stopChange } from './changeClose.ts';
import { changeForStep } from './helpers.ts';
import { leaseForClose, releaseForExpiredClose, releaseLease } from './leases.ts';
import { stepProvenance } from './model.ts';
import { publishCandidate } from './landing.ts';
import { settleDraftPremise } from './premise.ts';
import { pricePlanAfterPass } from '../ledger/graph/plan.ts';
import { closeVerification } from '../ledger/graph/verification.ts';
import { restoreCascadePrePass, restorePrePass } from './restore.ts';
import * as store from './store.ts';
import { assertEndingFreeze } from './freeze.ts';
import { writtenChaptersOf } from './text.ts';
import { refuse, type EngineDeps } from './types.ts';

/** The ripple's own door: `service.ts` has one import for both ways a step opens. */
export { openRippleStep } from './ripple.ts';

// ── small readers ────────────────────────────────────────────────────────────

import { currentRev, escalationCopy, stepFacts } from './closeRead.ts';

export { changeOutcomeOf, currentRev, escalationCopy, stepFacts } from './closeRead.ts';

// ── change close ─────────────────────────────────────────────────────────────
//
// `closeChange`, `stopChange` and `releaseLane` live in `changeClose.ts`: both this module and
// the refusal (`refuse.ts`) write them, and neither of the two may own the other.

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
    store.updateStep(deps.db, step.step_id, {
      outcome: 'interrupted',
      closed_at: toIso(now),
      note: 'cascade closed',
      // BOOK-222: an interrupted step publishes nothing it held — the candidate dies with it.
      candidate_text: null,
      candidate_sha: null,
      candidate_sentences: null,
    });
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
  /** `false` only for a refusal whose every way back is spent (`reap.ts`, `TEXT_STUCK`). */
  restoreText = true,
): void {
  // One transaction: a refusal's restore of several chapters and the decision that follows it
  // are one fact, and a restore that cannot be made (`TEXT_STUCK`) leaves nothing half-closed.
  deps.db.transaction(() => {
    closeCascadeIn(deps, cascadeId, outcome, reason, now, restoreText);
  })();
}

function closeCascadeIn(
  deps: EngineDeps,
  cascadeId: string,
  outcome: CascadeOutcome,
  reason: string,
  now: number,
  restoreText: boolean,
): void {
  const db = deps.db;
  const cascade = store.getCascade(db, cascadeId);
  if (!cascade || cascade.status !== 'open') return;
  const change = store.getChange(db, cascade.change_id);
  const steps = store.listCascadeSteps(db, cascadeId);
  const tokens = steps.reduce((sum, step) => sum + step.tokens_in + step.tokens_out, 0);
  const depth = change ? cascadeDepth(cascadeId, change.chapter, steps) : { down: 0, up: 0 };
  const escalated = outcome.startsWith('escalated:');

  // A refused ripple means **none** of its text stands, not only the last step's: every chapter
  // it wrote goes back to its own pre-pass revision before the filing is decided. A restore that
  // cannot be made throws `TEXT_STUCK` and the whole close rolls back — the refusal is never a
  // decision over text that moved.
  if (escalated && restoreText) restoreCascadePrePass(deps, cascadeId, now);

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
    // BOOK-206 B2: a stopped ripple is a **refusal**, not a change left `escalated` for an
    // operator to find: the text is back, the filing is `void · dropped`, and the reason names
    // the stop in words (`cascade.ts`'s table, never a code). The cascade keeps its own status —
    // «escalated» there is the ripple's word for how it ended, not the filing's.
    if (escalated) stopChange(deps, change, reason, now, outcome);
    else closeChange(deps, change, 'done', (change.outcome ?? 'applied') as ChangeOutcome, null, now);
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
  const written = writtenChaptersOf(db);

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

export type { CloseStepInput, CloseStepResult } from './closeTypes.ts';
import type { CloseStepInput, CloseStepResult } from './closeTypes.ts';

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
  const spend = spendOfClose(db, step.step_id, { model: input.model, tokensIn: input.tokensIn, tokensOut: input.tokensOut, provenance: input.provenance ?? 'pipeline' });
  const ms = Math.max(0, now - Date.parse(step.at));

  const close = db.transaction((): CloseStepResult => {
    // BOOK-222: the candidate becomes the chapter here — the one publication, in this transaction,
    // so a close that cannot be made leaves nothing served. A refusal publishes nothing: its text
    // is dropped with the step (`restorePrePass` puts back only text that was served).
    if (input.outcome !== 'escalated') publishCandidate(deps, step, now);
    const published = store.getStep(db, step.step_id) ?? step;
    store.updateStep(db, step.step_id, {
      outcome: input.outcome,
      seams_out: JSON.stringify(input.seamsOut),
      note: input.note,
      model: spend.model,
      tokens_in: spend.tokensIn,
      tokens_out: spend.tokensOut,
      provenance: stepProvenance(input.provenance ?? 'pipeline'),
      closed_at: toIso(now),
      ms,
      lease_id: lease?.id ?? step.lease_id,
      session: lease?.session ?? step.session,
      // BOOK-222: a close that did not publish the candidate drops it. `done` clears it before it
      // calls this (the publication happened); every other close — a refusal, a wall, a session
      // that never came back — serves nothing, and the reader keeps the text he already has.
      candidate_text: null,
      candidate_sha: null,
      candidate_sentences: null,
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
    const closedChangeId = cascadeRow?.change_id ?? lease?.change_id ?? null;
    const verificationRefused = closeVerification(db, closedChangeId, step.chapter, step.step_id, input.verification, toIso(now));
    const hseq = appendEvent(
      db,
      {
        kind: 'step.closed',
        stepId: step.step_id,
        cascadeId: step.cascade_id,
        changeId: closedChangeId,
        chapter: step.chapter,
        isFront: step.pass === 'front',
        payload: {
          pass: step.pass,
          outcome: input.outcome,
          gates: gateRows.map((row) => ({ role: row.role, verdict: row.verdict })),
          // BOOK-173 §4: how the pass wrote — the word a draft step has no plan to carry.
          ...(input.mode == null ? {} : { mode: input.mode }),
          ...(input.expiredLeaseId ? { expiredClose: true } : {}),
          ...(verificationRefused === null ? {} : { verificationRefused }),
        },
      },
      now,
    );
    store.updateStep(db, step.step_id, { hseq_from: span.fromHseq, hseq_to: hseq });
    // BOOK-117: the pass's one ledger row, in this transaction — the money lives in `budget.ts`.
    recordCloseSpend(db, { step, changeId: closedChangeId, now, model: spend.model, tokensIn: spend.tokensIn, tokensOut: spend.tokensOut, provenance: spend.provenance });
    // BOOK-173 §4: the plan froze an estimate; this same transaction replaces it with the actual.
    const actualUsd = closedChangeId === null ? null : passUsdOf(db, step.step_id);
    if (closedChangeId !== null && actualUsd !== null) pricePlanAfterPass(db, closedChangeId, actualUsd);

    // BOOK-189/BOOK-219: the landing is announced here, at the close, never at `land` — there the
    // text may still be taken back (a rights refusal, a gate that never answered). A step that
    // closes by restore (`escalated`) says nothing about a landing; a draft (no change on its
    // lease) and a step with no change at all notify nobody, and a cascade step for a neighbour's
    // chapter is filtered by `recipientOf` — the reader asked about theirs.
    if (input.outcome !== 'escalated' && published.chapter !== null && published.landed_at !== null) {
      const landedChange = changeForStep(db, published);
      if (landedChange !== undefined) {
        sendPassEvent(db, { kind: 'landed', chapter: published.chapter, changeId: landedChange.id }, now);
      }
    }

    if (input.outcome === 'escalated') {
      // The refusal sink (§BOOK-206 B2, owner's invariant 2026-10-29): a step stopped by a rule
      // does not leave its change in limbo. Its text goes back to the pre-pass revision, and the
      // change closes `void · dropped` with the caller's public sentence — one of the two ends a
      // filing has. `escalated` stays the *step's* word; it is not a change status any more.
      const cascade = step.cascade_id ? store.getCascade(db, step.cascade_id) : undefined;
      const change = cascade ? store.getChange(db, cascade.change_id) : findOriginChange(db, step);
      const outcome = input.escalation ?? 'escalated:origin';
      const reason = input.changeReason ?? escalationCopy(outcome);
      if (cascade) {
        // A whole ripple: `closeCascade` puts every chapter it wrote back before deciding — unless
        // every way back is spent, and the refusal is made with the text where it stands.
        closeCascade(deps, cascade.id, outcome, reason, now, input.restoreText !== false);
      } else {
        // A broken pass is not a refusal of the work (BOOK-7): a draft that wrote its chapter
        // keeps that first edition, and its premise is settled by the text, not by the stop.
        if (input.restoreText !== false && !(step.pass === 'draft' && input.premiseCause === 'failed')) {
          restorePrePass(deps, step, now);
        }
        if (change) {
          stopChange(deps, change, reason, now, outcome);
          return { cascadeId: null, outcome: input.outcome, changeStatus: 'void' };
        }
      }
      return { cascadeId: cascade?.id ?? null, outcome: input.outcome, changeStatus: cascade ? 'void' : null };
    }

    if (step.pass === 'change') {
      const change = findOriginChange(db, step);
      if (!change) refuse('CHANGE_MISSING', 500, `step ${step.step_id} has no change`);
      if (input.seamsOut.length === 0) {
        const status = input.changeStatus ?? 'done';
        // §6A.7: `adapt` is the writer's answer recorded at `start`, and a close that names no
        // outcome of its own must keep it — everything else (a reopened step's old escalation
        // cause included) is replaced by the default, as it always was.
        const outcome = input.changeOutcome ?? (change.outcome === 'adapted' ? 'adapted' : 'applied');
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
