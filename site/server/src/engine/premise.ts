/**
 * BOOK-7 — a chapter-level premise, and the one place its state changes (BOOK-DOC-6).
 *
 * An intervention on a slot that has no text cannot be prose: there is nothing to rewrite.
 * It is filed as that chapter's **premise** — a change with `base_rev 0`, no block anchor and
 * `premise = 1` — and it waits for the chapter's first draft pass, never for the FIFO lane
 * (`store.headPending` excludes it). The writer either takes it in the first edition or
 * refuses it with one plain reason; the row is the durable answer the reader sees.
 *
 * States are the existing change vocabulary, not a second one:
 *   pending  — waiting for the chapter's first pass («принято в основу»);
 *   done     — the first edition landed (`applied`, «вошло в первую редакцию главы N»);
 *   void     — `superseded` (another premise was earlier) or `dropped` (the writer refused).
 * Every transition is a conditional UPDATE on `status = 'pending'`, so a double close cannot
 * apply a premise twice; a failed UPDATE changes nothing and writes no event.
 */

import {
  PREMISE_FROZEN_REASON,
  REASON_MAX_CHARS,
  normalizeInterventionKind,
  type InterventionKind,
  type PremiseAssignment,
  type StepOutcome,
} from '@book/shared';

import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { recordAcceptance } from '../comments/acceptance.ts';
import { recordImpact } from '../history/impact.ts';
import type { Db } from '../db/db.ts';
import { getChapterRow } from '../db/repo/chapters.ts';
import { sendPassEvent } from '../push/passEvent.ts';
import { toIso } from '../util/time.ts';
import * as store from './store.ts';
import { isBasisSlot, isWrittenIn } from './text.ts';
import type { EngineDeps, PremiseCause } from './types.ts';

/** «у главы уже есть замысел» — the second premise of one chapter, told to its reader. */
export const PREMISE_SUPERSEDED_REASON = 'у главы уже есть замысел';
/** The writer's pass brought nothing: the premise did not enter the first edition. */
export const PREMISE_NOT_TAKEN_REASON = 'первая редакция не взяла замысел';
/** The chapter was written outside the pass that consumed the premise (reconcile finds it). */
export const PREMISE_STALE_REASON = 'глава написана без этого замысла';

export function premiseAppliedReason(chapter: number): string {
  return `вошло в первую редакцию главы ${chapter}`;
}

/** The queued premise of a chapter, if any. At most one by construction (admission). */
export function queuedPremise(db: Db, chapter: number): store.ChangeRow | undefined {
  return db
    .prepare(`SELECT * FROM changes WHERE premise = 1 AND chapter = ? AND status = 'pending' ORDER BY seq LIMIT 1`)
    .get(chapter) as store.ChangeRow | undefined;
}

export type PremiseInput = {
  id: string;
  kind: 'reader_edit' | 'accepted_comment' | 'continuity' | 'operator';
  chapter: number;
  intent: string;
  interventionKind: InterventionKind | null;
  sourceComment: string | null;
  sourceSession: string | null;
  /** BOOK-137 — the mark the filing carried, copied onto the premise row (null outside one). */
  frame?: string | null;
  at: string;
};

export type PremiseAdmission = { id: string; seq: number; superseded: boolean };

/**
 * Admit an intervention as a premise, or as a `superseded` row when the chapter already has
 * one. Both outcomes are durable rows with a public reason — a premise is never dropped in
 * silence, and the second one still points at the reader's comment. `changes_premise_pending`
 * (a partial unique index) is the database's own promise of one queued premise per chapter:
 * a race that loses the index race lands on the same `superseded` answer, not on an error.
 */
