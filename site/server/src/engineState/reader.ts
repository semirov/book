/**
 * The site's read-only view of the engine's *process* state (ARCHITECTURE.md §6.1, §7.1,
 * §9, §10.3a, §18).
 *
 * Both processes open the same `book.db` in WAL mode. The engine is the only writer of
 * `changes`/`cascades`/`steps`/`gate_verdicts`/`leases`; this module never writes and never
 * selects `gate_verdicts` — a public payload cannot leak a finding it never reads (§6B.6).
 *
 * `readEngineOverlay` feeds the state snapshot (engine status, queue, ripple, unresolved
 * seams, the live lease) so a reload rebuilds exactly what the sockets were saying.
 */

import type {
  EngineHealthDto,
  QueueDto,
  SeamBoundary,
  StateSnapshot,
} from '@book/shared';
import { parseSeams } from '@book/shared';

import type { Db } from '../db/db.ts';
import {
  countRows,
  metaValue,
  safeJson,
  type CascadeRow,
  type ChangeRow,
  type LeaseRow,
  type StepRow,
} from './rows.ts';
import { wingsOf, wingSteps } from './wings.ts';

/** A heartbeat older than this means the process is gone, not slow (§18). */
export const HEARTBEAT_TTL_MS = 90_000;

/** The overlay `deriveState` applies on top of the files (§7.2). */
export type EngineOverlay = {
  fingerprint: string;
  engine: StateSnapshot['engine'];
  queue: StateSnapshot['queue'];
  cascade: StateSnapshot['cascade'];
  unresolved: StateSnapshot['unresolved'];
  current: StateSnapshot['current'];
};

// ── engine health and the queue ───────────────────────────────────────────────

/** `absent` = no process ever beat; `down` = it beat, then stopped (§9, §18). */
export function readEngineHealth(db: Db, nowMs: number): EngineHealthDto {
  const heartbeatAt = metaValue(db, 'engine.heartbeat');
  const lane = db.prepare('SELECT holder FROM lane WHERE id = 1').get() as { holder: string | null } | undefined;
  const laneId = lane?.holder ?? null;
  if (heartbeatAt === null) return { status: 'absent', heartbeatAt: null, laneId };

  const age = nowMs - Date.parse(heartbeatAt);
  if (Number.isNaN(age) || age > HEARTBEAT_TTL_MS) return { status: 'down', heartbeatAt, laneId };
  const reported = metaValue(db, 'engine.status');
  const status: EngineHealthDto['status'] =
    reported === 'paused' || reported === 'throttled' || reported === 'escalated' ? reported : 'running';
  return { status, heartbeatAt, laneId };
}

function stageOf(db: Db, changeId: string): string {
  // The live lease says what the lane is doing; an open step refines it to the pass.
  const live = db
    .prepare(
      `SELECT COALESCE(s.pass, l.kind) AS stage FROM leases l
         LEFT JOIN steps s ON s.step_id = l.step_id
        WHERE l.change_id = ? AND l.released_at IS NULL
        ORDER BY l.acquired_at DESC LIMIT 1`,
    )
    .get(changeId) as { stage: string } | undefined;
  return live?.stage ?? 'relevance';
}

/** The public headline `«4 замечания в очереди»` and the change card's position (§9). */
export function readQueue(db: Db, nowMs: number): QueueDto {
  const pending = countRows(db, `SELECT COUNT(*) AS n FROM changes WHERE status = 'pending'`);
  const processingRow = db
    .prepare(`SELECT * FROM changes WHERE status = 'processing' ORDER BY seq LIMIT 1`)
    .get() as ChangeRow | undefined;
  const head = db
    .prepare(`SELECT * FROM changes WHERE status = 'pending' ORDER BY seq LIMIT 1`)
    .get() as ChangeRow | undefined;
  const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const lastDecided = db
    .prepare(`SELECT MAX(finished_at) AS at FROM changes WHERE finished_at IS NOT NULL`)
    .get() as { at: string | null } | undefined;

  return {
    depth: pending,
    byState: {
      pending,
      processing: countRows(db, `SELECT COUNT(*) AS n FROM changes WHERE status = 'processing'`),
      stale: countRows(db, `SELECT COUNT(*) AS n FROM changes WHERE status = 'stale'`),
      escalated: countRows(db, `SELECT COUNT(*) AS n FROM changes WHERE status = 'escalated'`),
      done24h: countRows(db, `SELECT COUNT(*) AS n FROM changes WHERE status = 'done' AND finished_at >= ?`, dayAgo),
    },
    head:
      head === undefined
        ? null
        : {
            id: head.id,
            chapter: head.chapter,
            enqueuedAt: head.enqueued_at,
            waitMs: Math.max(0, nowMs - Date.parse(head.enqueued_at)),
          },
    processing:
      processingRow === undefined
        ? null
        : {
            id: processingRow.id,
            chapter: processingRow.chapter,
            startedAt: processingRow.started_at ?? processingRow.enqueued_at,
            stage: stageOf(db, processingRow.id),
          },
    lastDecidedAt: lastDecided?.at ?? null,
  };
}

