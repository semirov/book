/**
 * The reaper (ARCHITECTURE.md §6A.11, §6B.4 rule 5, §6B.7).
 *
 * A dead session must never block a chapter, and a dead gate must never hold a step open
 * forever. Every 15 s (and at the start of every `next`) the engine expires leases, takes a
 * write that landed without being reported, re-issues a job whose session vanished, and
 * escalates a step whose gate never answered. Nothing is silently restarted: each action is
 * an event, so "the engine recovered" is auditable like everything else.
 */

import { FAILURE_LINES, parseSeams } from '@book/shared';

import { appendChangeEvent, appendEvent } from '../history/log.ts';
import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { closeStep, currentRev } from './close.ts';
import { lastLeaseOfStep, releaseLease, stampEscalatedRelease, stepWallOf } from './leases.ts';
import * as store from './store.ts';
import { changeForStep } from './helpers.ts';
import { isWrittenChapter, readChapterRows, readFrontRows } from './text.ts';
import { isEngineError, type EngineDeps } from './types.ts';

export type ReapReport = {
  at: string;
  expiredLeases: number;
  /**
   * BOOK-34: open steps that reached their wall — escalated, or (a desperate dispatch nobody
   * claimed, BOOK-220 M2) closed `interrupted`, since no session did work to stop.
   */
  stepWalls: string[];
  /** BOOK-34: wall closes that refused to run; the rest of the tick still ran. */
  stepWallFailures: Array<{ stepId: string; code: string }>;
  /** Writes found on disk after a session died before reporting them. */
  recovered: string[];
  /** Steps whose session vanished and whose job is re-issued by the next poll. */
  reissued: string[];
  gateTimeouts: string[];
  laneReleased: string | null;
};

function bumpAttempts(deps: EngineDeps, changeId: string | null): number {
  if (changeId === null) return 0;
  const change = store.getChange(deps.db, changeId);
  if (!change) return 0;
  const attempts = change.attempts + 1;
  store.updateChange(deps.db, changeId, { attempts });
  appendChangeEvent(deps.db, changeId, 'released', { attempts }, deps.clock.now());
  return attempts;
}

/**
 * §10.8/DOC-84 §10.7 — how long an **unclaimed** desperate dispatch may wait, as a multiple of
 * the dispatch's own bound. A step's wall is its attempt's bound × 5 (the prose step's 225 min is
 * exactly 5 × 45 min), so the sixth gets 5 × 180 s = 900 s — one `WRITER_PAUSE_MS` (15 min), the
 * longest silence a live writer can leave between passes.
 */
const DESPERATE_WAIT_FACTOR = 5;

/**
 * When the desperate attempt was dispatched: the `step.opened` the reaper wrote when it marked
 * the step, else the step's own opening (a step seeded already desperate).
 */
function desperateDispatchedAt(db: Db, step: store.StepRow): number {
  const row = db
    .prepare(`SELECT at FROM events WHERE step_id = ? AND kind = 'step.opened' ORDER BY hseq DESC LIMIT 1`)
    .get(step.step_id) as { at: string } | undefined;
  const at = row === undefined ? Number.NaN : Date.parse(row.at);
  return Number.isNaN(at) ? Date.parse(step.at) : at;
}

/**
 * A desperate dispatch no session ever claimed: the wait is not work, so it is bounded and closed
 * `interrupted` — one `step.closed`, hence one `pass:closed{interrupted}`. The same shape
 * `cancelOpenSteps` uses: no change is closed as applied, and the lane's own pass re-queues it.
 */
function closeUnclaimedDesperate(deps: EngineDeps, step: store.StepRow, now: number): void {
  store.updateStep(deps.db, step.step_id, {
    outcome: 'interrupted',
    closed_at: toIso(now),
    note: 'отчаянная попытка не дождалась сессии — шаг снят',
  });
  appendEvent(
    deps.db,
    {
      kind: 'step.closed',
      stepId: step.step_id,
      cascadeId: step.cascade_id,
      chapter: step.chapter,
      payload: { outcome: 'interrupted', unclaimed: true },
    },
    now,
  );
}