export function admitPremise(db: Db, input: PremiseInput): PremiseAdmission {
  const atMs = Date.parse(input.at);
  const earlier = queuedPremise(db, input.chapter);
  const base: store.NewChange = {
    id: input.id,
    kind: input.kind,
    interventionKind: input.interventionKind,
    chapter: input.chapter,
    anchor: null,
    intent: input.intent,
    proposedText: null,
    sourceComment: input.sourceComment,
    sourceSession: input.sourceSession,
    baseRev: 0,
    baseSha: '',
    baseBlocks: '[]',
    scopeHint: 'chapter',
    premise: 1,
    frame: input.frame ?? null,
    enqueuedAt: input.at,
  };

  if (earlier !== undefined) {
    return { id: input.id, seq: insertSuperseded(db, base), superseded: true };
  }
  let seq: number;
  try {
    seq = store.insertChange(db, base);
  } catch (error) {
    // The read above lost a race; the partial unique index is the serialisation point. The
    // driver reports SQLITE_CONSTRAINT_UNIQUE with the chapter column, not the index name, so
    // the branch is on the code — never on a message shape.
    if (!isUniqueViolation(error)) throw error;
    return { id: input.id, seq: insertSuperseded(db, base), superseded: true };
  }
  appendChangeEvent(db, input.id, 'queued', { chapter: input.chapter, kind: input.kind, premise: true }, atMs);
  appendEvent(
    db,
    {
      kind: 'change.queued',
      changeId: input.id,
      chapter: input.chapter,
      authorKind: 'reader',
      payload: { seq, intent: input.intent, premise: true },
    },
    atMs,
  );
  return { id: input.id, seq, superseded: false };
}

/** The later premise exists as a row with its public answer, never as a silent drop. */
function insertSuperseded(db: Db, base: store.NewChange): number {
  const atMs = Date.parse(base.enqueuedAt);
  const seq = store.insertChange(db, {
    ...base,
    status: 'void',
    outcome: 'superseded',
    reason: PREMISE_SUPERSEDED_REASON,
    finishedAt: base.enqueuedAt,
  });
  appendChangeEvent(
    db,
    base.id,
    'decided',
    { outcome: 'superseded', reason: PREMISE_SUPERSEDED_REASON, premise: true },
    atMs,
  );
  appendEvent(
    db,
    {
      kind: 'change.decided',
      changeId: base.id,
      chapter: base.chapter,
      payload: { premise: true, status: 'void', outcome: 'superseded', reason: PREMISE_SUPERSEDED_REASON },
    },
    atMs,
  );
  return seq;
}

/** The driver's UNIQUE code — a lost one-premise race, under any wording SQLite picks. */
function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** The premise a draft step carries, in the writer's shape (no label, no comment body). */
export function premiseOfStep(db: Db, step: store.StepRow): PremiseAssignment | null {
  if (step.premise_change === null) return null;
  const change = store.getChange(db, step.premise_change);
  if (change === undefined || change.premise !== 1) return null;
  return { intent: { value: change.intent, untrusted: true }, kind: normalizeInterventionKind(change.intervention_kind) };
}

export type PremiseSettlement = 'applied' | 'rejected' | null;

/**
 * Settle the premise a draft step consumed. Called only from `closeStep`, inside its
 * transaction: the chapter's text is the fact that decides it. An interrupted pass leaves the
 * premise queued — the next first pass still has it (`null`). A pass that **broke**
 * (`cause: 'failed'`) neither takes nor refuses an intervention: if it wrote the chapter, the
 * premise did enter the first edition whatever killed the gate afterwards (`applied`); if it did
 * not, the premise waits for a later pass (`null`). Only the writer's own refusal of the work
 * (`'refused'`, the default and today's meaning) drops the reader's row.
 */
