/**
 * The site places what the container read (BOOK-206, ADR-045 §3, §5).
 *
 * The writer stores one validated `book.verdict/v1` on the filing's attempt row; this module
 * turns it into a disposition with the **existing** pure chooser (`feedback/disposition.ts`) and
 * places it with the **existing** `acceptComment` — in one transaction per filing, announced on
 * the sockets and the push outbox the site already owns. No timer of its own: it runs inside the
 * one-second decision interval (`index.ts`), which already exists.
 *
 * The ladder is total (ADR-045 §5): a filing either lands on a rung (and becomes a `pending`
 * change or a registered document) or it meets a lock (and is refused with the lock's own
 * clause). `escalated` is not an output of this path at all.
 *
 * Idempotence is the rows, not a flag: the query is `status='new' AND disposition IS NULL`, the
 * first placement writes both, and `acceptComment` no-ops on a `change_id` it already holds — so
 * a second poll, a restarted site or a second process changes nothing.
 */

import type { CommentDecisionPayload, DispositionReport } from '@book/shared';

import { countRows, safeJson } from '../engineState/rows.ts';
import { readQueue } from '../engineState/reader.ts';
import type { Db } from '../db/db.ts';
import { latestAttempt } from '../comments/attempts.ts';
import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { acceptComment } from './accept.ts';
import type { DecisionEmit } from './decisions.ts';
import type { DispositionProposal } from './disposition.ts';
import { chooseFor, disposeRejection, reportOfDecision, storedDecision } from './dispositionStore.ts';
import { settleAttempt } from './triage.ts';
import { parseReadingBlock, type TriageReading } from './triageReading.ts';

/** The most filings one tick places: a burst must not starve the site's other readers. */
export const TRIAGE_PLACE_LIMIT = 2;

export type TriageApplierOptions = {
  db: Db;
  emit: DecisionEmit;
  notify: (commentId: string, report: DispositionReport | null) => void;
  now?: () => Date;
  limit?: number;
};

type StoredVerdict = { verdict?: unknown; reading?: unknown };

/** The chooser's input, built from the stored reading — one place, so no field is invented. */
export function proposalOfReading(reading: TriageReading): DispositionProposal {
  const carrier = reading.carrier;
  const refusal = reading.refusal;
  return {
    disposition: reading.rung,
    carrierKind: carrier?.kind ?? null,
    quoteKept: carrier?.quoteKept ?? null,
    factsChanged: carrier?.factsChanged ?? 0,
    establishedFact: refusal?.establishedFact ?? null,
    namedPerson: refusal?.namedPerson ?? null,
    namedInstance: refusal?.namedInstance ?? null,
    cost: refusal?.cost ?? null,
    stamp: refusal?.stamp ?? null,
    lock: reading.lock,
  };
}

/**
 * The filings that have a stored verdict and no placement yet, oldest first.
 *
 * The attempt must still be **open** (`outcome = 'submitted'`): placing settles it, and a row
 * whose attempt was settled without a placement (a corrupt stored reading, a gate that has not
 * spoken) is a visible defect on the page — not a row this tick re-processes once a second.
 */
function duePlacements(db: Db, limit: number): string[] {
  return (
    db
      .prepare(
        `SELECT c.id AS id FROM comments c
          WHERE c.status = 'new' AND c.disposition IS NULL
            AND EXISTS (
              SELECT 1 FROM comment_attempts a
               WHERE a.comment_id = c.id AND a.verdict IS NOT NULL AND a.outcome = 'submitted'
                 AND a.n = (SELECT MAX(n) FROM comment_attempts WHERE comment_id = c.id)
            )
          ORDER BY c.created_at, c.id
          LIMIT ?`,
      )
      .all(limit) as Array<{ id: string }>
  ).map((row) => row.id);
}

function queueAhead(db: Db, changeId: string | null): number {
  if (changeId === null) return 0;
  const change = db.prepare('SELECT seq, premise FROM changes WHERE id = ?').get(changeId) as
    | { seq: number; premise: number }
    | undefined;
  if (change === undefined || change.premise === 1) return 0;
  return countRows(db, `SELECT COUNT(*) AS n FROM changes WHERE status = 'pending' AND premise = 0 AND seq < ?`, change.seq);
}

function nowOf(options: TriageApplierOptions): () => Date {
  return options.now ?? (() => new Date());
}