export function reap(deps: EngineDeps, now: number = deps.clock.now()): ReapReport {
  const db = deps.db;
  const at = toIso(now);
  const report: ReapReport = {
    at,
    expiredLeases: 0,
    stepWalls: [],
    stepWallFailures: [],
    recovered: [],
    reissued: [],
    gateTimeouts: [],
    laneReleased: null,
  };

  // ── the step wall (BOOK-34) ───────────────────────────────────────────────
  // The engine beats a step's lease by itself while the step is open, so a lease expiry is no
  // longer the thing that bounds a step. The wall is: past the step's window (`stepWallOf` —
  // its opening, or its reopen if that is later) + STEP_WALL_MS the step is stopped and
  // escalated, and its lease released, however healthy the session looks. A walled step is
  // escalated, never re-issued — three attempts at 45 minutes each is a loop.
  for (const step of store.listOpenSteps(db)) {
    // §10.8: a desperate attempt is a dispatch (180 s), not work, and its short bound runs from
    // the attempt's own lease — never from the step's opening, or the wall would close the sixth
    // before a session could claim it. A desperate step **nobody claimed** has no lease to run
    // from, and skipping it left it open for ever: the wait is bounded from the dispatch itself
    // (`DESPERATE_WAIT_FACTOR`), and past it the step is closed `interrupted` — no session did
    // any work to stop, so nothing is escalated and nothing re-issues.
    const liveLease = step.desperate === 1 ? store.liveLeaseForStep(db, step.step_id) : undefined;
    const unclaimed = step.desperate === 1 && liveLease === undefined;
    // BOOK-117: the ordinary wall is the step's window — its opening, or its reopen if later.
    if (!step.desperate && stepWallOf(deps, step) > now) continue;
    const wall =
      step.desperate === 1
        ? unclaimed
          ? DESPERATE_WAIT_FACTOR * deps.config.desperateDeadlineMs
          : deps.config.desperateDeadlineMs
        : deps.config.stepWallMs;
    const wallFrom =
      step.desperate === 1
        ? unclaimed
          ? desperateDispatchedAt(db, step)
          : Date.parse(liveLease?.acquired_at ?? step.at)
        : Date.parse(step.at);
    if (wallFrom + wall > now) continue;
    // Closing a walled step may close its whole cascade (a ripple owns no work in flight),
    // so a later step of the same snapshot may already be closed by the time it is reached.
    if (store.getStep(db, step.step_id)?.outcome !== null) continue;
    if (unclaimed) {
      closeUnclaimedDesperate(deps, step, now);
      report.stepWalls.push(step.step_id);
      continue;
    }
    const lease = store.liveLeaseForStep(db, step.step_id) ?? lastLeaseOfStep(db, step.step_id);
    try {
      closeStep(
        deps,
        step.step_id,
        {
          outcome: 'escalated',
          seamsOut: parseSeams(null),
          // The note is read by an operator and copied to a page: a sentence, never a constant.
          note: `глава не закрылась за отведённое время (${String(Math.round(wall / 60_000))} мин) — проход остановлен`,
          model: null,
          tokensIn: 0,
          tokensOut: 0,
          // The existing wall vocabulary: a step that did not close in time is a stop, and its
          // draft premise stays queued to the next pass rather than being read as a refusal.
          escalation: 'escalated:gate_timeout',
          changeReason: FAILURE_LINES.outOfTime,
        },
        now,
      );
      // The stop owns the lease: one the reaper already released as `expired` must now read
      // `escalated`, or the step and its lease tell two different stories (§BOOK-34).
      if (lease) stampEscalatedRelease(db, lease.id);
      report.stepWalls.push(step.step_id);
    } catch (error) {
      // One wedged step must not stop the tick (nor the boot): the lease, gate and lane passes
      // below still run, and the failure is a fact in the report instead of a swallowed throw.
      report.stepWallFailures.push({
        stepId: step.step_id,
        code: isEngineError(error) ? error.code : 'UNKNOWN',
      });
    }
  }

  // ── leases ────────────────────────────────────────────────────────────────
  for (const lease of store.expiredLeases(db, at)) {
    const step = store.getStep(db, lease.step_id);
    releaseLease(db, lease.id, 'expired', now);
    report.expiredLeases += 1;
    if (!step || step.outcome !== null) continue;

    const attempts = bumpAttempts(deps, lease.change_id);

    if (step.landed_at === null) {
      const target = step.pass === 'front' ? readFrontRows(deps.db) : null;
      const chapter = step.chapter === null ? null : readChapterRows(deps.db, step.chapter);
      // A basis-only slot is not a write: recovering the frame as "landed" would credit a
      // chapter nobody wrote (§BOOK-6).
      const written =
        step.pass === 'front'
          ? target !== null && target.sha256 !== step.start_sha
          : isWrittenChapter(chapter) && chapter.sha256 !== step.start_sha;
      if (step.start_sha !== null && written) {
        // The session wrote and died before `land`: the text is taken as landed and scored
        // from the file (§6A.11). No revision is duplicated — the file was written once.
        const revAfter = Math.max(
          step.chapter === null ? 0 : currentRev(db, step.chapter),
          (step.rev_before ?? 0) + 1,
        );
        store.updateStep(db, step.step_id, {
          landed_at: at,
          landed_sha: step.pass === 'front' ? (target?.sha256 ?? null) : (chapter?.sha256 ?? null),
          rev_after: revAfter,
        });
        appendEvent(
          db,
          { kind: 'step.landed', stepId: step.step_id, cascadeId: step.cascade_id, chapter: step.chapter, payload: { recovered: true, rev: revAfter } },
          now,
        );
        report.recovered.push(step.step_id);
        continue;
      }
      // §10.8 — the ladder: the third failure widens the requirements, the fourth widens them
      // once more (a paragraph, then the chapter), the fifth hands over to the desperate sixth.
      // Each widening is recorded on the step and re-issued, so the next `pass:accepted` names
      // the attempt it opens and the writer runs under the widened mode.
      const widening =
        attempts === 3 && step.widened === null
          ? { widened: 'wider-edit', mode: 'rewrite' as const }
          : attempts === 4 && step.widened === 'wider-edit'
            ? { widened: 'whole-chapter', mode: step.mode }
            : null;
      if (widening !== null) {
        store.updateStep(db, step.step_id, widening);
        // §10.8's scope widening: a change that failed three times is no longer a phrase —
        // the next attempt's scope is the chapter. The column is the public fact the card reads.
        const served = changeForStep(db, step);
        if (served !== undefined && served.scope_hint !== 'chapter') {
          store.updateChange(db, served.id, { scope_hint: 'chapter' });
        }
        appendEvent(
          db,
          { kind: 'step.opened', stepId: step.step_id, cascadeId: step.cascade_id, chapter: step.chapter, payload: { pass: step.pass, reissued: true, widened: widening.widened } },
          now,
        );
        report.reissued.push(step.step_id);
        continue;
      }
      if (attempts > 4 && step.desperate !== 1) {
        // §10.8: five ordinary attempts, then one desperate sixth, then the close. The step is
        // marked (the sixth is the same step, cheaper) and re-issued with its own short bound.
        store.updateStep(db, step.step_id, { desperate: 1 });
        appendEvent(
          db,
          { kind: 'step.opened', stepId: step.step_id, cascadeId: step.cascade_id, chapter: step.chapter, payload: { pass: step.pass, reissued: true, desperate: true } },
          now,
        );
        report.reissued.push(step.step_id);
        continue;
      }
      if (attempts > 4) {
        closeStep(
          deps,
          step.step_id,
          {
            outcome: 'escalated',
            seamsOut: [],
            note: 'the session did not bring the step back',
            model: null,
            tokensIn: 0,
            tokensOut: 0,
            escalation: 'escalated:gate_timeout',
          },
          now,
        );
        report.gateTimeouts.push(step.step_id);
        continue;
      }
      report.reissued.push(step.step_id);
      appendEvent(
        db,
        { kind: 'step.opened', stepId: step.step_id, cascadeId: step.cascade_id, chapter: step.chapter, payload: { pass: step.pass, reissued: true } },
        now,
      );
      continue;
    }

    // Landed, but the session vanished: the gates may continue under a fresh lease.
    if (attempts > 4) {
      closeStep(deps, step.step_id, {
        outcome: 'escalated',
        seamsOut: parseSeams(null),
        note: 'the session did not come back to close the step',
        model: null,
        tokensIn: 0,
        tokensOut: 0,
        escalation: 'escalated:gate_timeout',
      }, now);
      continue;
    }
    report.reissued.push(step.step_id);
  }

  // ── gates that never answered ─────────────────────────────────────────────
  // The window is the reading budget (`GATE_TTL_MS`), and the sentence says how long it was: an
  // operator reads a minute count, never a config name, and the code stays in the event payload.
  const gateTimeoutNote = `гейт не ответил за ${String(Math.round(deps.config.gateTtlMs / 60_000))} мин — проход остановлен`;
  const staleDispatches = db
    .prepare('SELECT * FROM gate_dispatches WHERE expires_at <= ?')
    .all(at) as Array<{ step_id: string; role: 'editor' | 'consultant' | 'rights' }>;
  for (const dispatch of staleDispatches) {
    const step = store.getStep(db, dispatch.step_id);
    store.deleteDispatch(db, dispatch.step_id, dispatch.role);
    if (!step || step.outcome !== null) continue;
    if (store.getVerdict(db, dispatch.step_id, dispatch.role)) continue;
    closeStep(deps, step.step_id, {
      outcome: 'escalated',
      seamsOut: parseSeams(null),
      note: gateTimeoutNote,
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      escalation: 'escalated:gate_timeout',
      changeReason: gateTimeoutNote,
    }, now);
    report.gateTimeouts.push(step.step_id);
  }

  // ── a lane whose holder died ──────────────────────────────────────────────
  const lane = store.readLane(db);
  if (lane.holder !== null) {
    const change = store.getChange(db, lane.holder);
    if (!change || change.status !== 'processing') {
      store.forceReleaseLane(db);
      report.laneReleased = lane.holder;
    } else {
      const stale = lane.heartbeat_at === null || now - Date.parse(lane.heartbeat_at) > deps.config.laneTtlMs;
      if (stale) {
        const open = store.stepsOfChange(db, change.id).filter((step) => step.outcome === null);
        if (open.length > 0) {
          // The work survives its process: the lane is reclaimed and the step is re-issued to
          // a session (its expired lease was already released above). Resetting the change here
          // would abandon a step that is still the honest state of the ripple (§6A.3).
          store.heartbeatLaneRow(db, change.id, at);
        } else {
          // Claimed, but no step was ever recorded: put it back in the queue.
          store.updateChange(db, change.id, { status: 'pending' });
          appendChangeEvent(db, change.id, 'released', { reason: 'lane expired, no step' }, now);
          store.forceReleaseLane(db);
          report.laneReleased = change.id;
        }
      }
    }
  }

  return report;
}
