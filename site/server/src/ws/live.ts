/**
 * BOOK-DOC-84 §2.2 — the `live` block: one builder, two carriers (`hello`, `state:snapshot`).
 *
 * It is what a reader who joins mid-pass needs and what the snapshot must heal: the open passes
 * with their stage, the write that is still inside its 6 s print window, the queue's waiting
 * filings, the viewer's own filings and the lane's day. Nothing here is a promise about work: a
 * pass with no stage row reads `queued`, an absent print is `null`, and an unreadable pre-image
 * carries no span (the page then prints nothing).
 *
 * `live.filings` needs the viewer's internal identity, so the hub resolves it at upgrade and
 * keeps it on the connection; it never reaches the wire (§2.2).
 */

import {
  DESPERATE_ATTEMPT,
  LIVE_APPLIED_MAX_BYTES,
  LIVE_APPLIED_WINDOW_MS,
  LIVE_FILINGS_MAX,
  MAX_ATTEMPTS,
  STAGE_DEADLINE_MS,
  widenedWord,
  type GateName,
  type Lane,
  type LiveApplied,
  type LiveCost,
  type LiveFiling,
  type LivePass,
  type LivePayload,
  type PatchOp,
  type WidenedNote,
} from '@book/shared';
import { ATTEMPTS_PER_FILING_DAY } from '../comments/attempts.ts';
import type { Db } from '../db/db.ts';
import { filingStateOf } from '../comments/filingState.ts';
import { readApplied } from '../engineState/applied.ts';
import { readLaneDay, readQueue } from '../engineState/reader.ts';
import { patchSize } from '../ingest/patchBlocks.ts';
import { openReading } from '../feedback/readingFrame.ts';

export type LiveDeps = {
  db: Db;
  dataDir: string;
  now: () => number;
  queueSoftCap: number;
  /** The lane's own `WRITER_MAX_PASSES_PER_DAY`, announced, never enforced here. */
  maxPasses: number;
};

type StepRow = {
  step_id: string;
  chapter: number | null;
  pass: string;
  lane: Lane | null;
  change_id: string | null;
  premise_change: string | null;
  at: string;
  closed_at: string | null;
  cycle: number;
  desperate: number;
  widened: string | null;
};

type StageRow = {
  stage: string;
  stage_seq: number;
  at: string;
  gate: string | null;
  round: number | null;
  iteration: number | null;
  attempt: number | null;
  max_attempts: number | null;
  desperate: number;
  widened: string | null;
};

/** Open steps, oldest first: the engine opens at most one step per chapter. */
function openPasses(deps: LiveDeps): LivePass[] {
  // `steps` names no change: its lease or its cascade does (a draft's premise is its own row).
  const steps = deps.db
    .prepare(
      `SELECT s.step_id, s.chapter, s.pass, s.lane, s.premise_change, s.at, s.closed_at,
              s.cycle, s.desperate, s.widened,
              COALESCE(
                (SELECT l.change_id FROM leases l
                  WHERE l.step_id = s.step_id AND l.change_id IS NOT NULL
                  ORDER BY l.acquired_at DESC LIMIT 1),
                (SELECT c.change_id FROM cascades c WHERE c.id = s.cascade_id),
                s.premise_change) AS change_id
         FROM steps s WHERE s.closed_at IS NULL ORDER BY s.at`,
    )
    .all() as StepRow[];
  const stageOf = deps.db.prepare(
    `SELECT stage, stage_seq, at, gate, round, iteration, attempt, max_attempts, desperate, widened
       FROM pass_stages WHERE pass_id = ? ORDER BY stage_seq DESC LIMIT 1`,
  );
  const leases = deps.db.prepare('SELECT COUNT(*) AS n FROM leases WHERE step_id = ?');
  const passes: LivePass[] = [];
  for (const step of steps) {
    // `sweep` is an operator pass with no reader surface; the five public kinds are the rest.
    if (step.pass !== 'draft' && step.pass !== 'change' && step.pass !== 'cascade' && step.pass !== 'front' && step.pass !== 'ending') {
      continue;
    }
    const stage = stageOf.get(step.step_id) as StageRow | undefined;
    const since = Date.parse(stage?.at ?? step.at);
    const leaseCount = (leases.get(step.step_id) as { n: number }).n;
    const desperate = step.desperate === 1 || stage?.desperate === 1;
    const attempt = desperate ? DESPERATE_ATTEMPT : Math.max(1, Math.min(MAX_ATTEMPTS, stage?.attempt ?? leaseCount));
    const widened: WidenedNote | null =
      (stage?.widened ?? step.widened) === null
        ? null
        : { code: (stage?.widened ?? step.widened) as WidenedNote['code'], sentence: widenedWord((stage?.widened ?? step.widened) as string) };
    passes.push({
      chapter: step.chapter ?? 'front',
      passId: step.step_id,
      changeId: step.change_id,
      lane: step.lane,
      stage: stage?.stage ?? 'queued',
      stageSeq: stage?.stage_seq ?? 0,
      since,
      deadlineAt: since + STAGE_DEADLINE_MS,
      attempt,
      maxAttempts: desperate ? DESPERATE_ATTEMPT : Math.max(attempt, MAX_ATTEMPTS),
      gate: (stage?.gate ?? null) as GateName | null,
      round: stage?.round ?? null,
      iteration: stage?.iteration ?? step.cycle,
      widened,
      desperate,
    });
  }
  return passes;
}