export function stepsOfCascade(db: Db, cascadeId: string): StepRow[] {
  return db
    .prepare('SELECT * FROM steps WHERE cascade_id = ? ORDER BY seq')
    .all(cascadeId) as StepRow[];
}

/** The one open ripple, in the shape `state.cascade` and the ribbon use (§7.1, §11.7). */
export function readOpenCascade(db: Db): StateSnapshot['cascade'] {
  const cascade = db
    .prepare(`SELECT * FROM cascades WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1`)
    .get() as CascadeRow | undefined;
  if (cascade === undefined) return null;
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(cascade.change_id) as ChangeRow | undefined;
  if (change === undefined) return null;

  const steps = stepsOfCascade(db, cascade.id);
  const budget = safeJson<{ maxSteps?: number; maxWallMs?: number }>(cascade.budget) ?? {};
  const inFlight = steps.find((step) => step.outcome === null) ?? null;
  const lanes = steps.filter((step) => step.pass === 'cascade' && step.chapter !== null);
  const forward = lanes.filter((step) => step.lane === 'forward').map((step) => step.chapter as number);
  const backward = lanes.filter((step) => step.lane === 'backward').map((step) => step.chapter as number);
  const touched = new Set<number>([change.chapter]);
  for (const step of steps) if (step.chapter !== null) touched.add(step.chapter);
  const rewritten = new Set<number>();
  for (const step of steps) {
    if (step.chapter !== null && (step.outcome === 'rewritten' || step.outcome === 'published_with_finding')) {
      rewritten.add(step.chapter);
    }
  }
  const seams = new Map<SeamBoundary, string>();
  for (const step of steps) {
    for (const seam of parseSeams(safeJson(step.seams_out))) {
      if (!seams.has(seam.boundary)) seams.set(seam.boundary, seam.reason);
    }
  }
  const maxWallMs = budget.maxWallMs ?? 1_800_000;

  return {
    id: cascade.id,
    changeId: cascade.change_id,
    origin: change.chapter,
    wave: cascade.wave,
    frontier: {
      forward: forward.length > 0 ? Math.max(...forward) : change.chapter,
      backward: backward.length > 0 ? Math.min(...backward) : change.chapter,
    },
    wings: wingsOf(wingSteps(steps), change.chapter, cascade.status),
    touched: [...touched].sort((left, right) => left - right),
    rewritten: [...rewritten].sort((left, right) => left - right),
    seams: [...seams].map(([boundary, reason]) => ({ boundary, reason })),
    wing: inFlight === null ? null : inFlight.lane === 'backward' ? 'downward' : inFlight.lane === 'forward' ? 'upward' : null,
    lane: inFlight?.lane ?? null,
    stepChapter: inFlight === null ? null : inFlight.pass === 'front' ? 'front' : inFlight.chapter,
    startedAt: cascade.opened_at,
    budget: {
      steps: steps.length,
      maxSteps: budget.maxSteps ?? 8,
      deadline: new Date(Date.parse(cascade.opened_at) + maxWallMs).toISOString(),
    },
  };
}

/**
 * Seams a later change must repair: every escalated ripple, with the writer's own clause.
 * The site keeps them until a later change or a sweep closes them (§11.7) — a reload must
 * not make an unresolved seam disappear, and this is the source of the dashed rule.
 */
