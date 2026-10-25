/**
 * The reaper (ARCHITECTURE.md §6A.11, §6B.4 rule 5, §6B.7).
 *
 * A dead session must never block a chapter, and a dead gate must never hold a step open
 * forever. Every 15 s (and at the start of every `next`) the engine expires leases, takes a
 * write that landed without being reported, re-issues a job whose session vanished, and
 * escalates a step whose gate never answered. Nothing is silently restarted: each action is
 * an event, so "the engine recovered" is auditable like everything else.
 */

import { parseSeams } from '@book/shared';

import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { toIso } from '../util/time.ts';
import { closeStep, currentRev } from './close.ts';
import { releaseLease } from './leases.ts';
import * as store from './store.ts';
import { readChapter, readFront } from './text.ts';
import type { EngineDeps } from './types.ts';

export type ReapReport = {
  at: string;
  expiredLeases: number;
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

export function reap(deps: EngineDeps, now: number = deps.clock.now()): ReapReport {
  const db = deps.db;
  const at = toIso(now);
  const report: ReapReport = {
    at,
    expiredLeases: 0,
    recovered: [],
    reissued: [],
    gateTimeouts: [],
    laneReleased: null,
  };

  // ── leases ────────────────────────────────────────────────────────────────
  for (const lease of store.expiredLeases(db, at)) {
    const step = store.getStep(db, lease.step_id);
    releaseLease(db, lease.id, 'expired', now);
    report.expiredLeases += 1;
    if (!step || step.outcome !== null) continue;

    const attempts = bumpAttempts(deps, lease.change_id);

    if (step.landed_at === null) {
      const target = step.pass === 'front' ? readFront(deps.bookRoot) : null;
      const chapter = step.chapter === null ? null : readChapter(deps.bookRoot, step.chapter);
      const written =
        step.pass === 'front'
          ? target !== null && target.sha256 !== step.start_sha
          : chapter !== null && chapter.blocks.length > 0 && chapter.sha256 !== step.start_sha;
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
      if (attempts > 2) {
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
      continue;
    }

    // Landed, but the session vanished: the gates may continue under a fresh lease.
    if (attempts > 2) {
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
  const staleDispatches = db
    .prepare('SELECT * FROM gate_dispatches WHERE expires_at <= ?')
    .all(at) as Array<{ step_id: string; role: 'editor' | 'consultant' }>;
  for (const dispatch of staleDispatches) {
    const step = store.getStep(db, dispatch.step_id);
    store.deleteDispatch(db, dispatch.step_id, dispatch.role);
    if (!step || step.outcome !== null) continue;
    if (store.getVerdict(db, dispatch.step_id, dispatch.role)) continue;
    closeStep(deps, step.step_id, {
      outcome: 'escalated',
      seamsOut: parseSeams(null),
      note: 'gate timeout',
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      escalation: 'escalated:gate_timeout',
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
