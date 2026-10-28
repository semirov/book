/**
 * The storage side of a disposition: read the facts, store the chain, and turn a would-be
 * refusal into the author's question (BOOK-174 comment #3888 §4, §6).
 *
 * The pure arbiter lives in `disposition.ts`; this module is the only place that touches the
 * database for it, so the accept path, the two rejection paths and the operator's rights write
 * all judge the same filing from the same facts and write the same five columns.
 *
 * The one rule this file exists to enforce: **a filing never ends as a bare rejection outside
 * a lock.** If no lock applies, the row becomes `escalated` — `decided_at` written, the
 * question as its reason, one `escalated` event — and no change and no rejection is recorded.
 */

import { ESCALATION_QUESTION, chainReport, normalizeCarrierKind, normalizeDisposition, normalizeDispositionLock, parseSentenceId, LOCK_REASONS, DISPOSITION_REASONS, type DispositionReport } from '@book/shared';

import type { Db } from '../db/db.ts';
import { appendCommentEvent, readBlock, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { isBasisSlot } from '../engine/text.ts';
import { safeJson } from '../engineState/rows.ts';
import {
  chooseDisposition,
  escalationDecision,
  type ChooseDispositionInput,
  type DispositionCaps,
  type DispositionDecision,
  type DispositionProposal,
} from './disposition.ts';

/** The facts a decision is read from — the row, its chapter and its block, nothing invented. */
export function dispositionFacts(
  db: Db,
  comment: CommentRow,
): Omit<ChooseDispositionInput, 'proposal' | 'caps'> {
  const chapter = db.prepare('SELECT basis FROM chapters WHERE n = ?').get(comment.chapter) as
    | { basis: number }
    | undefined;
  const block = comment.block_id === null ? undefined : readBlock(db, comment.block_id);
  return {
    // A basis-only slot holds the frame and no prose: the frame is the whole text (lock 3).
    chapterIsBasis: isBasisSlot(chapter),
    chapter: comment.chapter,
    blockText: block?.text ?? null,
    blockIndex: block?.idx ?? comment.block_idx,
    quote: comment.quote,
    body: comment.body,
    proposedText: comment.proposed_text,
    rightsVerdict: comment.rights_verdict,
    guard: comment.guard,
    flags: safeJson<string[]>(comment.flags) ?? [],
  };
}

/** How many decisions of this chapter already stand, and how the world has been refusing. */
export function dispositionCaps(db: Db, comment: CommentRow, stamp: string | null): DispositionCaps {
  const byReader = db
    .prepare(
      `SELECT COUNT(*) AS n FROM comments
        WHERE chapter = ? AND identity_id = ? AND disposition = 'refused_in_world'`,
    )
    .get(comment.chapter, comment.identity_id) as { n: number };
  const wanted = (stamp ?? '').trim();
  const sameStamp =
    wanted.length === 0
      ? { n: 0 }
      : (db
          .prepare(
            `SELECT COUNT(*) AS n FROM comments
              WHERE chapter = ? AND disposition = 'refused_in_world' AND quote_kept = ? AND id <> ?`,
          )
          .get(comment.chapter, wanted, comment.id) as { n: number });
  // The trailing run is read from the rows themselves, in decision order: an escalated or a
  // landed filing in between ends the run, which is what keeps a refusal from being a template.
  const decided = db
    .prepare(
      `SELECT disposition FROM comments
        WHERE chapter = ? AND disposition IS NOT NULL AND id <> ?
        ORDER BY decided_at, id`,
    )
    .all(comment.chapter, comment.id) as Array<{ disposition: string | null }>;
  let runBefore = 0;
  for (let index = decided.length - 1; index >= 0; index -= 1) {
    if (decided[index]?.disposition !== 'refused_in_world') break;
    runBefore += 1;
  }
  return {
    inWorldInChapterByReader: byReader.n,
    stampUsedInChapter: sameStamp.n > 0,
    runBefore,
  };
}

/** The one call every path makes: the facts of this row, the proposal, the caps, the decision. */
export function chooseFor(
  db: Db,
  comment: CommentRow,
  proposal: DispositionProposal | null,
): DispositionDecision {
  const facts = dispositionFacts(db, comment);
  return chooseDisposition({
    ...facts,
    proposal: proposal ?? {},
    caps: dispositionCaps(db, comment, proposal?.stamp ?? null),
  });
}

/** The five columns, written once, in whatever transaction the caller already holds. */export function storeChain(db: Db, commentId: string, decision: DispositionDecision): void {
  db.prepare(
    `UPDATE comments
        SET disposition = ?, lock = ?, carrier_kind = ?, quote_kept = ?, sentence_id = ?
      WHERE id = ?`,
  ).run(
    decision.disposition,
    decision.lock,
    decision.carrierKind,
    decision.quoteKept,
    decision.sentenceId,
    commentId,
  );
}

/** The three lines of a decision, exactly as the reader will read them. */
export function reportOfDecision(decision: DispositionDecision, chapter: number): DispositionReport {
  return chainReport(
    {
      disposition: decision.disposition,
      lock: decision.lock,
      carrierKind: decision.carrierKind,
      quoteKept: decision.quoteKept,
      sentenceId: decision.sentenceId,
    },
    chapter,
  );
}

/**
 * A chain already stored on the row, rebuilt as the decision it came from. The accept path
 * writes the chain before a caller may reject, so the second judgement must not overrule the
 * first: a finale lock, once named, stays the reason.
 */
export function storedDecision(row: CommentRow): DispositionDecision | null {
  const disposition = normalizeDisposition(row.disposition);
  if (disposition === null) return null;
  const lock = normalizeDispositionLock(row.lock);
  const at = parseSentenceId(row.sentence_id);
  return {
    disposition,
    lock,
    carrierKind: normalizeCarrierKind(row.carrier_kind),
    reason: disposition === 'inadmissible' && lock !== null ? LOCK_REASONS[lock] : DISPOSITION_REASONS[disposition],
    quoteKept: row.quote_kept,
    sentenceId: row.sentence_id,
    blockIndex: at === null ? null : at.blockIndex,
    sentenceIndex: at === null ? null : at.sentenceIndex,
    escalated: disposition === 'escalated',
    question: disposition === 'escalated' ? ESCALATION_QUESTION : null,
    alternate: disposition === 'through_paper' && at !== null,
  };
}

export type RejectionInput = {
  comment: CommentRow;
  at: string;
  batch?: string | null;
  /**
   * The engine's own note about why it gave up. It is never the reader's reason — the book's
   * word is — but it stays in the comment event, where an operator can look it up.
   */
  note?: string | null;
};

export type RejectionResult = {
  status: 'rejected' | 'escalated';
  /** The sentence the reader now owes: the lock's line, or the author's question. */
  reason: string;
  decision: DispositionDecision;
};

/**
 * The rejection path's one writer. A lock → `rejected` with the lock's chain and one `decided`
 * event; no lock → `escalated`, the question as the reason, one `escalated` event. The caller
 * announces the frame; nothing here emits.
 */
export function disposeRejection(db: Db, input: RejectionInput): RejectionResult {
  // The row as it stands now: the accept path may have written a chain a moment ago, and a
  // decision already taken is not re-judged.
  const row = readCommentRow(db, input.comment.id) ?? input.comment;
  const decision = storedDecision(row) ?? chooseFor(db, row, null);
  const lock = decision.disposition === 'inadmissible' ? decision : null;
  const chain = lock ?? escalationDecision();
  const status: RejectionResult['status'] = lock === null ? 'escalated' : 'rejected';
  // A reader reads the book's word, not the engine's note about why it gave up: the lock's own
  // closed clause, or the author's question.
  const reason = lock?.reason ?? ESCALATION_QUESTION;
  db.prepare(
    `UPDATE comments
        SET status = ?, decided_at = ?, reason = ?, batch_id = COALESCE(?, batch_id),
            disposition = ?, lock = ?, carrier_kind = ?, quote_kept = ?, sentence_id = ?
      WHERE id = ?`,
  ).run(
    status,
    input.at,
    reason,
    input.batch ?? null,
    chain.disposition,
    chain.lock,
    chain.carrierKind,
    chain.quoteKept,
    chain.sentenceId,
    input.comment.id,
  );
  appendCommentEvent(db, input.comment.id, status === 'escalated' ? 'escalated' : 'decided', input.at, {
    status,
    ...(chain.lock === null ? {} : { lock: chain.lock }),
    ...(input.note === undefined || input.note === null || input.note.length === 0 ? {} : { note: input.note }),
  });
  return { status, reason, decision: chain };
}
