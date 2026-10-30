/**
 * The sixth attempt (BOOK-206; owner's correction, 2026-10-29): «нет, сроков не надо — только
 * конечное количество попыток».
 *
 * A read gets six attempts. The first five are model calls; the sixth is this module — the ladder's
 * **floor** rung applied by the coded rule, with no model at all. The filing's own sentence (its
 * proposed wording, else its body) is the change's intent, `chooseDisposition` decides whether the
 * floor stands, and the result is stored in the same shape a model's answer has, so the applier
 * places it without knowing who answered.
 *
 * The floor cannot apply in two ways, and the sixth failure's sentence is not the same for both:
 * a lock the ladder names (rights, the frame, a legal stop, the finale) or a gate C answer of
 * `OFF` is the **book's** judgement, and keeps its own clause; anything else — an intent the
 * injection guard refuses, a filing with no wording of its own, a read that never came back —
 * is our machinery failing, and the reader is told it was not judged (`TRIAGE_REFUSED_LINE`).
 *
 * One conditional UPDATE carries all of it: `desperate = 1` is the row's own proof that the sixth
 * attempt ran once, so a second sweep, a restarted site or a race with the applier writes nothing.
 */

import {
  INTENT_MAX_CHARS,
  TRIAGE_CONTENT_LINE,
  TRIAGE_MAX_TRIES,
  TRIAGE_REFUSED_LINE,
  normalizeInterventionKind,
  validateIntent,
} from '@book/shared';

import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { refuseTriage, type TriageLock } from '../comments/triage.ts';
import type { Db } from '../db/db.ts';
import { filingWording, type DispositionDecision } from '../feedback/disposition.ts';
import { chooseFor } from '../feedback/dispositionStore.ts';
import { chapterVocabulary } from '../feedback/vocabulary.ts';
import { recordAlert } from './alerts.ts';
import type { EngineAlert, EngineDeps } from './types.ts';

/** The stored shape the engine's own sixth attempt writes: a `book.verdict/v1` at the floor. */
export type FloorVerdict = {
  verdict: 'FITS';
  rule: null;
  evidence: [];
  reason: null;
  reading: { rung: 'as_said'; lock: null; intent: string; carrier: null; refusal: null };
};

/**
 * The note a row that never widened keeps: an operator's copy of what the sixth attempt did,
 * never the reader's. A row that widened at the third failure keeps that note instead — the
 * schema's `widening_note` says why the reading widened, and `desperate = 1` already carries
 * the sixth.
 */
const DESPERATE_NOTE = 'шестая попытка — нижняя ступень лестницы применена правилом, без модели';

export type TriageFloor = {
  /**
   * Run the engine's own sixth attempt for one filing. `true` only for the caller that moved the
   * row; the attempt either carries the floor reading (and the applier places it) or it is refused.
   */
  floor(commentId: string, n: number, at: string): boolean;
};

/**
 * What the coded floor can say about one filing. The floor is *total* only over a filing the
 * book has not already refused: a lock (or a recorded `OFF`) is a judgement about the text, and
 * it keeps its own sentence; anything else the rule cannot build is **our** failure — the idea
 * was never read.
 */
export type FloorAnswer =
  | { kind: 'place'; verdict: FloorVerdict; reason: string }
  | { kind: 'lock'; decision: DispositionDecision }
  | { kind: 'content'; sentence: string }
  | { kind: 'ours' };

/**
 * The floor reading, from rows only. `null` when the floor cannot apply — see the module note.
 * Pure with respect to the filing: it reads the row and the chapter, and writes nothing.
 */
export function floorAnswerOf(db: Db, row: CommentRow): FloorAnswer {
  // A recorded `OFF` is a decision about the filing's words; a FITS floor would rewrite it. The
  // book's own sentence is the one a reader may print, never our failure line.
  if (row.audit_verdict === 'OFF') {
    const sentence = (row.audit_reason ?? '').trim();
    return { kind: 'content', sentence: sentence.length === 0 ? TRIAGE_CONTENT_LINE : sentence };
  }
  const decision = chooseFor(db, row, { disposition: 'as_said' });
  // A lock is the only refusal: the chain travels so the page reads the lock's own clause and
  // the retry door stays shut (a judgement was made, and it was not ours).
  if (decision.disposition === 'inadmissible') return { kind: 'lock', decision };
  const wording = filingWording({ body: row.body, proposedText: row.proposed_text }).replace(/\s+/gu, ' ').trim();
  if (wording.length === 0) return { kind: 'ours' };
  const intent = validateIntent(wording.slice(0, INTENT_MAX_CHARS), row.chapter, {
    vocabulary: chapterVocabulary(db, row.chapter),
    kind: normalizeInterventionKind(row.intervention_kind),
  });
  if (!intent.ok) return { kind: 'ours' };
  return {
    kind: 'place',
    verdict: {
      verdict: 'FITS',
      rule: null,
      evidence: [],
      reason: null,
      reading: { rung: 'as_said', lock: null, intent: intent.intent, carrier: null, refusal: null },
    },
    reason: decision.reason,
  };
}

