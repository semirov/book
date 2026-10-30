/**
 * The zombie sweep (BOOK-235) — the rows the engine's own rules stopped moving.
 *
 * The owner's hole: a filing was made, triage wrote `OFF`, the site created a change — and the
 * writer answered «idle» for ever. Behind it: legacy changes resting in `changes.status =
 * 'escalated'` (`escalated` is not a change status this engine produces any more — `changeClose.ts`),
 * an open step nobody can be handed, an open cascade under a change that will never be
 * `processing` again. Nothing re-entered them and nothing ended them, so every guard in
 * `queue.ts` read one of these rows as «a pass is in flight» and the head of the FIFO queue
 * could never be claimed.
 *
 * This module is the one pass that ends them, at boot and on demand (`sweep.ts`), and — narrowed
 * to one change — from the claim path itself (`queue.ts`). It **repairs the queue's state and
 * nothing else**: no prose is touched, no candidate is published, no step is re-opened. A step it
 * closes is closed raw, the way `closeUnclaimedDesperate` does it (`reap.ts`): one row and one
 * `step.closed` event, no `closeStep`, so no restore, no cascade close and no reader hears about
 * work nobody did. A change it ends ends through `stopChange`, which is the only door a filing
 * has to `void · dropped`.
 *
 * Every action is one row in the report and one line, and nothing else. A row the sweep does not
 * change writes nothing at all — a poll every 15 minutes must never grow the ledger — and a
 * failure is a `failures` entry, never a stopped boot.
 */

import { QUEUE_MAX_ATTEMPTS, TOTAL_CHAPTERS, droppedLine, queueAttemptsLine } from '@book/shared';

import { filingChanges } from '../comments/filingState.ts';
import { appendChangeEvent, appendEvent } from '../history/log.ts';
import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { stopChange } from './changeClose.ts';
import { changeForStep } from './helpers.ts';
import { reconcilePremises } from './premise.ts';
import * as store from './store.ts';
import { isBasisSlot, readChapterRows } from './text.ts';
import { isEngineError, type EngineDeps } from './types.ts';

/**
 * How long an open step may stand without a lease before the sweep may close it. A claim is
 * `claimLaneRow` + `acquireLease` in one call, so a real hand-out leaves a live lease behind;
 * a minute of silence is a crash, not a session that is thinking.
 */
export const ZOMBIE_GRACE_MS = 60_000;

/** Change states that can never claim a step again: the row is over, whatever its step says. */
const DECIDED: ReadonlySet<string> = new Set(['escalated', 'void', 'failed', 'done']);

export type ZombieRow = {
  kind: 'step' | 'cascade' | 'change';
  /** The step, cascade or change id — a row key, never a reader's word. */
  id: string;
  changeId: string | null;
  /** Machine code: `open-step-blocks-head`, `cascade-orphan`, `processing-ghost`, … */
  condition: string;
  /** What it was, in the engine's own shorthand (`escalated · origin`, `open cascade`). */
  was: string;
  /** What it became (`pending (retry 2 of 6)`, `void · dropped`, `interrupted`). */
  became: string;
};

export type ZombieSweepReport = {
  at: string;
  rows: ZombieRow[];
  lines: string[];
  failures: Array<{ id: string; code: string }>;
};

/** One line per acted row: ids and codes only — never a sentence and never chapter text. */
export function zombieLine(row: ZombieRow): string {
  return `zombie sweep: ${row.kind} ${row.id} (${row.was}) -> ${row.became} · ${row.condition}`;
}

/** A row the sweep could not change: a fact of the report, and the same line in the log. */
export function zombieFailureLine(id: string, code: string): string {
  return `zombie sweep: failed ${id} (${code})`;
}

/** Which public reason closed a settled premise: the slot's shape decided it (`premise.ts`). */
export function premiseSettledCondition(db: Db, changeId: string): string {
  const change = store.getChange(db, changeId);
  if (change === undefined) return 'premise-stale';
  return isBasisSlot(readChapterRows(db, change.chapter)) ? 'premise-basis-only' : 'premise-stale';
}

