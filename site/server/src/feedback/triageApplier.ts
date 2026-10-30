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
 * Idempotence is the rows, not a flag: the query is `status='new' AND disposition IS NULL` with a
 * verdict and Gate B's clearance, the first placement writes both, and `acceptComment` no-ops on
 * a `change_id` it already holds — so a second poll, a restarted site or a second process changes
 * nothing. Every way of *not* placing is bounded too: a gate that has not spoken parks the row for
 * six hours with one event, and an answer the applier cannot place is asked once more and then
 * refused (`defect`) — a broken row never waits on the page as «ждёт».
 */

import { TRIAGE_REFUSED_LINE, type CommentDecisionPayload } from '@book/shared';

import { countRows, safeJson } from '../engineState/rows.ts';
import { readQueue } from '../engineState/reader.ts';
import type { Db } from '../db/db.ts';
import { attemptCounts } from '../comments/attemptToday.ts';
import { TRIAGE_MODEL_TRIES, TRIAGE_MAX_TRIES, latestAttempt, refuseTriage } from '../comments/triage.ts';
import { filingStateOf } from '../comments/filingState.ts';
import { emitFilingUpdate } from './filingFrame.ts';
import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { acceptComment } from './accept.ts';
import type { DecisionEmit } from './decisions.ts';
import type { DispositionProposal } from './disposition.ts';
import { chooseFor, disposeRejection, lineOfDecision, storedDecision } from './dispositionStore.ts';
import { settleAttempt } from './triage.ts';
import { parseReadingBlock, type TriageReading } from './triageReading.ts';

/** The most filings one tick places: a burst must not starve the site's other readers. */
export const TRIAGE_PLACE_LIMIT = 2;

