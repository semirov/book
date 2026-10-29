/**
 * The draft pass — a chapter's first edition, opened by a filing (BOOK-117 §4, BOOK-166, BOOK-202).
 *
 * A draft is the other kind of job the same session polls for: it is not in the FIFO lane and
 * never reorders a change. It lives beside `queue.ts` because a claim that produces no pass is
 * counted exactly like a change the lane could not take (`engine/claimAttempts.ts`) — the owner's
 * bound of attempts, never of hours (2026-10-29).
 *
 * A refusal is a code the caller branches on, never a silent null: `NOT_DRAFTING`,
 * `CHAPTER_WRITTEN`, `NO_FILING_FOR_CHAPTER` (BOOK-166, with the just-reset exception of
 * BOOK-202), `BUDGET_PAUSED`/`BUDGET_STOPPED`, `PASS_LEASED` (and the lease bounds from
 * `acquireLease`).
 */

import {
  FORWARD_LAST,
  PREMISE_FROZEN_REASON,
  TOTAL_CHAPTERS,
  type WriterAssignment,
} from '@book/shared';

import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { currentRev } from './close.ts';
import type { ClaimAttempts } from './claimAttempts.ts';
import type { DraftLane } from './draft.ts';
import { boundaryFor } from './helpers.ts';
import { acquireLease } from './leases.ts';
import { noFilingReason, passableWithoutFiling, queuedPremise } from './premise.ts';
import * as store from './store.ts';
import { isBasisSlot, isWrittenChapter, readChapterRows } from './text.ts';
import { refuse, type EngineDeps } from './types.ts';
import { newStepId } from '../util/ulid.ts';

export type DraftPassDeps = {
  deps: EngineDeps;
  iso: (ms?: number) => string;
  budgetGuard: (at: number) => void;
  assignment: (step: store.StepRow, leaseId: string) => WriterAssignment;
  claims: ClaimAttempts;
};

function refusalCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error ? (error as { code: string }).code : null;
}