function hasOpenStep(db: Db, changeId: string): boolean {
  return store.stepsOfChange(db, changeId).some((step) => step.outcome === null);
}

function hasLiveLease(db: Db, changeId: string): boolean {
  return store
    .stepsOfChange(db, changeId)
    .some((step) => store.liveLeaseForStep(db, step.step_id) !== undefined);
}

/**
 * A `processing` change nobody is working: not the lane's holder, no live lease on any of its
 * steps and no step left open. It is what a killed process leaves when its claim never became a
 * step, and what the queue reads as «a pass is in flight» for ever.
 */
export function isProcessingGhost(db: Db, change: store.ChangeRow): boolean {
  if (change.status !== 'processing') return false;
  if (store.readLane(db).holder === change.id) return false;
  if (hasLiveLease(db, change.id)) return false;
  return !hasOpenStep(db, change.id);
}

/**
 * The step's own close, raw (`reap.ts` `closeUnclaimedDesperate`): one row and one event. No
 * `closeStep` — this step never produced a candidate, so there is nothing to publish, nothing to
 * put back and no cascade that its close should settle.
 */
function closeRawStep(deps: EngineDeps, step: store.StepRow, now: number): void {
  store.updateStep(deps.db, step.step_id, {
    outcome: 'interrupted',
    closed_at: toIso(now),
    note: 'шаг остался без исполнителя — снят уборкой',
  });
  appendEvent(
    deps.db,
    {
      kind: 'step.closed',
      stepId: step.step_id,
      cascadeId: step.cascade_id,
      chapter: step.chapter,
      payload: { outcome: 'interrupted', sweep: true },
    },
    now,
  );
}

/**
 * Why this open step can never be handed out again — or `null` when the ordinary claim will
 * re-issue it, in which case the sweep must not touch it.
 */
function stepCondition(db: Db, step: store.StepRow, change: store.ChangeRow | undefined): string | null {
  // `claimOpenStep` filters this shape out (the ending is never rewritten by a ripple), so a step
  // like this can be open for ever without ever being offered — and it must be closed now, not
  // parked until its change happens to become the head.
  if (step.pass === 'cascade' && step.chapter === TOTAL_CHAPTERS) return 'open-step-unclaimable';
  // A decided or stopped change will never ask for its step again: the guard in `claimHead`
  // reads «an open step of the head», so this row is a block, not work.
  if (change !== undefined && DECIDED.has(change.status)) return 'open-step-of-decided-change';
  // The head's own open step is the one that made that guard permanent.
  if (change !== undefined && store.headPending(db)?.id === change.id) return 'open-step-blocks-head';
  return null;
}

/** What an open step without a lease reads as in the row's own line: how long it has stood. */
function stepWasLine(minutes: number): string {
  return `open step, no lease ${String(minutes)} min`;
}