export type TriageApplierOptions = {
  db: Db;
  emit: DecisionEmit;
  notify: (commentId: string, reason: string | null) => void;
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
 * whose attempt was settled without a placement (a corrupt stored reading, a gate that never
 * cleared) is a visible defect on the page — not a row this tick re-processes once a second.
 * Gate B's clearance is asked here as well as in `dueTriage`: a filing whose rights verdict is
 * missing waits on the operator's surface, not in this query.
 */
function duePlacements(db: Db, limit: number): string[] {
  return (
    db
      .prepare(
        `SELECT c.id AS id FROM comments c
          WHERE c.status = 'new' AND c.disposition IS NULL AND c.rights_verdict = 'CLEAR'
            AND EXISTS (
              SELECT 1 FROM comment_attempts a
               WHERE a.comment_id = c.id AND a.verdict IS NOT NULL
                 AND (a.outcome = 'submitted' OR (a.outcome = 'held' AND a.tries >= ?))
                 AND a.n = (SELECT MAX(n) FROM comment_attempts WHERE comment_id = c.id)
            )
          ORDER BY c.created_at, c.id
          LIMIT ?`,
      )
      .all(TRIAGE_MAX_TRIES, limit) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** Six hours: how long a filing waits for a gate to speak before the applier asks again. */
export const TRIAGE_GATE_WAIT_MS = 6 * 60 * 60_000;

/** One event per attempt: a tick cannot turn a standing fact into a stream of rows. */
function appendOnce(
  db: Db,
  commentId: string,
  type: string,
  at: string,
  meta: { code?: string; attempt: number; try?: number } & Record<string, unknown>,
): void {
  const prior = db
    .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = ?`)
    .all(commentId, type) as Array<{ meta: string | null }>;
  const seen = prior.some((event) => {
    try {
      const stored = JSON.parse(event.meta ?? '{}') as { attempt?: number; try?: number };
      if (stored.attempt !== meta.attempt) return false;
      // §10.8: a ladder's failures share the attempt number, and the **try** is what tells the
      // fifth from the desperate sixth — one frame per try, or the sink is swallowed by the
      // failure that armed it (BOOK-220 M1).
      return meta.try === undefined || stored.try === meta.try;
    } catch {
      return false;
    }
  });
  if (!seen) appendCommentEvent(db, commentId, type, at, meta);
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

/**
 * Close the attempt the placement answered. A `held` attempt (the recovery pass) is not open in
 * `settleAttempt`'s sense; it is closed here by the same one-write rule, so a successful recovery
 * does not leave a held attempt behind a placed filing.
 */
function settlePlaced(
  db: Db,
  row: CommentRow,
  n: number,
  outcome: 'accepted' | 'refused',
  at: string,
  recover: boolean,
): void {
  if (settleAttempt(db, { commentId: row.id, chapter: row.chapter, outcome, at }) !== null) return;
  if (!recover) return;
  db.prepare(
    `UPDATE comment_attempts SET outcome = ?, decided_at = ?
      WHERE comment_id = ? AND n = ? AND outcome = 'held'`,
  ).run(outcome, at, row.id, n);
}

/** One `comment:decision` frame, the shape `DecisionsTailer` publishes. */
function emitDecision(
  options: TriageApplierOptions,
  row: CommentRow,
  /** The row's own word after the write: `accepted`, `registered` (paperwork) or `rejected`. */
  status: 'accepted' | 'registered' | 'rejected',
  at: string,
): void {
  const nowMs = nowOf(options)().getTime();
  options.emit('comment:decision', {
    id: row.id,
    chapter: row.chapter,
    status,
    reason: row.reason ?? '',
    decidedAt: at,
    batchId: row.batch_id,
    changeId: row.change_id,
    queue: {
      depth: readQueue(options.db, nowMs).depth,
      ahead: queueAhead(options.db, row.change_id),
    },
    source: 'llm',
    // BOOK-DOC-84 #19: the record line prints the tries left from the frame itself.
    attemptsLeft: attemptCounts(options.db, row.id, nowMs).attemptsLeft,
    at: Date.parse(at),
  } satisfies CommentDecisionPayload);
  // BOOK-DOC-84 #17: the filing's own row — accepted, registered or refused — as a frame.
  emitFilingUpdate(options.db, options.emit, {
    commentId: row.id,
    chapter: row.chapter,
    state: filingStateOf(status),
    changeId: row.change_id,
    at: Date.parse(at),
  });
}

/**
 * Settle an attempt the applier cannot place: one event, `held`, and the tries moved to the cap,
 * so the row is a visible defect (`attempt: 'failed'`) instead of a row this tick re-processes
 * every second. Returns nothing — every caller answers `false`.
 */
function defect(
  db: Db,
  row: CommentRow,
  attempt: number,
  at: string,
  type: string,
  code: string,
  recover: boolean,
): void {
  appendOnce(db, row.id, type, at, { code, attempt });
  db.prepare('UPDATE comment_attempts SET tries = ? WHERE comment_id = ? AND n = ?').run(
    TRIAGE_MAX_TRIES,
    row.id,
    attempt,
  );
  if (!recover) {
    settleAttempt(db, { commentId: row.id, chapter: row.chapter, outcome: 'held', at });
    return;
  }
  // The answer was asked twice and still cannot be placed: the refusal sink, in our own words.
  if (!refuseTriage(db, { commentId: row.id, n: attempt, at, unplaced: true })) return;
  appendCommentEvent(db, row.id, 'triage.failed', at, {
    code: 'TRIAGE_UNPLACED',
    attempt,
    try: TRIAGE_MAX_TRIES,
    of: TRIAGE_MAX_TRIES,
    cap: true,
    retryAt: null,
    reason: TRIAGE_REFUSED_LINE,
  });
}

/**
 * Place one filing. Returns whether anything was written, so `poll` can count a tick honestly.
 *
 * Three answers are possible and only one of them is a placement:
 *
 *   · a rung — the reading lands (`acceptComment` wrote a change and a chain) or a lock refuses
 *     the row (`disposeRejection`): the attempt is settled and the frame is announced;
 *   · a gate that has not spoken — `RIGHTS_REQUIRED`/`QUARANTINED`: **nothing is settled**, one
 *     `triage.waiting-gate` event is written per attempt and the row is parked for six hours. The
 *     later clearance re-arms it, because the query asks for `rights_verdict = 'CLEAR'`;
 *   · a broken row — a corrupt stored verdict, an unreadable reading, `AUDIT_REQUIRED` for an
 *     answer that was stored as though it had one: one event, `held`, tries at the cap. Visible
 *     as a defect, never silent, never a loop.
 */
export function placeFiling(options: TriageApplierOptions, commentId: string): boolean {
  const { db } = options;
  const nowMs = nowOf(options)().getTime();
  const at = new Date(nowMs).toISOString();
  const placed = db.transaction((): { row: CommentRow; status: 'accepted' | 'registered' | 'rejected' } | null => {
    const row = readCommentRow(db, commentId);
    if (row === undefined || row.status !== 'new' || row.disposition !== null) return null;
    // Only the **latest** attempt is placed, and only while it is still open: a settled attempt
    // was already answered (placed, held or refused) and this tick must not answer it again.
    const attempt = latestAttempt(db, commentId);
    if (attempt === undefined) return null;
    const recover = attempt.outcome === 'held' && attempt.tries >= TRIAGE_MAX_TRIES;
    if (attempt.outcome !== 'submitted' && !recover) return null;
    // A verdict that is not one object is a broken row, not a reason to retry once a second.
    const stored = attempt.verdict === null ? null : safeJson<StoredVerdict>(attempt.verdict);
    if (stored === null) {
      defect(db, row, attempt.n, at, 'triage.verdict-invalid', 'VERDICT_UNREADABLE', recover);
      return null;
    }
    const verdict = stored.verdict === 'OFF' ? 'OFF' : 'FITS';
    const parsed = parseReadingBlock(stored.reading, verdict);
    if (!parsed.ok) {
      defect(db, row, attempt.n, at, 'triage.verdict-invalid', parsed.code, recover);
      return null;
    }

    const reading = parsed.reading;
    // §10.8: a widened attempt runs a rung wider — an `as_said` reading is proposed as
    // `through_paper`, and the chooser still decides whether the carrier licenses it.
    const proposal = proposalOfReading(reading);
    const widened = attempt.widened !== null;
    const decision = chooseFor(
      db,
      row,
      widened && proposal.disposition === 'as_said' ? { ...proposal, disposition: 'through_paper' } : proposal,
    );
    if (decision.disposition === 'inadmissible') {
      // A lock is the only refusal: the chain, the status and the reader's line are the
      // rejection path's, and the decision travels with it — a finale lock the model named must
      // not be re-chosen from the row (that would lose the lock and escalate).
      disposeRejection(db, { comment: row, at, note: decision.reason, decision });
      settlePlaced(db, row, attempt.n, 'refused', at, recover);
      return { row: readCommentRow(db, commentId) ?? row, status: 'rejected' };
    }

    const accepted = acceptComment(db, {
      comment: row,
      intent: reading.intent,
      at,
      reason: decision.reason,
      decision,
    });
    if ('error' in accepted) {
      const code = accepted.code ?? 'REFUSED';
      if (code === 'RIGHTS_REQUIRED' || code === 'QUARANTINED') {
        // Gate B has not cleared it (or Gate A holds it): a model read was bought for a row the
        // operator still has to clear, and the answer waits. The attempt stays open, one event
        // says why, and the row is not asked for again until the six hours pass — or immediately
        // after the verdict is recorded, because the query reads `rights_verdict`.
        appendOnce(db, row.id, 'triage.waiting-gate', at, { code, attempt: attempt.n });
        db.prepare('UPDATE comment_attempts SET next_at = ? WHERE comment_id = ? AND n = ?').run(
          new Date(nowMs + TRIAGE_GATE_WAIT_MS).toISOString(),
          row.id,
          attempt.n,
        );
        return null;
      }
      // A verdict was stored, so the audit must have spoken; a caller that gets here is a defect.
      defect(db, row, attempt.n, at, 'triage.defect', code, recover);
      return null;
    }

    const after = readCommentRow(db, commentId) ?? row;
    if (after.status === 'new' || after.disposition === null) {
      // `acceptComment` answered without writing a chain and a status: the filing was not placed,
      // and nothing may be announced — a push here would tell the reader «отклонена» for a row
      // nobody refused and nobody placed.
      defect(db, row, attempt.n, at, 'triage.not-placed', 'PLACEMENT_EMPTY', recover);
      return null;
    }
    settlePlaced(db, row, attempt.n, 'accepted', at, recover);
    return { row: after, status: after.status === 'registered' ? 'registered' : 'accepted' };
  })();

  if (placed === null) return false;
  const after = placed.row;
  const chain = storedDecision(after);
  const line = chain === null ? null : lineOfDecision(chain);
  emitDecision(options, after, placed.status, at);
  // BOOK-206 M9: a push at placement is owed only where no change speaks for the filing — a lock
  // refusal (it never becomes a change) and paperwork (its document is not the chapter's text).
  // An accepted filing is announced by its change's own decision push when the chapter lands;
  // pushing here spent the (identity, chapter) claim and swallowed «глава N написана».
  if (placed.status !== 'accepted') options.notify(commentId, line);
  return true;
}

/**
 * §10.8 — the deterministic sixth attempt.
 *
 * The five bought calls are the ladder's ceiling. A filing the engine marked `desperate` gets
 * **no new reasoning**: if a reading was stored, the ordinary placement above consumes it under
 * the widened rules; if none was, the row is settled as a visible defect (`held`) with the sixth
 * try on record — one event, one `filing:reading{failed, attempt 6, desperate}`, and the site's
 * queue moves on. It is not a refusal: a refusal is a lock, and a reading that never arrived
 * named none (§10.3: the defect state, never a fourth resting word).
 */
function settleDesperate(options: TriageApplierOptions, commentId: string): boolean {
  const { db } = options;
  const at = nowOf(options)().toISOString();
  const done = db.transaction((): boolean => {
    const row = readCommentRow(db, commentId);
    if (row === undefined || row.status !== 'new' || row.disposition !== null) return false;
    const attempt = latestAttempt(db, commentId);
    if (attempt === undefined || attempt.outcome !== 'submitted' || attempt.desperate !== 1) return false;
    // A stored reading is placed by the ordinary path, not here.
    if (attempt.verdict !== null) return false;
    appendOnce(db, commentId, 'triage.failed', at, {
      code: 'DESPERATE',
      attempt: attempt.n,
      try: TRIAGE_MODEL_TRIES + 1,
      desperate: true,
      cap: true,
    });
    settleAttempt(db, { commentId, chapter: row.chapter, outcome: 'held', at });
    db.prepare('UPDATE comment_attempts SET tries = ?, desperate = 1 WHERE comment_id = ? AND n = ?').run(
      TRIAGE_MODEL_TRIES + 1,
      commentId,
      attempt.n,
    );
    emitFilingUpdate(db, options.emit, {
      commentId,
      chapter: row.chapter,
      state: 'held',
      changeId: row.change_id,
      at: Date.parse(at),
    });
    return true;
  });
  return done();
}

/** One tick: at most `limit` filings, and nothing at all when none carries a verdict. */
export function poll(options: TriageApplierOptions): number {
  let placed = 0;
  for (const id of duePlacements(options.db, options.limit ?? TRIAGE_PLACE_LIMIT)) {
    if (placeFiling(options, id)) placed += 1;
  }
  const desperate = options.db
    .prepare(
      `SELECT c.id AS id FROM comments c
         JOIN comment_attempts a ON a.comment_id = c.id
        WHERE c.status = 'new' AND c.disposition IS NULL AND a.desperate = 1
          AND a.n = (SELECT MAX(n) FROM comment_attempts WHERE comment_id = c.id)
          AND a.outcome = 'submitted'
        LIMIT ?`,
    )
    .all(options.limit ?? TRIAGE_PLACE_LIMIT) as Array<{ id: string }>;
  for (const row of desperate) {
    if (settleDesperate(options, row.id)) placed += 1;
  }
  return placed;
}
