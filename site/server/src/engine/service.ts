/**
 * The engine's session-facing surface (ARCHITECTURE.md §6A.4, §6A.11, §6A.12).
 *
 * Everything a writer or a gate session can do goes through these methods, and they are the
 * only place where one operation spans more than one fact: land, ask both gates, close the
 * step, advance the ripple. The CLI (`bin/engine.mjs`) and the internal API are thin adapters
 * over this object, so the protocol has exactly one implementation.
 *
 * The engine has no opinion about prose. Its opinions are factual: is the step complete (two
 * verdicts, in order, from the sessions that hold it), is the ripple inside its bounds, may
 * this chapter be written now (§6A.1, ADR-012).
 */

import {
  NOTE_MAX_CHARS,
  REASON_MAX_CHARS,
  normalizeSeamBoundary,
  parseSeams,
  seamTouchesChapter,
  type CascadeOutcome,
  type ChangeStatus,
  type GateRole,
  type SeamRef,
  type StepOutcome,
  type WriterAssignment,
} from '@book/shared';

import { appendEvent } from '../history/log.ts';
import { ensureSlice } from '../index/store.ts';
import { toIso } from '../util/time.ts';
import { closeStep } from './close.ts';
import { reportIndexFailure } from './indexNotice.ts';
import { type DraftLane } from './draft.ts';
import {
  assignmentOf,
  blockingVerdict,
  missingVerdicts,
  openDispatch,
  recordVerdict,
  survivedBlocker,
  type GateAssignment,
  type GateAnswer,
  type RightsAssignment,
} from './gates.ts';
import {
  blockHashes,
  changeForStep,
  measureDelta,
  preBlocksOf,
  safeJson,
  sameSequence,
} from './helpers.ts';
import { beatLease, openStepForClose, releaseLease } from './leases.ts';
import { requirePipelineModel } from './model.ts';
import { reconcilePremises } from './premise.ts';
import { createQueue } from './queue.ts';
import { reap, type ReapReport } from './reap.ts';
import { reconcileRestore, type RestoreReconcileResult } from './reconcile.ts';
import * as store from './store.ts';
import { readChapter, readFront } from './text.ts';
import { writerAssignment } from './trace.ts';
import { refuse, type EngineDeps } from './types.ts';
import { createOverview } from './overview.ts';
import { createRightsGate } from './rightsGate.ts';
import { ensureRightsScan } from './rightsScan.ts';
import { createWriteOps } from './write.ts';

export type { EnqueueInput } from './queue.ts';

export type DoneOptions = {
  seams: unknown;
  note?: string;
  /** ADR-038: required in the type, so `tsc` lists every caller of a close. */
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  now?: number;
};

/** BOOK-62: `seen` closes a prose step through the same path, so it takes the same options. */
export type SeenOptions = Omit<DoneOptions, 'seams' | 'note'>;

export type NextInput = { for?: string; role?: GateRole | 'rights'; session: string };

export type DoneResult = {
  stepId: string;
  outcome: StepOutcome;
  cascadeId: string | null;
  changeStatus: ChangeStatus | null;
};

export type { EngineState } from './overview.ts';