export function sweepZombies(
  deps: EngineDeps,
  options: { now?: number; only?: { changeId: string } | null } = {},
): ZombieSweepReport {
  const { db } = deps;
  const now = options.now ?? deps.clock.now();
  const only = options.only ?? null;
  const at = toIso(now);
  const report: ZombieSweepReport = { at, rows: [], lines: [], failures: [] };

  const record = (row: ZombieRow): void => {
    report.rows.push(row);
    report.lines.push(zombieLine(row));
  };

  /** Each row stands alone: one wedged row is a failure, never a stopped sweep and never a boot. */
  const guard = (id: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      report.failures.push({ id, code: isEngineError(error) ? error.code : 'UNKNOWN' });
    }
  };

  // ── 0. premises that can never be drafted ─────────────────────────────────
  // BOOK-7: a premise waits for its chapter's first pass, and two shapes will never have one — a
  // chapter somebody has already written, and the frozen frame («у главы уже есть замысел» is a
  // different fact, so the slot's own reason is what a reader reads). `reconcilePremises` is the
  // engine's own rule for ending them, and both it and the rows it reports are **global**: `only`
  // does not narrow this pass, because a filing is never closed without a line — a premise settled
  // inside somebody else's heal still answers to its reader here.
  let premisesSettled: string[] = [];
  guard('premise', () => {
    premisesSettled = reconcilePremises(deps, now);
  });
  for (const id of premisesSettled) {
    record({
      kind: 'change',
      id,
      changeId: id,
      condition: premiseSettledCondition(db, id),
      was: 'pending premise',
      became: 'void · dropped',
    });
  }

  // ── A. open steps nobody can be handed ────────────────────────────────────
  // The lane's holder is never touched: a genuinely held lane is work in flight, whatever its
  // rows look like. A step with a live lease is a running pass for the same reason.
  for (const step of store.listOpenSteps(db)) {
    const change = changeForStep(db, step);
    const changeId = change?.id ?? null;
    if (only !== null && changeId !== only.changeId) continue;
    if (store.liveLeaseForStep(db, step.step_id) !== undefined) continue;
    if (changeId !== null && store.readLane(db).holder === changeId) continue;
    const opened = Date.parse(step.reopened_at ?? step.at);
    // An unparsable opening is not evidence of age: leave the row to the wall and the operator.
    if (!Number.isFinite(opened) || now - opened < ZOMBIE_GRACE_MS) continue;
    const condition = stepCondition(db, step, change);
    if (condition === null) continue;
    guard(step.step_id, () => {
      closeRawStep(deps, step, now);
      record({
        kind: 'step',
        id: step.step_id,
        changeId,
        condition,
        was: stepWasLine(Math.max(1, Math.round((now - opened) / 60_000))),
        became: 'interrupted',
      });
    });
  }

  // ── B. cascades nobody will close ─────────────────────────────────────────
  // An open cascade blocks every claim in the queue (`claimHead` refuses while one exists), so a
  // ripple left open by a dead process must be aborted — never `closeCascade`, which restores
  // text nobody asked to restore. The event is `cascade.closed`, the honest kind that already
  // means «this ripple is over»: `engineState/bridge.ts` reads it as the `absorbed` phase, which
  // is what an aborted ripple is for the reader's theatre (nothing landed, nothing is owed). A
  // new `cascade.aborted` kind would need a schema migration and a second phase for a distinction
  // no surface prints, so the existing word carries the fact.
  for (const cascade of store.listOpenCascades(db)) {
    if (only !== null && cascade.change_id !== only.changeId) continue;
    const change = store.getChange(db, cascade.change_id);
    const alive = change !== undefined && change.status === 'processing' && !isProcessingGhost(db, change);
    if (alive) continue;
    const steps = store.listCascadeSteps(db, cascade.id);
    // A live lease is a pass in flight; an open step is the ripple's own work, and
    // `claimOpenStep` hands it out. Neither is an orphan to abort from under.
    if (steps.some((step) => step.outcome === null)) continue;
    if (steps.some((step) => store.liveLeaseForStep(db, step.step_id) !== undefined)) continue;
    guard(cascade.id, () => {
      store.updateCascade(db, cascade.id, { status: 'aborted', closed_at: at });
      appendEvent(
        db,
        { kind: 'cascade.closed', cascadeId: cascade.id, changeId: cascade.change_id, payload: { reason: 'sweep' } },
        now,
      );
      record({
        kind: 'cascade',
        id: cascade.id,
        changeId: cascade.change_id,
        condition: 'cascade-orphan',
        was: 'open cascade',
        became: 'aborted',
      });
    });
  }

  // ── C. `processing` ghosts ────────────────────────────────────────────────
  // A claim that produced no step is an attempt like any other (`claimAttempts.ts`): it is
  // counted, and the sixth goes to the sink instead of back to the queue.
  for (const change of store.listWithStatus(db, 'processing')) {
    if (only !== null && change.id !== only.changeId) continue;
    if (!isProcessingGhost(db, change)) continue;
    const attempts = change.attempts + 1;
    guard(change.id, () => {
      if (attempts >= QUEUE_MAX_ATTEMPTS) {
        if (!stopChange(deps, change, queueAttemptsLine(QUEUE_MAX_ATTEMPTS), now, 'escalated:origin', 'processing')) return;
        record({
          kind: 'change',
          id: change.id,
          changeId: change.id,
          condition: 'escalated-exhausted',
          was: `processing · attempts ${String(change.attempts)}`,
          became: 'void · dropped',
        });
        return;
      }
      store.updateChange(db, change.id, {
        status: 'pending',
        outcome: null,
        reason: null,
        started_at: null,
        finished_at: null,
        cascade_id: null,
        attempts,
      });
      appendChangeEvent(db, change.id, 'released', { sweep: true, attempts }, now);
      appendEvent(
        db,
        { kind: 'change.queued', changeId: change.id, chapter: change.chapter, payload: { released: true, sweep: true } },
        now,
      );
      record({
        kind: 'change',
        id: change.id,
        changeId: change.id,
        condition: 'processing-ghost',
        was: `processing · attempts ${String(change.attempts)}`,
        became: `pending (retry ${String(attempts)} of ${String(QUEUE_MAX_ATTEMPTS)})`,
      });
    });
  }

  // ── D. `escalated` changes ────────────────────────────────────────────────
  // A legacy resting place: the engine stops a filing through `stopChange` now, so a row here is
  // one no rule will move again. Every one of them ends — a superseded attempt whose text already
  // landed elsewhere, a spent chain, or a technical stop that may be tried again.
  for (const change of store.listWithStatus(db, 'escalated')) {
    if (only !== null && change.id !== only.changeId) continue;
    if (store.readLane(db).holder === change.id) continue;
    if (hasLiveLease(db, change.id)) continue;
    const was = `escalated · ${change.outcome ?? 'unknown'}`;
    // The filing's own ledger: a `done` change that took this text is the last word about it.
    const landed =
      change.source_comment === null ? undefined : filingChanges(db, change.source_comment, change.id).landed;
    // A premise has one queued row per chapter (the partial unique index). An escalated premise
    // whose chapter is already waiting under another row has nothing left to re-enter.
    const collides =
      change.premise === 1 &&
      db
        .prepare(`SELECT 1 AS one FROM changes WHERE chapter = ? AND premise = 1 AND status = 'pending' AND id <> ?`)
        .get(change.chapter, change.id) !== undefined;
    guard(change.id, () => {
      if (landed !== undefined || collides) {
        // The filing is answered elsewhere — its text landed through another change, or its
        // chapter's premise already waits under the live row — so the reader is told nothing: a
        // `void` decision would announce «правка по главе N отклонена» over a page that says
        // otherwise (`passEvent.ts` reads the row, not the filing's state).
        if (
          !stopChange(deps, change, droppedLine('superseded'), now, 'escalated:origin', 'escalated', { notify: false })
        ) {
          return;
        }
        record({
          kind: 'change',
          id: change.id,
          changeId: change.id,
          condition: 'escalated-superseded',
          was,
          became: 'void · dropped',
        });
        return;
      }
      const attempts = change.attempts + 1;
      if (attempts >= QUEUE_MAX_ATTEMPTS) {
        if (!stopChange(deps, change, queueAttemptsLine(QUEUE_MAX_ATTEMPTS), now, 'escalated:origin', 'escalated')) return;
        record({
          kind: 'change',
          id: change.id,
          changeId: change.id,
          condition: 'escalated-exhausted',
          was,
          became: 'void · dropped',
        });
        return;
      }
      store.updateChange(db, change.id, {
        status: 'pending',
        outcome: null,
        reason: null,
        started_at: null,
        finished_at: null,
        cascade_id: null,
        attempts,
      });
      appendChangeEvent(db, change.id, 'released', { sweep: true, attempts }, now);
      appendEvent(
        db,
        { kind: 'change.queued', changeId: change.id, chapter: change.chapter, payload: { retry: true, sweep: true } },
        now,
      );
      record({
        kind: 'change',
        id: change.id,
        changeId: change.id,
        condition: 'escalated-retry',
        was,
        became: `pending (retry ${String(attempts)} of ${String(QUEUE_MAX_ATTEMPTS)})`,
      });
    });
  }

  return report;
}