/** The last write, if a pass made it and it is still inside its print window and small enough. */
function appliedWithin(deps: LiveDeps, nowMs: number): LiveApplied | null {
  const row = deps.db
    .prepare('SELECT chapter, rev, step_id FROM revisions ORDER BY rowid DESC LIMIT 1')
    .get() as { chapter: number; rev: number; step_id: string | null } | undefined;
  if (row === undefined) return null;
  // BOOK-220 m9 — only a pass's write prints: an import, a restore or an operator's revision
  // carries no step, and a fresh page must not join an ink no pass laid (`chapter:applied` for
  // such a row is a cross-fade by design, never a print).
  if (row.step_id === null) return null;
  const read = readApplied({ db: deps.db, dataDir: deps.dataDir, chapter: row.chapter, rev: row.rev });
  if (read === null) return null;
  if (nowMs - read.appliedAt > LIVE_APPLIED_WINDOW_MS) return null;
  if (read.patchTruncated) return null;
  if (patchSize(read.patch as PatchOp[]) > LIVE_APPLIED_MAX_BYTES) return null;
  return {
    n: read.n,
    rev: read.rev,
    appliedAt: read.appliedAt,
    patch: read.patch,
    patchTruncated: read.patchTruncated,
    span: read.span,
  };
}

type FilingRow = {
  id: string;
  chapter: number;
  status: string;
  change_id: string | null;
  created_at: string;
  attempts: number;
  attempts_today: number;
};

/** The viewer's own filings, newest first, with their attempt counter (§2.2). */
function viewerFilings(deps: LiveDeps, identityId: string | null, nowMs: number): LiveFiling[] {
  if (identityId === null) return [];
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = deps.db
    .prepare(
      `SELECT c.id, c.chapter, c.status, c.change_id, c.created_at,
              (SELECT COUNT(*) FROM comment_attempts a WHERE a.comment_id = c.id) AS attempts,
              (SELECT COUNT(*) FROM comment_attempts a WHERE a.comment_id = c.id AND a.at >= ?) AS attempts_today
         FROM comments c WHERE c.identity_id = ?
        ORDER BY c.created_at DESC LIMIT ?`,
    )
    .all(dayStart.toISOString(), identityId, LIVE_FILINGS_MAX) as FilingRow[];
  return rows.map((row) => ({
    commentId: row.id,
    chapter: row.chapter,
    state: filingStateOf(row.status),
    attempts: row.attempts,
    attemptsLeft: Math.max(0, ATTEMPTS_PER_FILING_DAY - row.attempts_today),
    changeId: row.change_id,
    at: row.created_at,
  }));
}

/** §10.4 — the last closed unit's price and the UTC day's total, from the one money ledger. */
function lastCost(deps: LiveDeps, nowMs: number): LiveCost | null {
  const row = deps.db
    .prepare('SELECT pass_id, at, usd, priced, provenance FROM pass_spend ORDER BY at DESC, id DESC LIMIT 1')
    .get() as { pass_id: string; at: string; usd: number; priced: number; provenance: string | null } | undefined;
  if (row === undefined || row.priced !== 1) return null;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const total = deps.db
    .prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM pass_spend WHERE day = ? AND priced = 1')
    .get(day) as { usd: number };
  return {
    kind: row.pass_id.startsWith('triage:') ? 'reading' : 'pass',
    usd: row.usd,
    at: Date.parse(row.at),
    estimated: row.provenance === 'pipeline-estimated',
    dayUsd: total.usd,
  };
}

/** The whole block, built from rows only. */
export function liveSnapshot(deps: LiveDeps, identityId: string | null): LivePayload {
  const nowMs = deps.now();
  const queue = readQueue(deps.db, nowMs, { pendingLimit: deps.queueSoftCap });
  const reading = openReading(deps.db);
  return {
    at: new Date(nowMs).toISOString(),
    passes: openPasses(deps),
    // §10.1: the fields a reconnect rebuilds the word from — `since` is the row's own `at`.
    reading:
      reading === null
        ? null
        : {
            commentId: reading.commentId,
            chapter: reading.chapter,
            phase: reading.phase,
            attempt: reading.attempt,
            maxAttempts: reading.maxAttempts,
            widened: reading.widened,
            desperate: reading.desperate,
            since: reading.at,
            deadlineAt: reading.deadlineAt,
            retryAt: reading.retryAt,
            reason: reading.reason,
          },
    lastCost: lastCost(deps, nowMs),
    applied: appliedWithin(deps, nowMs),
    queue: { depth: queue.depth, pending: queue.pending ?? [] },
    filings: viewerFilings(deps, identityId, nowMs),
    lane: readLaneDay(deps.db, nowMs, deps.maxPasses),
  };
}
