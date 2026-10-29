/**
 * The FIFO lane and the jobs it hands out (ARCHITECTURE.md §6A.3, §6A.4 steps 1–3, §6A.10).
 *
 * One change at a time, in the order admitted: claiming the lane is a conditional UPDATE, so
 * two engine processes (or two session polls) cannot both win. A change is claimed only when
 * no ripple is open anywhere — a second cascade would rewrite overlapping seams, and the
 * oscillation guard only bounds *within* one ripple (§6A.3).
 *
 * Drafting shares this module because a draft is the other kind of job the same session polls
 * for: it is not in the queue and never reorders a change.
 */

import {
  FORWARD_LAST,
  INTENT_MAX_CHARS,
  PREMISE_FROZEN_REASON,
  TOO_MANY_FILINGS,
  TOTAL_CHAPTERS,
  normalizeInterventionKind,
  type ChangeStatus,
  type InterventionKind,
  type Relevance,
  type WriterAssignment,
} from '@book/shared';

import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { assertBudgetAllowsPass, budgetCapsOf } from '../budget.ts';
import { toIso } from '../util/time.ts';
import { newChangeId, newStepId } from '../util/ulid.ts';
import type { DraftLane } from './draft.ts';
import {
  boundaryFor,
  changeForStep,
  processingChange,
  safeJson,
} from './helpers.ts';
import { closeUnfiledDraft } from './filings.ts';
import { acquireLease } from './leases.ts';
import { admitPremise, noFilingReason, passableWithoutFiling, queuedPremise } from './premise.ts';
import { gradeRelevance, needsWriterDecision } from './relevance.ts';
import { currentRev } from './close.ts';
import * as store from './store.ts';
import { isBasisSlot, isWrittenChapter, readChapterRows } from './text.ts';
import { writerAssignment } from './trace.ts';
import { refuse, type EngineDeps } from './types.ts';

export type EnqueueInput = {
  kind: 'reader_edit' | 'accepted_comment' | 'continuity' | 'operator';
  chapter: number;
  intent: string;
  anchor?: { blockIds: string[]; sentenceIds?: string[]; quote: string; prefix: string; suffix: string } | null;
  proposedText?: string | null;
  scopeHint?: 'phrase' | 'chapter';
  commentId?: string | null;
  sessionId?: string | null;
};

type Refusal = { code: string };

function refusalCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error) return (error as Refusal).code;
  return null;
}