export function createEngine(deps: EngineDeps) {
  const { db, config, bookRoot } = deps;
  const queue = createQueue(deps);
  const write = createWriteOps(deps);
  const overview = createOverview(deps);
  const iso = (ms: number = deps.clock.now()): string => toIso(ms);

  const freshStep = (stepId: string): store.StepRow => {
    const step = store.getStep(db, stepId);
    if (!step) refuse('STEP_NOT_FOUND', 404, `no step ${stepId}`);
    return step;
  };

  const leaseStep = (leaseId: string) => openStepForClose(deps, leaseId);

  const assign = (step: store.StepRow, leaseId: string): WriterAssignment =>
    writerAssignment(deps, step, leaseId, changeForStep(db, step)?.id ?? null);

  // ── next ──────────────────────────────────────────────────────────────────

  function nextGate(role: GateRole, session: string): GateAssignment | null {
    for (const step of store.listOpenSteps(db)) {
      if (step.landed_at === null) continue;
      if (store.getVerdict(db, step.step_id, role)) continue;
      if (role === 'consultant' && !store.getVerdict(db, step.step_id, 'editor')) continue;
      const existing = store.getDispatch(db, step.step_id, role);
      if (existing && existing.session !== session && existing.expires_at > iso()) continue;
      try {
        // BOOK-18: an editor gets a slice of the derived index — this chapter and its
        // neighbours. The consultant judges physics, not continuity, and gets none.
        const indexSlice =
          role === 'editor' && step.chapter !== null
            ? ensureSlice({ bookRoot, dataDir: config.dataDir }, step.chapter, (error) =>
                reportIndexFailure(deps, step.step_id, error))
            : null;
        return assignmentOf(step, openDispatch(deps, step, role, session), indexSlice);
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'GATE_ANSWERED') {
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  /**
   * BOOK-61 — the conditional rights gate lives in its own module (`rightsGate.ts`): a
   * different question, a different enum, and its own close. The engine only wires it in.
   */
  const rights = createRightsGate(deps);

  function next(input: NextInput): WriterAssignment | GateAssignment | RightsAssignment | null {
    if (!input.session || input.session.length > 64) refuse('INVALID_SESSION', 422, 'a session name is required');
    reap(deps, deps.clock.now());

    // BOOK-61: `rights` is the conditional gate — it is offered only for a step whose scan
    // flagged, and it is offered before any writer claim (it belongs to a landed step).
    if (input.role === 'rights') return rights.next(input.session);
    if (input.role) return nextGate(input.role, input.session);
    if (input.for !== 'fwd' && input.for !== 'bwd') {
      refuse('INVALID_LANE', 422, 'either --for fwd|bwd or --role editor|consultant|rights is required');
    }
    const lane: DraftLane = input.for;

    // §6A.9 / BOOK-6: writing is the owner's switch. While `DRAFTING` is off no writer
    // assignment is handed out — not a draft, not an open step, not a queued change — so an
    // empty book cannot start a pass by itself. Gates may still answer a landed step.
    if (config.drafting !== 'on') return null;

    for (const lease of store.liveLeaseForSession(db, input.session)) {
      const step = store.getStep(db, lease.step_id);
      if (step && step.outcome === null) return assign(step, lease.id);
    }
    const open = queue.claimOpenStep(input.session, lane);
    if (open) return open;
    if (store.listOpenCascades(db).length === 0) {
      const claimed = queue.claimHead(input.session);
      if (claimed) return claimed;
    }
    return queue.startDraft(input.session, lane, deps.clock.now());
  }

  // ── verdict ───────────────────────────────────────────────────────────────

  function verdict(
    stepId: string,
    answer: GateAnswer & { session: string },
  ): { action: string; cycle: number; verdict: string; downgraded: boolean; late: boolean } {
    const at = deps.clock.now();
    const step = freshStep(stepId);
    if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${stepId} is closed`);
    const result = recordVerdict(deps, step, answer, answer.session);
    if (result.action === 'revise') {
      store.updateStep(db, step.step_id, {
        cycle: step.cycle + 1,
        last_findings: result.verdict.findings,
      });
    }
    appendEvent(
      db,
      {
        kind: 'gate.recorded',
        stepId,
        cascadeId: step.cascade_id,
        chapter: step.chapter,
        payload: {
          role: answer.role,
          verdict: result.verdict.verdict,
          cycle: result.verdict.cycles,
          blockers: (safeJson<Array<{ severity: string }>>(result.verdict.findings) ?? []).filter(
            (finding) => finding.severity === 'blocker',
          ).length,
          action: result.action,
          late: result.late,
          downgraded: result.downgraded,
        },
      },
      at,
    );
    return {
      action: result.action,
      cycle: result.action === 'revise' ? step.cycle + 1 : step.cycle,
      verdict: result.verdict.verdict,
      downgraded: result.downgraded,
      late: result.late,
    };
  }

  // ── done / seen ───────────────────────────────────────────────────────────

  function closeWithGates(
    leaseId: string, seams: SeamRef[], note: string | null, options: SeenOptions & { where: 'done' | 'seen' },
  ): DoneResult {
    // ADR-038: the model is refused **first** — before the lease opens — so nothing is consumed.
    const model = requirePipelineModel(config, options.model, options.where);
    const at = options.now ?? deps.clock.now();
    const { lease, step, expired } = leaseStep(leaseId);
    if (step.landed_at === null) {
      refuse('NOT_LANDED', 409, 'a step closes on a landed file — call land first (§6A.11)');
    }
    // BOOK-61 review B3: a step that landed before Gate B existed carries no scan. The question
    // is asked now, on the way out, so no step closes without B having been offered the step.
    const closing = ensureRightsScan(deps, step);
    const missing = missingVerdicts(db, closing);
    if (missing.length > 0) {
      // BOOK-61: Gate B's requirement has its own code — the operator must be able to tell a
      // prose gate that has not spoken from a law question that has not been answered.
      if (missing.includes('rights')) {
        refuse(
          'RIGHTS_REQUIRED',
          409,
          `право на текст не подтверждено — не хватает: ${missing.join(', ')}`,
          { missing },
        );
      }
      refuse('VERDICTS_REQUIRED', 409, `a step cannot close without both verdicts; missing: ${missing.join(', ')}`, {
        missing,
      });
    }
    for (const seam of seams) {
      const chapter = step.chapter ?? (step.pass === 'front' ? 1 : 67);
      if (seamTouchesChapter(seam.boundary, chapter)) continue;
      if (step.pass === 'cascade') {
        // C2: a repair that needs a chapter outside this step's own reach is not a malformed
        // report — it is an escalation with the pair recorded (§6A.6).
        closeStep(
          deps,
          step.step_id,
          {
            outcome: 'escalated',
            seamsOut: seams,
            note: (note ?? `починка требует главы за пределами ${chapter}`).slice(0, NOTE_MAX_CHARS),
            model,
            tokensIn: options.tokensIn ?? 0,
            tokensOut: options.tokensOut ?? 0,
            escalation: 'escalated:origin',
            changeReason: 'починка требует главы позади волны — нужно решение',
            expiredLeaseId: expired ? lease.id : null,
          },
          at,
        );
        return { stepId: step.step_id, outcome: 'escalated', cascadeId: step.cascade_id, changeStatus: 'escalated' };
      }
      refuse('INVALID_SEAM', 422, `step ${step.step_id} cannot claim seam ${String(seam.boundary)}`);
    }

    const change = changeForStep(db, step);
    const gates = store.listVerdicts(db, step.step_id);
    // BOOK-76: a blocking consultant verdict below the cap must not close the step — revise and land again, or escalate. The ending escalates at close instead (ADR-024).
    if (step.pass !== 'ending' && step.cycle < config.gateCycles && blockingVerdict(db, step.step_id, 'consultant')) {
      refuse('BLOCKER_UNRESOLVED', 409, 'the physics pass named a blocker on this text: revise it and land again, or escalate');
    }
    const tokensIn = (options.tokensIn ?? 0) + gates.reduce((sum, row) => sum + row.tokens_in, 0);
    const tokensOut = (options.tokensOut ?? 0) + gates.reduce((sum, row) => sum + row.tokens_out, 0);
    // BOOK-76: an editor blocker publishes with its finding; a consultant blocker stops the step.
    const scienceBlocked = survivedBlocker(db, step.step_id, config.gateCycles, step.cycle, 'consultant');
    const editorBlocked = survivedBlocker(db, step.step_id, config.gateCycles, step.cycle, 'editor');

    const front = step.pass === 'front' ? readFront(bookRoot) : null;
    const chapter = step.pass === 'front' || step.chapter === null ? null : readChapter(bookRoot, step.chapter);
    const unchanged =
      step.pass === 'front'
        ? front !== null && step.start_sha !== null && front.sha256 === step.start_sha
        : chapter !== null && sameSequence(blockHashes(chapter.blocks), preBlocksOf(step).map((block) => block.hash));

    // ADR-024: a GAP on the ending escalates — the fix is never another rewrite of chapter 67.
    const endingGap =
      step.pass === 'ending' &&
      gates.some(
        (row) =>
          row.verdict === 'GAP' &&
          (safeJson<Array<{ severity: string }>>(row.findings) ?? []).some(
            (finding) => finding.severity === 'blocker',
          ),
      );

    // BOOK-76: precedence — the ending's GAP, then the physics pass, then a prose finding.
    const gateStop: 'ending' | 'science' | null = endingGap ? 'ending' : scienceBlocked ? 'science' : null;
    let outcome: StepOutcome = gateStop !== null ? 'escalated' : editorBlocked ? 'published_with_finding' : step.pass === 'ending' ? 'evaluated' : unchanged ? 'holds' : 'rewritten';
    let escalation: CascadeOutcome | null = gateStop === null ? null : gateStop === 'ending' ? 'escalated:ending' : 'escalated:science';

    if (step.pass === 'cascade' && !editorBlocked && outcome === 'rewritten' && chapter !== null) {
      const budget = step.cascade_id
        ? safeJson<{ maxDeltaRatio: number }>(store.getCascade(db, step.cascade_id)?.budget ?? null)
        : null;
      const measured = measureDelta(step, chapter.blocks);
      if (budget && measured.ratio > budget.maxDeltaRatio) {
        outcome = 'escalated';
        escalation = 'escalated:delta';
      }
      const rewrites = step.cascade_id
        ? (db
            .prepare(
              `SELECT COUNT(*) AS n FROM steps WHERE cascade_id = ? AND chapter = ? AND outcome IN ('rewritten','published_with_finding')`,
            )
            .get(step.cascade_id, step.chapter) as { n: number })
        : { n: 0 };
      if (outcome === 'rewritten' && rewrites.n >= config.maxRewritesPerChapter) {
        outcome = 'escalated';
        escalation = 'escalated:oscillation';
      }
    }

    const result = closeStep(
      deps,
      step.step_id,
      {
        outcome,
        seamsOut: seams,
        note: note ? note.slice(0, NOTE_MAX_CHARS) : null,
        model,
        tokensIn,
        tokensOut,
        changeOutcome: change?.outcome === 'adapted' ? 'adapted' : 'applied',
        // BOOK-76: a science stop carries its own public sentence (`escalated:science`).
        changeReason: outcome === 'escalated' && escalation !== 'escalated:science' ? 'починка вышла за границы правки — нужно решение' : null,
        escalation,
        expiredLeaseId: expired ? lease.id : null,
      },
      at,
    );
    return {
      stepId: step.step_id, outcome: result.outcome, cascadeId: result.cascadeId, changeStatus: result.changeStatus,
    };
  }

  /** Shape-check the report: garbage must be refused, never mistaken for "no seam" (§6A.4). */
  function seamReport(raw: unknown): SeamRef[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) refuse('INVALID_SEAM', 422, 'seams must be an array of {boundary, reason}');
    for (const item of raw) {
      if (item === null || typeof item !== 'object') refuse('INVALID_SEAM', 422, 'a seam must be an object');
      if (normalizeSeamBoundary((item as { boundary?: unknown }).boundary) === null) {
        refuse('INVALID_SEAM', 422, `unknown seam boundary: ${String((item as { boundary?: unknown }).boundary)}`);
      }
    }
    return parseSeams(raw);
  }

  const done = (leaseId: string, options: DoneOptions): DoneResult =>
    closeWithGates(leaseId, seamReport(options.seams), options.note ?? null, { ...options, where: 'done' });

  /** BOOK-62: `seen` closes a prose step through the same path, so it takes the same options. */
  const seen = (leaseId: string, note: string | null, options: SeenOptions): DoneResult =>
    closeWithGates(leaseId, [], note, { ...options, where: 'seen' });

  // ── escalate / beat ───────────────────────────────────────────────────────

  function escalate(leaseId: string, because: string, options: { now?: number } = {}): DoneResult {
    const at = options.now ?? deps.clock.now();
    const { lease, step, expired } = leaseStep(leaseId);
    const reason = because.toLowerCase();
    const outcome: CascadeOutcome = reason.includes('budget')
      ? 'escalated:budget'
      : reason.includes('oscillation')
        ? 'escalated:oscillation'
        : reason.includes('delta')
          ? 'escalated:delta'
          : reason.includes('ending')
            ? 'escalated:ending'
            : reason.includes('timeout')
              ? 'escalated:gate_timeout'
              : 'escalated:origin';
    const result = closeStep(
      deps,
      step.step_id,
      {
        outcome: 'escalated',
        seamsOut: [],
        note: because.slice(0, NOTE_MAX_CHARS),
        model: null,
        tokensIn: 0,
        tokensOut: 0,
        escalation: outcome,
        changeReason: because.slice(0, REASON_MAX_CHARS),
        expiredLeaseId: expired ? lease.id : null,
      },
      at,
    );
    return { stepId: step.step_id, outcome: 'escalated', cascadeId: result.cascadeId, changeStatus: 'escalated' };
  }

  function beat(leaseId: string): Record<string, unknown> {
    const lease = beatLease(deps, leaseId);
    if (lease.change_id) store.heartbeatLaneRow(db, lease.change_id, lease.heartbeat_at);
    return { leaseId: lease.id, expiresAt: lease.expires_at };
  }

  // ── reconcile ─────────────────────────────────────────────────────────────

  /**
   * Two operator meanings of one word, kept apart by the caller (§13.3): with a chapter it is
   * the mark on a restore; without one it is the maintenance pass over leaked leases.
   */
  function reconcileRestoreOf(input: { chapter: number; because: string; actor?: string }): RestoreReconcileResult {
    return reconcileRestore(deps, input);
  }

  function reconcile(): Record<string, unknown> {
    const report = reap(deps, deps.clock.now());
    const leaked = db
      .prepare(
        `SELECT l.id FROM leases l JOIN steps s ON s.step_id = l.step_id
          WHERE l.released_at IS NULL AND s.outcome IS NOT NULL`,
      )
      .all() as Array<{ id: string }>;
    for (const lease of leaked) releaseLease(db, lease.id, 'expired', deps.clock.now());
    // BOOK-7: a premise whose chapter was written outside its own first pass can never land
    // in that edition any more; it is closed with a public reason instead of waiting forever.
    const premisesSettled = reconcilePremises(deps, deps.clock.now());
    const processing = store.countProcessing(db);
    return {
      ...report,
      lane: { holder: store.readLane(db).holder },
      leakedLeases: leaked.length,
      premisesSettled,
      processing,
      pending: store.countPending(db),
      openSteps: store.countOpenSteps(db),
    };
  }

  return {
    next,
    start: write.start,
    land: write.land,
    verdict,
    verdictRights: rights.verdict,
    done,
    seen,
    escalate,
    beat,
    enqueue: queue.enqueue,
    commentKind: overview.commentKind,
    state: overview.state,
    trace: overview.trace,
    reconcile,
    reconcileRestore: reconcileRestoreOf,
    heartbeat: overview.heartbeat,
    reap: (): ReapReport => reap(deps, deps.clock.now()),
  };
}

export type Engine = ReturnType<typeof createEngine>;