/** One `comment:decision` frame, the shape `DecisionsTailer` publishes. */
function emitDecision(
  options: TriageApplierOptions,
  row: CommentRow,
  status: CommentDecisionPayload['status'],
  report: DispositionReport | null,
  at: string,
): void {
  options.emit('comment:decision', {
    id: row.id,
    chapter: row.chapter,
    status,
    reason: row.reason ?? '',
    decidedAt: at,
    batchId: row.batch_id,
    changeId: row.change_id,
    queue: {
      depth: readQueue(options.db, nowOf(options)().getTime()).depth,
      ahead: queueAhead(options.db, row.change_id),
    },
    source: 'llm',
    report,
  } satisfies CommentDecisionPayload);
}

/**
 * Place one filing. Returns whether anything was written, so `poll` can count a tick honestly.
 * A row this function cannot place (a corrupt stored verdict, a gate that has not spoken) is
 * recorded as an event and its attempt settled `held` — the filing stays `new` and visible, and
 * the tick does not retry the same broken row forever.
 */
export function placeFiling(options: TriageApplierOptions, commentId: string): boolean {
  const { db } = options;
  const at = nowOf(options)().toISOString();
  const placed = db.transaction((): { row: CommentRow; status: CommentDecisionPayload['status'] } | null => {
    const row = readCommentRow(db, commentId);
    if (row === undefined || row.status !== 'new' || row.disposition !== null) return null;
    // Only the **latest** attempt is placed: a revision replaced the words and cleared the chain.
    // Only the **latest** attempt is placed, and only while it is still open: a settled attempt
    // was already answered (placed, held or refused) and this tick must not answer it again.
    const attempt = latestAttempt(db, commentId);
    if (attempt === undefined || attempt.outcome !== 'submitted') return null;
    const stored = attempt.verdict === null ? null : safeJson<StoredVerdict>(attempt.verdict);
    if (stored === null) return null;
    const verdict = stored.verdict === 'OFF' ? 'OFF' : 'FITS';
    const parsed = parseReadingBlock(stored.reading, verdict);
    if (!parsed.ok) {
      appendCommentEvent(db, commentId, 'triage.verdict-invalid', at, { code: parsed.code, attempt: attempt.n });
      settleAttempt(db, { commentId, chapter: row.chapter, outcome: 'held', at });
      return null;
    }

    const reading = parsed.reading;
    const decision = chooseFor(db, row, proposalOfReading(reading));
    if (decision.disposition === 'inadmissible') {
      // A lock is the only refusal: the chain, the status and the reader's line are the
      // rejection path's, and the decision travels with it — a finale lock the model named must
      // not be re-chosen from the row (that would lose the lock and escalate).
      disposeRejection(db, { comment: row, at, note: decision.reason, decision });
      settleAttempt(db, { commentId, chapter: row.chapter, outcome: 'refused', at });
      return { row: readCommentRow(db, commentId) ?? row, status: 'rejected' };
    }

    const accepted = acceptComment(db, {
      comment: row,
      intent: reading.intent,
      at,
      reason: decision.reason,
      decision,
    });
    if ('error' in accepted || 'escalated' in accepted) {
      // A gate that has not spoken is not this path's to answer; the filing keeps its row.
      appendCommentEvent(db, commentId, 'triage.not-placed', at, {
        code: 'error' in accepted ? accepted.code ?? 'REFUSED' : 'ESCALATED',
      });
      settleAttempt(db, { commentId, chapter: row.chapter, outcome: 'held', at });
      return null;
    }
    settleAttempt(db, { commentId, chapter: row.chapter, outcome: 'accepted', at });
    return { row: readCommentRow(db, commentId) ?? row, status: 'accepted' };
  })();

  if (placed === null) return false;
  const after = placed.row;
  const chain = storedDecision(after);
  const report = chain === null ? null : reportOfDecision(db, chain, after);
  emitDecision(options, after, placed.status, report, at);
  // BOOK-189: the answer the reader is owed, once — the same hook the decisions tailer uses.
  options.notify(commentId, report);
  return true;
}

/** One tick: at most `limit` filings, and nothing at all when none carries a verdict. */
export function poll(options: TriageApplierOptions): number {
  let placed = 0;
  for (const id of duePlacements(options.db, options.limit ?? TRIAGE_PLACE_LIMIT)) {
    if (placeFiling(options, id)) placed += 1;
  }
  return placed;
}