export function createQueue(deps: EngineDeps) {
  const { db, config } = deps;
  const iso = (ms: number = deps.clock.now()): string => toIso(ms);
  const caps = budgetCapsOf(config);
  /** BOOK-117: no pass is handed out past a cap, and a refusal touches nothing else. */
  const budgetGuard = (at: number): void => assertBudgetAllowsPass(db, caps, at);

  const assignment = (step: store.StepRow, leaseId: string): WriterAssignment =>
    writerAssignment(deps, step, leaseId, changeForStep(db, step)?.id ?? null);

  // ── admission ─────────────────────────────────────────────────────────────

  function enqueue(input: EnqueueInput): { id: string; seq: number; status: ChangeStatus } {
    const chapter = Math.trunc(input.chapter);
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > TOTAL_CHAPTERS) {
      refuse('INVALID_CHAPTER', 422, `a change belongs to a chapter in 1..${String(TOTAL_CHAPTERS)}`);
    }
    // BOOK-9: a change that names a comment is the comment's intervention — it exists only
    // if the auditor recorded `FITS` on that row. This is the second creator of `changes`
    // next to `feedback/accept.ts`, and both must ask the same question.
    // BOOK-16: the comment also carries the intervention's kind, and that is the kind the
    // change gets — a caller cannot declare a different world-fact than the reader did.
    let interventionKind: InterventionKind | null = null;
    if (input.commentId !== null && input.commentId !== undefined) {
      const source = db
        .prepare('SELECT audit_verdict, intervention_kind, rights_verdict, status FROM comments WHERE id = ?')
        .get(input.commentId) as
        | { audit_verdict: string | null; intervention_kind: string | null; rights_verdict: string | null; status: string }
        | undefined;
      if (source === undefined) refuse('UNKNOWN_COMMENT', 422, 'такого замечания нет');
      // BOOK-61: the same three columns `feedback/accept.ts` reads, in the same order. A gate
      // that has not spoken is a refusal here too — this is the second creator of a change.
      if (source.status === 'quarantined') {
        refuse('QUARANTINED', 422, 'замечание ещё проверяется — правку из него не делают');
      }
      if (source.rights_verdict !== 'CLEAR') {
        refuse('RIGHTS_REQUIRED', 422, 'право на текст не подтверждено — правку из него не делают');
      }
      if (source.audit_verdict !== 'FITS') {
        refuse(
          'AUDIT_REQUIRED',
          422,
          'замечание не прошло проверку на соответствие книге — правку из него не делают',
        );
      }
      interventionKind = normalizeInterventionKind(source.intervention_kind);
    }
    const intent = input.intent.replace(/\s+/gu, ' ').trim();
    if (intent.length === 0) refuse('INVALID_INTENT', 422, 'an empty intent is not a change');
    if (intent.length > INTENT_MAX_CHARS) {
      refuse('INVALID_INTENT', 422, `intent is ${intent.length} characters, limit is ${INTENT_MAX_CHARS}`);
    }
    const text = readChapterRows(db, chapter);
    // Read the slot's shape before the predicate narrows the chapter to "written".
    const basisOnly = isBasisSlot(text);
    // BOOK-137: a basis-only slot (ch01/ch42) is its frame sentence and nothing else — no prose
    // to write against and no anchor to place — so the site's own answer is the honest one: the
    // frame is the whole text. Any other empty slot is that chapter's premise (BOOK-7), whichever
    // its number; a written chapter, the finale included, takes an ordinary change.
    if (!isWrittenChapter(text)) {
      if (basisOnly) {
        refuse('FROZEN_FRAME', 422, PREMISE_FROZEN_REASON);
      }
      // BOOK-7: an intervention on an empty slot is the chapter's premise — a durable row with
      // base_rev 0, no anchor, and no place in the FIFO lane.
      if (input.kind === 'reader_edit' || input.kind === 'accepted_comment') {
        if (store.countPending(db) >= config.queueSoftCap) {
          refuse('QUEUE_FULL', 503, TOO_MANY_FILINGS);
        }
        const admitted = admitPremise(db, {
          id: newChangeId(deps.clock.now()),
          kind: input.kind,
          chapter,
          intent,
          interventionKind,
          sourceComment: input.commentId ?? null,
          sourceSession: input.sessionId ?? null,
          at: iso(),
        });
        return { id: admitted.id, seq: admitted.seq, status: admitted.superseded ? 'void' : 'pending' };
      }
      refuse('CHAPTER_EMPTY', 409, `глава ${chapter} ещё не написана`);
    }
    if (store.countPending(db) >= config.queueSoftCap) {
      refuse('QUEUE_FULL', 503, TOO_MANY_FILINGS);
    }

    const anchor = input.anchor
      ? JSON.stringify({
          blockIds: input.anchor.blockIds.slice(0, 8),
          sentenceIds: (input.anchor.sentenceIds ?? []).slice(0, 8),
          quote: input.anchor.quote.slice(0, 280),
          prefix: input.anchor.prefix.slice(0, 40),
          suffix: input.anchor.suffix.slice(0, 40),
        })
      : null;
    const id = newChangeId(deps.clock.now());
    const seq = store.insertChange(db, {
      id,
      kind: input.kind,
      interventionKind,
      chapter,
      anchor,
      intent,
      proposedText: input.proposedText ?? null,
      sourceComment: input.commentId ?? null,
      sourceSession: input.sessionId ?? null,
      baseRev: currentRev(db, chapter),
      baseSha: text.sha256,
      baseBlocks: JSON.stringify(text.blocks.map((block) => block.hash)),
      scopeHint: input.scopeHint ?? 'phrase',
      premise: 0,
      enqueuedAt: iso(),
    });
    appendChangeEvent(db, id, 'queued', { chapter, kind: input.kind }, deps.clock.now());
    appendEvent(
      db,
      { kind: 'change.queued', changeId: id, chapter, authorKind: 'reader', payload: { seq, intent } },
      deps.clock.now(),
    );
    return { id, seq, status: 'pending' };
  }

  /** Deterministic evidence that the base moved — no model, no judgement (§6A.7). */
  function relevanceOf(change: store.ChangeRow): Relevance {
    const chapter = readChapterRows(db, change.chapter);
    const anchor = safeJson<{ blockIds?: string[]; quote?: string }>(change.anchor);
    const revNow =
      chapter.sha256 === change.base_sha256
        ? change.base_rev
        : Math.max(currentRev(db, change.chapter), change.base_rev + 1);
    return gradeRelevance({
      baseRev: change.base_rev,
      baseBlocks: safeJson<string[]>(change.base_blocks) ?? [],
      anchor: anchor
        ? { blockIds: Array.isArray(anchor.blockIds) ? anchor.blockIds : [], quote: anchor.quote ?? '' }
        : null,
      current: { rev: revNow, blocks: chapter.blocks, text: chapter.text },
    });
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  function originStep(change: store.ChangeRow, at: number): store.StepRow {
    const stepId = newStepId(at);
    store.insertStep(db, {
      stepId,
      cascadeId: null,
      seq: 0,
      wave: 0,
      lane: null,
      pass: 'change',
      chapter: change.chapter,
      boundary: boundaryFor(change.chapter),
      seamsIn: '[]',
      revBefore: currentRev(db, change.chapter),
      at: iso(at),
    });
    appendEvent(
      db,
      {
        kind: 'step.opened',
        stepId,
        changeId: change.id,
        chapter: change.chapter,
        payload: { pass: 'change', origin: true },
      },
      at,
    );
    return store.getStep(db, stepId) as store.StepRow;
  }

  /**
   * Which lane a step belongs to. `change`, `front` and `ending` are lane-neutral: any free
   * writer may take them; a ripple repair belongs to the wing that owns it.
   */
  function laneOf(step: store.StepRow): DraftLane | null {
    if (step.lane === 'backward') return 'bwd';
    if (step.lane === 'forward') return 'fwd';
    if (step.pass === 'draft' && step.chapter !== null) return step.chapter <= FORWARD_LAST ? 'fwd' : 'bwd';
    return null;
  }

  /** An already-created step is claimed — never one whose filing is gone (BOOK-166). */
  function claimOpenStep(session: string, lane: DraftLane | 'filing'): WriterAssignment | null {
    budgetGuard(deps.clock.now());
    const at = iso(deps.clock.now());
    const candidates = store
      .listOpenSteps(db)
      .filter((step) => store.liveLeaseForStep(db, step.step_id) === undefined)
      .filter((step) => !(step.pass === 'cascade' && step.chapter === TOTAL_CHAPTERS))
      .filter((step) => {
        const expected = laneOf(step);
        return expected === null || lane === 'filing' || expected === lane;
      });
    for (const step of candidates) {
      // A draft without a live filing is closed here, never handed out (BOOK-166).
      if (closeUnfiledDraft(db, step, at, deps.clock.now())) continue;
      try {
        const lease = acquireLease(deps, {
          step,
          session,
          expectedRev: step.rev_before ?? (step.chapter === null ? 0 : currentRev(db, step.chapter)),
          changeId: changeForStep(db, step)?.id ?? null,
        });
        return assignment(step, lease.id);
      } catch (error) {
        if (refusalCode(error) === 'LEASE_HELD') continue;
        throw error;
      }
    }
    return null;
  }

  /** BOOK-166: the oldest undecided filing wins — a premise (a draft) or a change, by `seq`. */
  function claimFiling(session: string): WriterAssignment | null {
    const at = deps.clock.now();
    const premise = db.prepare(`SELECT * FROM changes WHERE premise = 1 AND status = 'pending' ORDER BY seq LIMIT 1`).get() as
      | store.ChangeRow
      | undefined;
    const head = store.headPending(db);
    if (premise === undefined && (head === null || head === undefined)) return null;
    const premiseFirst = premise !== undefined && (head === null || head === undefined || premise.seq < head.seq);
    if (premiseFirst) return startDraft(session, premise.chapter <= FORWARD_LAST ? 'fwd' : 'bwd', at);
    return claimHead(session);
  }

  /** The head of the FIFO lane becomes the change in `processing`. */
  function claimHead(session: string): WriterAssignment | null {
    // The guard runs before the lane is touched: a paused or stopped book leaves the pending
    // change pending, releases nothing and escalates nothing (BOOK-117).
    budgetGuard(deps.clock.now());
    if (store.readLane(db).holder !== null) return null;
    if (processingChange(db)) return null;
    if (store.listOpenCascades(db).length > 0) return null;
    const head = store.headPending(db);
    if (!head) return null;
    // A change whose step already exists is re-issued to a session, not re-created here.
    if (store.stepsOfChange(db, head.id).some((step) => step.outcome === null)) return null;
    const at = deps.clock.now();
    if (!store.claimLaneRow(db, head.id, iso(at))) return null;
    let created: store.StepRow | null = null;
    try {
      const current = store.getChange(db, head.id);
      if (!current || current.status !== 'pending') {
        store.releaseLaneRow(db, head.id);
        return null;
      }
      store.updateChange(db, head.id, { status: 'processing', started_at: iso(at) });
      appendChangeEvent(db, head.id, 'processing', {}, at);
      appendEvent(db, { kind: 'change.processing', changeId: head.id, chapter: current.chapter }, at);

      const relevance = relevanceOf(current);
      store.updateChange(db, head.id, {
        relevance: JSON.stringify(relevance),
        outcome: relevance.grade === 'fresh' || relevance.grade === 'rebased' ? 'applied' : null,
      });
      if (needsWriterDecision(relevance)) {
        appendChangeEvent(db, head.id, 'stale', { grade: relevance.grade }, at);
        appendEvent(
          db,
          { kind: 'change.stale', changeId: head.id, chapter: current.chapter, payload: { grade: relevance.grade } },
          at,
        );
      }
      created = originStep(current, at);
      const lease = acquireLease(deps, {
        step: created,
        session,
        expectedRev: currentRev(db, current.chapter),
        changeId: current.id,
      });
      return assignment(created, lease.id);
    } catch (error) {
      // The claim rolled back: the change returns to the queue and the step it created must
      // not survive as an orphan that another session could pick up.
      store.updateChange(db, head.id, { status: 'pending', started_at: null });
      store.releaseLaneRow(db, head.id);
      if (created) {
        store.updateStep(db, created.step_id, {
          outcome: 'interrupted',
          closed_at: iso(at),
          note: 'the lease could not be acquired',
        });
        appendEvent(
          db,
          { kind: 'step.closed', stepId: created.step_id, changeId: head.id, chapter: created.chapter, payload: { outcome: 'interrupted' } },
          at,
        );
      }
      const code = refusalCode(error);
      if (code === 'STEP_CAP' || code === 'PROCESS_CAP' || code === 'LEASE_HELD') return null;
      throw error;
    }
  }

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
      return openPass(session, chapter, at);
    }
    return null;
  }

  return { enqueue, relevanceOf, claimOpenStep, claimFiling, claimHead, startDraft, openPass };
}

export type Queue = ReturnType<typeof createQueue>;