export function readUnresolved(db: Db): StateSnapshot['unresolved'] {
  const rows = db
    .prepare(
      `SELECT c.*, k.id AS cascade_key FROM changes c
         JOIN cascades k ON k.change_id = c.id AND k.status = 'escalated'
        ORDER BY c.seq`,
    )
    .all() as Array<ChangeRow & { cascade_key: string }>;

  const out: StateSnapshot['unresolved'] = [];
  for (const change of rows) {
    const steps = stepsOfCascade(db, change.cascade_key);
    const seams: Array<{ boundary: SeamBoundary; reason: string }> = [];
    for (const step of steps) {
      for (const seam of parseSeams(safeJson(step.seams_out))) {
        if (!seams.some((known) => known.boundary === seam.boundary)) seams.push(seam);
      }
    }
    const reason = unresolvedReason(change.outcome);
    const since = change.finished_at ?? change.started_at ?? change.enqueued_at;
    if (seams.length === 0) {
      const last = steps.at(-1);
      out.push({
        boundary: last === undefined ? boundaryOfChange(change.chapter) : boundaryFromStep(last),
        reason,
        changeId: change.id,
        since,
        note: null,
      });
      continue;
    }
    for (const seam of seams) {
      out.push({ boundary: seam.boundary, reason, changeId: change.id, since, note: seam.reason });
    }
  }
  return out;
}

function boundaryOfChange(chapter: number): SeamBoundary {
  return chapter === 1 ? 'front' : Math.max(2, chapter);
}

function boundaryFromStep(step: StepRow): SeamBoundary {
  if (step.pass === 'front') return 'front';
  if (step.chapter === null) return 'ending';
  return chapterBoundary(step.boundary, step.chapter);
}

function chapterBoundary(text: string, chapter: number): SeamBoundary {
  const numeric = Number.parseInt(text, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 67) return numeric === 1 ? 'front' : numeric;
  return chapter === 1 ? 'front' : Math.max(2, chapter);
}

function unresolvedReason(outcome: string | null): StateSnapshot['unresolved'][number]['reason'] {
  if (outcome === 'budget' || outcome === 'oscillation' || outcome === 'origin' || outcome === 'delta') return outcome;
  if (outcome === 'ending') return 'ending';
  if (outcome === 'gate_timeout') return 'gate_timeout';
  return 'finding';
}

/** The live lease, drawn as a state cursor; a cascade never moves a caret (§11.3). */
export function readCurrent(db: Db): StateSnapshot['current'] {
  const lease = db
    .prepare(`SELECT * FROM leases WHERE released_at IS NULL ORDER BY acquired_at DESC LIMIT 1`)
    .get() as LeaseRow | undefined;
  if (lease === undefined) return null;
  if (lease.is_front === 1) {
    return {
      lane: lease.lane ?? 'forward',
      chapter: 'front',
      kind: 'front',
      blockId: null,
      blockIndex: null,
      since: lease.acquired_at,
    };
  }
  if (lease.chapter === null || lease.lane === null) return null;
  return {
    lane: lease.lane,
    chapter: lease.chapter,
    kind: lease.kind,
    blockId: null,
    blockIndex: null,
    since: lease.acquired_at,
  };
}

/** Everything the snapshot needs from the engine, plus a cheap change detector. */
export function readEngineOverlay(db: Db, nowMs: number): EngineOverlay {
  const health = readEngineHealth(db, nowMs);
  const queue = readQueue(db, nowMs);
  const cascade = readOpenCascade(db);
  const unresolved = readUnresolved(db);
  const current = readCurrent(db);
  const fingerprint = JSON.stringify([
    health.status,
    health.heartbeatAt,
    health.laneId,
    queue.depth,
    queue.byState,
    queue.head?.id ?? null,
    queue.processing?.id ?? null,
    queue.lastDecidedAt,
    cascade?.id ?? null,
    cascade?.wave ?? null,
    cascade?.stepChapter ?? null,
    cascade?.touched ?? null,
    unresolved.map((entry) => [entry.changeId, entry.boundary]),
    current === null ? null : [current.chapter, current.kind, current.since],
  ]);
  return {
    fingerprint,
    engine: {
      status: health.status === 'absent' ? 'unknown' : health.status,
      heartbeatAt: health.heartbeatAt,
      laneId: health.laneId,
    },
    queue,
    cascade,
    unresolved,
    current,
  };
}
