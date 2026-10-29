/**
 * BOOK-DOC-84 §10.1 — `filing:reading`: one frame per attempt of one filing's reading.
 *
 * The engine writes the attempt as a `comment_events` row (`triage.claimed`, `triage.read`,
 * `triage.failed`, `triage.widened`); this builder turns **that row** into the frame, so the
 * number, the phase and the cursor are the row's own (`readingSeq = comment_events.id`). The
 * counters come from the attempt row the event names, never from a caller's guess.
 *
 * The same builder serves `live.reading` (a reconnect heals from the newest row, not from a
 * summary), and `comment:decision` keeps the sinks — one fact, one carrier.
 */

import {
  DESPERATE_ATTEMPT,
  MAX_ATTEMPTS,
  widenedWord,
  type FilingReadingPayload,
  type FilingReadingPhase,
  type WidenedNote,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { readingReasonOf } from './readingReason.ts';

export type ReadingEventRow = {
  id: number;
  comment_id: string;
  at: string;
  type: string;
  meta: string | null;
};

/** The four event types that owe a frame; anything else in `comment_events` is not a reading. */
export const READING_EVENTS = new Set([
  'triage.claimed',
  'triage.read',
  'triage.failed',
  'triage.widened',
  // BOOK-206 M4: a claim whose process died is a fact the page must hear (§10.3: «повтор» from
  // `triage.abandoned`), or a crashed writer silently freezes the head on «правку читают».
  'triage.abandoned',
]);

const PHASE_OF_EVENT: Record<string, FilingReadingPhase> = {
  'triage.claimed': 'claimed',
  'triage.read': 'read',
  'triage.failed': 'failed',
  'triage.widened': 'widened',
  'triage.abandoned': 'failed',
};

type AttemptRow = {
  n: number;
  tries: number;
  claim_until: string | null;
  next_at: string | null;
  verdict: string | null;
  widened: string | null;
  desperate: number;
};

type Meta = { attempt?: number; try?: number; code?: string; retryAt?: string; widened?: string };

function jsonMeta(raw: string | null): Meta | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === 'object' ? (value as Meta) : null;
  } catch {
    return null;
  }
}

function attemptOf(db: Db, commentId: string, n: number | null): AttemptRow | undefined {
  if (n === null) {
    return db
      .prepare(
        `SELECT n, tries, claim_until, next_at, verdict, widened, desperate
           FROM comment_attempts WHERE comment_id = ? ORDER BY n DESC LIMIT 1`,
      )
      .get(commentId) as AttemptRow | undefined;
  }
  return db
    .prepare(
      `SELECT n, tries, claim_until, next_at, verdict, widened, desperate
         FROM comment_attempts WHERE comment_id = ? AND n = ?`,
    )
    .get(commentId, n) as AttemptRow | undefined;
}

/** What one `read` cost: the ledger row the verdict wrote (`triage:<id>:<n>`), if priced. */
function readingCost(
  db: Db,
  commentId: string,
  n: number,
): { costUsd: number | null; estimated: boolean } {
  const row = db
    .prepare(
      `SELECT usd, priced, provenance FROM pass_spend
        WHERE pass_id LIKE ? ORDER BY at DESC, id DESC LIMIT 1`,
    )
    .get(`triage:${commentId}:${String(n)}%`) as
    | { usd: number; priced: number; provenance: string | null }
    | undefined;
  if (row === undefined || row.priced !== 1) return { costUsd: null, estimated: false };
  return { costUsd: row.usd, estimated: row.provenance === 'pipeline-estimated' };
}

/**
 * The frame for one reading event, or `null` when the row names no filing this page may narrate.
 * A hidden or withdrawn filing is never republished (BOOK-101).
 */
export function filingReadingPayload(db: Db, event: ReadingEventRow): FilingReadingPayload | null {
  const phase = PHASE_OF_EVENT[event.type];
  if (phase === undefined) return null;
  const comment = db
    .prepare('SELECT id, chapter, status FROM comments WHERE id = ?')
    .get(event.comment_id) as { id: string; chapter: number; status: string } | undefined;
  if (comment === undefined || comment.status === 'hidden') return null;
  const meta = jsonMeta(event.meta);
  const attemptRow = attemptOf(db, event.comment_id, meta?.attempt ?? null);
  if (attemptRow === undefined) return null;

  // §10.8 — a `failed` frame counts **the try that failed**, and only the desperate sixth is the
  // sink. The fifth failure marks the row `desperate` in the same transaction (`filingTriage.ts`),
  // but the ladder's fifth rung is still 5 of 5: the row's flag says the *next* rung is the last
  // one. So a failure reads its own `try`, and a phase that narrates the next attempt (claim,
  // answer, widening) keeps the row's flag.
  const desperate =
    phase === 'failed'
      ? meta?.try === DESPERATE_ATTEMPT
      : attemptRow.desperate === 1 || meta?.try === DESPERATE_ATTEMPT;
  const attempt = desperate
    ? DESPERATE_ATTEMPT
    : Math.max(1, Math.min(MAX_ATTEMPTS, meta?.try ?? attemptRow.tries));
  const code = attemptRow.widened ?? meta?.widened ?? null;
  const widened: WidenedNote | null =
    code === null ? null : { code: code as WidenedNote['code'], sentence: widenedWord(code) };
  const atMs = Date.parse(event.at);
  const retryIso = meta?.retryAt ?? attemptRow.next_at;
  const cost = phase === 'read' ? readingCost(db, event.comment_id, attemptRow.n) : { costUsd: null, estimated: false };

  return {
    commentId: comment.id,
    chapter: comment.chapter,
    phase,
    attempt,
    maxAttempts: desperate ? DESPERATE_ATTEMPT : Math.max(attempt, MAX_ATTEMPTS),
    widened,
    desperate,
    at: atMs,
    deadlineAt:
      phase === 'claimed' && attemptRow.claim_until !== null ? Date.parse(attemptRow.claim_until) : null,
    retryAt: phase === 'failed' && retryIso !== null ? Date.parse(retryIso) : null,
    reason:
      phase === 'failed'
        ? event.type === 'triage.abandoned'
          ? 'обрыв связи'
          : readingReasonOf(meta?.code)
        : null,
    costUsd: cost.costUsd,
    estimated: cost.estimated,
    readingSeq: event.id,
  };
}

/** The newest reading event of a filing still in flight, for `live.reading`. */
export function openReading(db: Db): FilingReadingPayload | null {
  const events = db
    .prepare(
      `SELECT e.id, e.comment_id, e.at, e.type, e.meta
         FROM comment_events e
         JOIN comments c ON c.id = e.comment_id
        WHERE e.type IN ('triage.claimed','triage.read','triage.failed','triage.widened','triage.abandoned')
          AND c.status = 'new' AND c.disposition IS NULL AND c.rights_verdict = 'CLEAR'
          AND e.id = (SELECT MAX(inner_e.id) FROM comment_events inner_e
                       WHERE inner_e.comment_id = e.comment_id
                         AND inner_e.type IN ('triage.claimed','triage.read','triage.failed','triage.widened','triage.abandoned'))
        ORDER BY e.at DESC, e.id DESC
        LIMIT 5`,
    )
    .all() as ReadingEventRow[];
  for (const event of events) {
    const payload = filingReadingPayload(db, event);
    if (payload === null) continue;
    // `read` means the answer landed: the filing is being placed, not read — that is the
    // placement's own work, not an open reading. A failed attempt whose retry is past is due
    // again and is still the open reading; its `retryAt` is the fact the page prints.
    if (payload.phase === 'read') continue;
    return payload;
  }
  return null;
}