export function createDraftPass(input: DraftPassDeps): {
  openPass: (session: string, chapter: number, at: number) => WriterAssignment | null;
  startDraft: (session: string, lane: DraftLane, at: number) => WriterAssignment | null;
} {
  const { deps, iso, budgetGuard, assignment, claims } = input;
  const { db, config } = deps;

  /**
   * BOOK-117 §4 — one first pass, opened by the chapter it names.
   *
   * A lane can only offer its own next slot, so a premise waiting in a far chapter would wait
   * for every pass in between; an operator may name the chapter instead. It is the *same*
   * pass: one open draft step per chapter, the premise ride-along, the boundary and one lease.
   * A refusal is a code the caller branches on, never a silent null: `NOT_DRAFTING`,
   * `CHAPTER_WRITTEN`, `NO_FILING_FOR_CHAPTER` (BOOK-166, with the just-reset exception of
   * BOOK-202), `BUDGET_PAUSED`/`BUDGET_STOPPED`, `PASS_LEASED` (and the lease bounds
   * from `acquireLease`).
   */
  function openPass(session: string, chapter: number, at: number): WriterAssignment | null {
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > TOTAL_CHAPTERS) {
      refuse('INVALID_CHAPTER', 422, `a draft pass belongs to a chapter in 1..${String(TOTAL_CHAPTERS)}`);
    }
    // Writing is the owner's switch (§6A.9, BOOK-6): no pass opens while it is off.
    if (config.drafting !== 'on') refuse('NOT_DRAFTING', 409, 'drafting is off — writing is the owner’s switch');
    // A written chapter changes through the FIFO lane: a first pass would overwrite prose.
    if (isWrittenChapter(readChapterRows(db, chapter))) {
      refuse('CHAPTER_WRITTEN', 409, `глава ${chapter} уже написана — она меняется через очередь правок`);
    }
    // BOOK-117: the money bound replaces the token refusal here — a paused day and a stopped
    // book are the owner's numbers, and they are the same line on every surface.
    budgetGuard(at);

    // BOOK-166 (owner, 2026-10-28): a draft pass exists only when a filing asks for this
    // chapter. BOOK-202: a just-reset book — no filings at all, and exactly the forward lane's
    // next chapter — may open that chapter in order; a gap still refuses.
    const premise = queuedPremise(db, chapter);
    if (premise === undefined && !passableWithoutFiling(db, chapter)) {
      refuse('NO_FILING_FOR_CHAPTER', 409, noFilingReason(chapter));
    }

    // One pass per chapter: an open draft step of this chapter *is* the pass, whoever holds it.
    const open = store.listOpenSteps(db).find((step) => step.pass === 'draft' && step.chapter === chapter);
    if (open) {
      const live = store.liveLeaseForStep(db, open.step_id);
      if (live) {
        if (live.session !== session) {
          refuse('PASS_LEASED', 409, `the pass of chapter ${chapter} is held by another session`);
        }
        return assignment(open, live.id);
      }
      // The session that opened it is gone: the step is re-issued, with its premise already on it.
      const reused = acquireLease(deps, {
        step: open,
        session,
        expectedRev: open.rev_before ?? currentRev(db, chapter),
        changeId: null,
      });
      return assignment(open, reused.id);
    }

    // BOOK-7: the chapter's premise rides on the step that opens its first pass, so a
    // resumed step carries it again and a close can settle exactly that premise.
    // The premise is already resolved above (BOOK-166): the step carries the filing it serves.
    const lane: DraftLane = chapter <= FORWARD_LAST ? 'fwd' : 'bwd';
    const stepId = newStepId(at);
    store.insertStep(db, {
      stepId,
      cascadeId: null,
      seq: 0,
      wave: 0,
      lane: lane === 'fwd' ? 'forward' : 'backward',
      pass: 'draft',
      chapter,
      boundary: boundaryFor(chapter),
      seamsIn: '[]',
      revBefore: currentRev(db, chapter),
      at: iso(at),
      premiseChange: premise?.id ?? null,
    });
    appendEvent(
      db,
      {
        kind: 'step.opened',
        stepId,
        chapter,
        payload: { pass: 'draft', lane, ...(premise === undefined ? {} : { premise: premise.id }) },
      },
      at,
    );
    try {
      const lease = acquireLease(deps, {
        step: store.getStep(db, stepId) as store.StepRow,
        session,
        expectedRev: currentRev(db, chapter),
        changeId: null,
      });
      return assignment(store.getStep(db, stepId) as store.StepRow, lease.id);
    } catch (error) {
      // No capacity for a draft: the job is withdrawn, not left as a stranded open step.
      store.updateStep(db, stepId, { outcome: 'interrupted', closed_at: iso(at), note: 'no capacity' });
      appendEvent(db, { kind: 'step.closed', stepId, chapter, payload: { outcome: 'interrupted' } }, at);
      if (refusalCode(error) === 'PROCESS_CAP' || refusalCode(error) === 'STEP_CAP') return null;
      throw error;
    }
  }

  /** BOOK-166: drafting is pulled by filing; no work answers `null` (a named pass speaks the code). */
  function startDraft(session: string, _lane: DraftLane, at: number): WriterAssignment | null {
    // BOOK-166: the filings' own order, oldest first; no filing — no assignment, no estimate.
    const filings = db
      .prepare(`SELECT * FROM changes WHERE premise = 1 AND status = 'pending' ORDER BY seq`)
      .all() as store.ChangeRow[];
    for (const filing of filings) {
      const chapter = filing.chapter;
      // Only an *existing* basis-only slot is frozen; an absent chapter is the normal case.
      const slot = readChapterRows(db, chapter);
      if (chapter < 1 || chapter > TOTAL_CHAPTERS || (slot.exists && isBasisSlot(slot))) {
        // A frozen filing is closed with its reason; refusing would block the queue behind it.
        store.updateChange(db, filing.id, {
          status: 'void',
          outcome: 'dropped',
          reason: PREMISE_FROZEN_REASON,
        });
        appendChangeEvent(db, filing.id, 'cancelled', { reason: PREMISE_FROZEN_REASON }, at);
        continue;
      }
      // A written chapter changes through the FIFO lane (`claimHead`), not through a draft.
      if (isWrittenChapter(readChapterRows(db, chapter))) continue;
      if (store.listOpenSteps(db).some((step) => step.pass === 'draft' && step.chapter === chapter)) continue;
      try {
        budgetGuard(at);
      } catch (error) {
        const code = refusalCode(error);
        if (code === 'BUDGET_PAUSED' || code === 'BUDGET_STOPPED') return null;
        throw error;
      }
      const opened = openPass(session, chapter, at);
      // No capacity for the pass: a claim with no step, counted like any other.
      if (opened === null) claims.missed(filing, at);
      return opened;
    }
    return null;
  }

  return { openPass, startDraft };
}