export function createTriageFloor(deps: EngineDeps): TriageFloor {
  const { db } = deps;

  /**
   * The refusal sink for an attempt the engine's own rule could not answer: one `triage.failed`
   * event with the frame the bridge drains (`retryAt: null`), the row `rejected` with the
   * caller's sentence, one alert — and `true` only for the caller that moved the row.
   */
  function refuseAtSixth(
    commentId: string,
    n: number,
    at: string,
    sentence: string,
    lock: TriageLock | null,
  ): boolean {
    const refused = db.transaction((): boolean => {
      if (!refuseTriage(db, { commentId, n, at, sentence, lock })) return false;
      appendCommentEvent(db, commentId, 'triage.failed', at, {
        code: 'TRIAGE_DESPERATE',
        attempt: n,
        try: TRIAGE_MAX_TRIES,
        of: TRIAGE_MAX_TRIES,
        cap: true,
        desperate: true,
        retryAt: null,
        reason: sentence,
      });
      return true;
    })();
    if (refused) {
      recordAlert(deps, {
        kind: 'triage' satisfies EngineAlert['kind'],
        at,
        changeId: null,
        cascadeId: null,
        stepId: null,
        detail: `triage ${commentId} #${String(n)}: refused at the sixth attempt (TRIAGE_DESPERATE)`,
      });
    }
    return refused;
  }

  function floor(commentId: string, n: number, at: string): boolean {
    const row = readCommentRow(db, commentId);
    // Only a filing that still waits for its read is this attempt's business: a decided row has
    // an answer already, and the floor must not write a second one behind it.
    if (row === undefined || row.status !== 'new' || row.disposition !== null) return false;
    const answer = floorAnswerOf(db, row);
    return db.transaction((): boolean => {
      if (answer.kind !== 'place') {
        // The sixth failure: the count is marked on the row, then the refusal — which is itself a
        // conditional write, so a second sweep or a restarted site can never tell the reader twice.
        markDesperate(db, commentId, n);
        if (answer.kind === 'lock' && answer.decision.lock !== null) {
          // A lock is the book's answer: the lock's own clause, and the retry door stays shut.
          return refuseAtSixth(commentId, n, at, answer.decision.reason, {
            lock: answer.decision.lock,
            carrierKind: answer.decision.carrierKind,
            quoteKept: answer.decision.quoteKept,
          });
        }
        // Everything else is **our** failure: no model read the idea, so the reader is told the
        // truth and offered the retry, never that the filing was refused on its merits.
        const sentence = answer.kind === 'content' ? answer.sentence : TRIAGE_REFUSED_LINE;
        return refuseAtSixth(commentId, n, at, sentence, null);
      }
      const reading = answer;
      const marked = db
        .prepare(
          `UPDATE comment_attempts
              SET tries = ?, desperate = 1, verdict = ?, verdict_at = ?,
                  widening_note = COALESCE(widening_note, ?),
                  widened = COALESCE(widened, 'as-document'), next_at = NULL, claim_by = NULL, claim_until = NULL
            WHERE comment_id = ? AND n = ? AND outcome = 'submitted' AND verdict IS NULL`,
        )
        .run(TRIAGE_MAX_TRIES, JSON.stringify(reading.verdict), at, DESPERATE_NOTE, commentId, n).changes;
      if (marked !== 1) return false;
      // Gate C's own columns, exactly as a model's answer writes them: the applier reads a row
      // with an audit answer and a stored reading, and nothing about that contract changes.
      db.prepare(
        `UPDATE comments
            SET audit_verdict = 'FITS', audit_reason = ?, audited_at = ?, audited_by = 'triage:floor'
          WHERE id = ? AND audit_verdict IS NULL`,
      ).run(reading.reason, at, commentId);
      appendCommentEvent(db, commentId, 'triage.desperate', at, {
        attempt: n,
        try: TRIAGE_MAX_TRIES,
        of: TRIAGE_MAX_TRIES,
        rung: reading.verdict.reading.rung,
        reason: reading.reason,
      });
      return true;
    })();
  }

  return { floor };
}

/** Mark the sixth attempt on the row without writing a reading. `true` for the first caller only. */
function markDesperate(db: Db, commentId: string, n: number): boolean {
  return (
    db
      .prepare(
        `UPDATE comment_attempts SET tries = ?, desperate = 1, widening_note = ?,
                next_at = NULL, claim_by = NULL, claim_until = NULL
          WHERE comment_id = ? AND n = ? AND desperate = 0 AND outcome = 'submitted' AND verdict IS NULL`,
      )
      .run(TRIAGE_MAX_TRIES, DESPERATE_NOTE, commentId, n).changes === 1
  );
}
