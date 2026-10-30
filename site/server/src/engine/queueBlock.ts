/**
 * Why a claim got nothing (BOOK-235).
 *
 * Every guard in `claimHead` is silent, so from the writer a wedged queue and a busy one looked
 * exactly the same: «idle: пока нечего писать: заявок нет». This module names the guard a claim
 * stopped on, in the order `claimHead` asks them, decides whether the claim actually **reached**
 * the change (the queue's counter moves only then — `claimAttempts.ts`), and remembers which
 * lines the previous poll already said so a stuck queue cannot fill the log with one sentence.
 *
 * It sits beside `queue.ts` rather than inside it for the arch bound, and because the claim path
 * is not its only reader: the sweep and the operator's report speak the same vocabulary.
 */

import type { WriterAssignment } from '@book/shared';

import type { Db } from '../db/db.ts';
import { processingChange } from './helpers.ts';
import * as store from './store.ts';
import { isProcessingGhost } from './zombieSweep.ts';
import type { EngineDeps } from './types.ts';

/**
 * The guard a claim stopped on. `condition` is a machine code, `detail` the row it names in a log
 * line, and `ownerId` the **change that owns the blocking row** — the lane's holder, the ghost,
 * the cascade's change, or the head itself for its own step. `ownerId` is what a heal must be
 * narrowed to: sweeping the head because somebody else's cascade is open would repair nothing and
 * then count an attempt against the wrong filing.
 *
 * `reached` is whether the claim got as far as this change: a held lane, a live pass and a foreign
 * ripple never do, so none of them is this filing's attempt (`claimAttempts.ts` — «nothing was
 * asked of the engine and nothing was refused»). `capacity` is the one refusal that is the
 * **engine's** state rather than the row's: it counts once for the head of the poll and stops the
 * poll, so a saturated engine never spends the whole queue's six attempts at once.
 */
export type QueueBlock = {
  condition:
    | 'lane_held'
    | 'processing_live'
    | 'processing_ghost'
    | 'open_cascade'
    | 'open_step'
    /** The engine's own caps refused the lease — a fact of the poll, not of this change. */
    | 'capacity'
    | 'claim_lost';
  detail: string | null;
  ownerId: string | null;
  reached: boolean;
};

/** The blocks the zombie sweep can repair; the rest belong to a live pass or to the lane. */
export const SWEEP_OWNED: ReadonlySet<string> = new Set(['processing_ghost', 'open_cascade', 'open_step']);

/**
 * The row the claim stopped on, in `claimHead`'s own order: the lane, a pass, a ripple, the
 * change's open step — and `claim_lost` when every guard passed and the mutex did not.
 */
export function queueBlockOf(deps: EngineDeps, change: store.ChangeRow): QueueBlock {
  const { db } = deps;
  // A claim counts against the change only when the block is that change's own row.
  const own = (ownerId: string | null): boolean => ownerId !== null && ownerId === change.id;
  const lane = store.readLane(db);
  if (lane.holder !== null) {
    // A held lane is work in flight: the status tells a live pass from a lane nobody released.
    const holder = store.getChange(db, lane.holder);
    return {
      condition: 'lane_held',
      detail: `${lane.holder} · ${holder?.status ?? 'missing'}`,
      ownerId: lane.holder,
      reached: false,
    };
  }
  const processing = processingChange(db);
  if (processing !== undefined) {
    // A live pass is never an attempt; a ghost is this change's own row only if it *is* the
    // change (a pending change is never `processing`, so in practice it is another row's).
    const ghost = isProcessingGhost(db, processing);
    return {
      condition: ghost ? 'processing_ghost' : 'processing_live',
      detail: processing.id,
      ownerId: processing.id,
      reached: ghost && own(processing.id),
    };
  }
  const cascade = store.getOpenCascade(db);
  if (cascade !== undefined) {
    return { condition: 'open_cascade', detail: cascade.id, ownerId: cascade.change_id, reached: own(cascade.change_id) };
  }
  const open = store.stepsOfChange(db, change.id).find((step) => step.outcome === null);
  if (open !== undefined) {
    // A step with a live lease is a pass in flight: it blocks the claim and it is not this
    // change's attempt — somebody is working it right now.
    const live = store.liveLeaseForStep(db, open.step_id) !== undefined;
    return { condition: 'open_step', detail: open.step_id, ownerId: change.id, reached: !live };
  }
  return { condition: 'claim_lost', detail: null, ownerId: null, reached: true };
}

/** The one line a block is worth: ids and the condition, never a sentence. */
export function blockLine(changeId: string, block: QueueBlock): string {
  const detail = block.detail === null ? '' : ` (${block.detail})`;
  return `queue: change ${changeId} cannot be claimed — ${block.condition}${detail}`;
}

/**
 * The queue behind a wedged head is not wedged itself: the same claim, one pending change at a
 * time, in FIFO order. `claim` is `claimHeadOf` clamped to one row; the global guards still run
 * inside it, so this can never jump a live pass or a held lane.
 *
 * `refused` is the poll's own capacity answer: the process and step caps belong to the engine,
 * not to any one row, so the first refusal ends the walk — the queue behind a saturated engine is
 * never spent, change by change, on a machine that cannot take any of them.
 */
export function claimBehind(
  db: Db,
  blocked: store.ChangeRow,
  claim: (change: store.ChangeRow) => WriterAssignment | null,
  refused: () => boolean = () => false,
): WriterAssignment | null {
  for (const candidate of store.listPending(db)) {
    if (candidate.premise === 1 || candidate.id === blocked.id) continue;
    const claimed = claim(candidate);
    if (claimed !== null) return claimed;
    if (refused()) return null;
  }
  return null;
}

export type QueueLog = {
  /** Start a poll: only the lines of the previous poll may not be said again. */
  begin: () => void;
  /** Say the lines this poll has not said yet, once each. */
  report: (lines: string[]) => void;
};

/**
 * One line per fact per poll, and never the same line twice in a row: the writer polls every
 * pause, and a queue waiting to be healed must not fill the log with one repeated sentence.
 *
 * A poll reports in several calls (the block, then what the heal changed, then the block again),
 * so the emitted lines are accumulated until the next `begin` — a line is said once inside a poll
 * and not repeated across two successive ones, however many times the caller asks for it.
 */
export function createQueueLog(deps: EngineDeps): QueueLog {
  let previous: ReadonlySet<string> = new Set();
  let emitted = new Set<string>();
  return {
    begin: (): void => {
      previous = emitted;
      emitted = new Set<string>();
    },
    report: (lines: string[]): void => {
      for (const line of lines) {
        if (previous.has(line) || emitted.has(line)) continue;
        emitted.add(line);
        deps.log?.(line);
      }
    },
  };
}