export function settleDraftPremise(
  deps: EngineDeps,
  step: store.StepRow,
  outcome: StepOutcome | null,
  escalation: string | null,
  note: string | null,
  now: number,
  cause: PremiseCause = 'refused',
): PremiseSettlement {
  if (step.pass !== 'draft' || step.premise_change === null) return null;
  const premise = store.getChange(deps.db, step.premise_change);
  if (premise === undefined || premise.premise !== 1) return null;
  const words = (note ?? '').replace(/\s+/gu, ' ').trim().slice(0, REASON_MAX_CHARS);
  // A broken pass is not a refusal: the pass wrote the chapter from this premise or it did not
  // write at all. Text is the fact here, so no note is needed to acknowledge it.
  if (outcome === 'escalated' && cause === 'failed') {
    if (!isWrittenIn(deps.db, premise.chapter)) return null;
    return settle(deps, premise, 'applied', premiseAppliedReason(premise.chapter), now);
  }
  // A refusal wins over a landing: a writer who escalated said no, even if the file exists and
  // the report also carries a note. «Замысел учтён» must never be published for a refusal.
  if (outcome === 'escalated' && escalation !== 'escalated:gate_timeout') {
    return settle(deps, premise, 'rejected', words.length === 0 ? PREMISE_NOT_TAKEN_REASON : words, now);
  }
  if (isWrittenIn(deps.db, premise.chapter)) {
    // Text alone is not consent: the writer acknowledges the premise in the pass report
    // (`done --note`). A pass that says nothing leaves it queued, and `reconcilePremises`
    // closes it as written without that premise.
    return words.length === 0 ? null : settle(deps, premise, 'applied', premiseAppliedReason(premise.chapter), now);
  }
  // A vanished session is not a refusal: the step is re-issued and the premise stays queued.
  if (outcome === 'interrupted' || escalation === 'escalated:gate_timeout') return null;
  if (outcome !== 'holds') return null;
  return settle(deps, premise, 'rejected', words.length === 0 ? PREMISE_NOT_TAKEN_REASON : words, now);
}

/**
 * The maintenance pass: a premise whose chapter was written outside the draft that consumed
 * it can never land in a first edition any more. It is closed with a public reason instead of
 * waiting forever; a draft step still open for that chapter keeps its premise untouched.
 */
export function reconcilePremises(deps: EngineDeps, now: number = deps.clock.now()): number {
  const rows = deps.db
    .prepare(`SELECT * FROM changes WHERE premise = 1 AND status = 'pending' ORDER BY seq`)
    .all() as store.ChangeRow[];
  let settled = 0;
  for (const premise of rows) {
    const open = deps.db
      .prepare(`SELECT 1 AS one FROM steps WHERE outcome IS NULL AND pass = 'draft' AND chapter = ?`)
      .get(premise.chapter);
    if (open !== undefined) continue;
    // BOOK-137: the freeze is the slot's shape, not the number. Before, a premise on ch01/ch42
    // was rejected by number alone; now a **basis-only** slot is rejected the same way, and a
    // written ch01/ch42 falls to the stale branch like any other written chapter.
    if (isBasisSlot(getChapterRow(deps.db, premise.chapter))) {
      if (settle(deps, premise, 'rejected', PREMISE_FROZEN_REASON, now) !== null) settled += 1;
      continue;
    }
    if (!isWrittenIn(deps.db, premise.chapter)) continue;
    if (settle(deps, premise, 'rejected', PREMISE_STALE_REASON, now) !== null) settled += 1;
  }
  return settled;
}

function settle(
  deps: EngineDeps,
  premise: store.ChangeRow,
  state: 'applied' | 'rejected',
  reason: string,
  now: number,
): PremiseSettlement {
  const status = state === 'applied' ? 'done' : 'void';
  const outcome = state === 'applied' ? 'applied' : 'dropped';
  const changed = deps.db
    .prepare(
      `UPDATE changes SET status = ?, outcome = ?, reason = ?, finished_at = ?
        WHERE id = ? AND status = 'pending' AND premise = 1`,
    )
    .run(status, outcome, reason, toIso(now), premise.id).changes;
  // No confirmation, no side effect: the second close of a premise is a silent no-op here.
  if (changed !== 1) return null;
  // BOOK-58 §10: a landed premise is a landing too — the reader's intervention entered the
  // chapter's first edition, so its acceptance is recorded now (once; the guard is inside).
  if (state === 'applied') recordAcceptance(deps.db, premise.id, toIso(now));
  appendChangeEvent(deps.db, premise.id, 'decided', { outcome, reason, premise: true }, now);
  appendEvent(
    deps.db,
    {
      kind: 'change.decided',
      changeId: premise.id,
      chapter: premise.chapter,
      payload: { premise: true, status, outcome, reason },
    },
    now,
  );
  recordImpact(deps.db, premise.id, now);
  // BOOK-189: the premise's own settlement is what speaks to its reader — the draft step that
  // consumed it announced nothing at land, exactly so a refusal here could never be contradicted.
  // Only this branch is reachable after the conditional UPDATE above confirmed the transition.
  sendPassEvent(deps.db, { kind: 'decision', changeId: premise.id }, now);
  return state;
}
