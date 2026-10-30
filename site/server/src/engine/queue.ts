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
import { createClaimAttempts } from './claimAttempts.ts';
import { createDraftPass } from './draftPass.ts';
import { closeUnfiledDraft } from './filings.ts';
import { acquireLease } from './leases.ts';
import { admitPremise } from './premise.ts';
import { gradeRelevance, needsWriterDecision } from './relevance.ts';
import { currentRev } from './close.ts';
import { claimBehind, blockLine, createQueueLog, queueBlockOf, SWEEP_OWNED, type QueueBlock } from './queueBlock.ts';
import { createPremiseBranch } from './queuePremise.ts';
import * as store from './store.ts';
import { isBasisSlot, isWrittenChapter, readChapterRows } from './text.ts';
import { writerAssignment } from './trace.ts';
import { sweepZombies, zombieFailureLine } from './zombieSweep.ts';
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
  const claims = createClaimAttempts(deps);
  /** BOOK-117: no pass is handed out past a cap, and a refusal touches nothing else. */
  const budgetGuard = (at: number): void => assertBudgetAllowsPass(db, caps, at);
  /** BOOK-235: one line per fact per poll, never the same line twice in a row. */
  const log = createQueueLog(deps);
  const premises = createPremiseBranch({ deps, log, budgetGuard });
  /**
   * BOOK-235 — a capacity refusal is one fact for the whole poll. The process and step caps are
   * the engine's, not a change's: the first refusal sets this, so the walk behind the head stops
   * instead of spending the six attempts of every filing waiting on a saturated machine.
   */
  let capacityRefused = false;

  const assignment = (step: store.StepRow, leaseId: string): WriterAssignment =>
    writerAssignment(deps, step, leaseId, changeForStep(db, step)?.id ?? null);
  // A draft is the other kind of job the same session polls for: not in the lane, never reorders.
  const draft = createDraftPass({ deps, iso, budgetGuard, assignment, claims });

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
    const nowMs = deps.clock.now();
    // A paused day hands nothing out. It is a wait bound by 00:00 UTC, not an attempt of any
    // change: the queue counter does not move for a pause (`claimAttempts.ts`).
    budgetGuard(nowMs);
    const at = iso(nowMs);
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

  // ── the premise branch (BOOK-235) ────────────────────────────────────────
  //
  // BOOK-7: a premise waits for its chapter's first pass, never for the FIFO lane, and it must
  // never stall the change behind it. The branch lives in `queuePremise.ts`; here it is only the
  // order of the poll: a draft nobody can open is named and settled, then the lane is asked.

  /** BOOK-166: the oldest undecided filing wins — a premise (a draft) or a change, by `seq`. */
  function claimFiling(session: string): WriterAssignment | null {
    const at = deps.clock.now();
    capacityRefused = false;
    log.begin();
    const premise = db.prepare(`SELECT * FROM changes WHERE premise = 1 AND status = 'pending' ORDER BY seq LIMIT 1`).get() as
      | store.ChangeRow
      | undefined;
    const head = store.headPending(db);
    if (premise === undefined && (head === null || head === undefined)) return null;
    const premiseFirst = premise !== undefined && (head === null || head === undefined || premise.seq < head.seq);
    if (premiseFirst) {
      const drafted = draft.startDraft(session, premise.chapter <= FORWARD_LAST ? 'fwd' : 'bwd', at);
      if (drafted !== null) return drafted;
      // No draft was handed out: say why, end the premises the engine can end, and — unless the
      // day is paused — ask the change queue instead of leaving the lane's head unclaimed behind
      // a premise the draft lane cannot serve (BOOK-7's own promise).
      if (premises.settleSkipped(at)) return null;
    }
    const claimed = claimHead(session);
    if (claimed !== null) return claimed;

    // BOOK-235: a null is not an answer. The owner's hole was «idle: заявок нет» beside a filing
    // in `pending`, because every guard in `claimHead` is silent. Name the block once, heal the
    // row that owns it, and only then let the queue's own counter move.
    let blocked = store.headPending(db);
    if (blocked === undefined) return null;
    let block = blockOf(blocked);
    log.report([blockLine(blocked.id, block)]);
    if (SWEEP_OWNED.has(block.condition) && block.ownerId !== null) {
      // The sweep is narrowed to the change that **owns** the blocking row — the ghost, the
      // cascade's change — never to the head: nothing of the head's would be healed, and the head
      // would spend an attempt for a row it does not own.
      const heal = sweepZombies(deps, { now: at, only: { changeId: block.ownerId } });
      log.report([...heal.lines, ...heal.failures.map((failure) => zombieFailureLine(failure.id, failure.code))]);
      const healed = claimHead(session);
      if (healed !== null) return healed;
      blocked = store.headPending(db) ?? blocked;
      block = blockOf(blocked);
      log.report([blockLine(blocked.id, block)]);
    }
    // The caps are the engine's own state: the claim reached the change, so it spent **one**
    // attempt (in `claimHeadOf`'s catch), and the poll ends here — no second count for the head,
    // no attempt for the queue behind a machine that cannot take any of it.
    if (block.condition === 'capacity') return null;
    // A held lane, a live pass and a step somebody is working are not this change's attempt:
    // nothing was asked of it, and another change is never handed out beside them.
    const busy =
      block.condition === 'lane_held' ||
      block.condition === 'processing_live' ||
      (block.condition === 'open_step' && !block.reached);
    if (busy) return null;
    // A foreign ghost or a foreign open cascade was never this change's attempt either: the head
    // is not counted for a row another change owns (`claimAttempts.ts`).
    if (block.reached) claims.missed(blocked, at);
    // The queue behind a wedged head is not wedged itself: the same claim, one change at a time,
    // until the engine refuses on capacity — which is the poll's fact, not the next row's.
    return claimBehind(
      db,
      blocked,
      (candidate) => claimHeadOf(session, candidate, { count: false }),
      () => capacityRefused,
    );
  }

  /**
   * The block a claim stopped on, with the poll's capacity answer folded in: a refusal by the caps
   * is `capacity`, never `claim_lost` (which means another process won the mutex for this row).
   */
  function blockOf(change: store.ChangeRow): QueueBlock {
    const block = queueBlockOf(deps, change);
    if (block.condition === 'claim_lost' && capacityRefused) {
      return { condition: 'capacity', detail: null, ownerId: null, reached: true };
    }
    return block;
  }

  /**
   * The head of the FIFO lane becomes the change in `processing`. `change` is the row the caller
   * asks for — `headPending` for the lane, any pending row for the claim behind a wedged head.
   * `count: false` is the walk behind a wedged head: only the poll's own head spends an attempt
   * there, so a saturated engine cannot void the whole queue in six polls.
   */
  function claimHeadOf(
    session: string,
    change: store.ChangeRow | undefined,
    options: { count?: boolean } = {},
  ): WriterAssignment | null {
    const at = deps.clock.now();
    // The guard runs before the lane is touched: a stopped book refuses at once (`reap.ts`), and
    // a paused one hands nothing out. A pause is a wait, not an attempt: the counter does not move
    // (`claimAttempts.ts`), and the change is asked again after 00:00 UTC.
    budgetGuard(at);
    const head = change;
    if (!head) return null;
    // The lane cannot take it, and that is **not** this change's attempt: the claim never
    // reached it. Another change holds the lane, a pass or a ripple is in flight — each waits,
    // and the queue counter (`claimAttempts.ts`) moves only on a claim the engine reached.
    if (store.readLane(db).holder !== null) return null;
    if (processingChange(db)) return null;
    if (store.listOpenCascades(db).length > 0) return null;
    // A change whose step already exists is re-issued to a session, not re-created here — a step
    // is the pass's own fact, and the step wall bounds it.
    if (store.stepsOfChange(db, head.id).some((step) => step.outcome === null)) return null;
    // Another process won the mutex for the same head: a concurrent claim, not a refusal of this
    // change — the winner's own claim is the attempt that counts.
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
      if (code === 'STEP_CAP' || code === 'PROCESS_CAP' || code === 'LEASE_HELD') {
        // The engine could not start it: a claim with no step, counted like any other — but only
        // for the poll's own head. `capacityRefused` tells the poll that its caps, not this row,
        // are the reason, so the walk behind it stops instead of spending every filing's six.
        capacityRefused = true;
        if (options.count !== false) claims.missed(head, at);
        return null;
      }
      throw error;
    }
  }

  function claimHead(session: string): WriterAssignment | null {
    return claimHeadOf(session, store.headPending(db));
  }

  return {
    enqueue,
    relevanceOf,
    claimOpenStep,
    claimFiling,
    claimHead,
    startDraft: draft.startDraft,
    openPass: draft.openPass,
  };
}

export type Queue = ReturnType<typeof createQueue>;
