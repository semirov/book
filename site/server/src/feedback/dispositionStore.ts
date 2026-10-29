/**
 * The storage side of a disposition: read the facts, store the chain, and turn a would-be
 * refusal into the author's question (BOOK-174 comment #3888 §4, §6).
 *
 * The pure arbiter lives in `disposition.ts`; this module is the only place that touches the
 * database for it, so the accept path, the rejection paths and the operator's writes all judge
 * the same filing from the same facts and write the same four columns.
 *
 * Two rules this file exists to enforce:
 *
 *   1. **a refusal is a lock, and only a lock.** If no lock applies, nothing is written and the
 *      caller is told so (`{status:'no-lock'}`): the ladder is total and places every filing, so
 *      a rejection with no lock is a caller's mistake, not a state a row may enter (BOOK-206);
 *   2. **the sentence anchor is the filing's own** (ADR-044 `comments.sentence_id`). A reading
 *      records `disposition`, `lock`, `carrier_kind` and `quote_kept`; it never rewrites where
 *      the reader pointed, because that place outlives every decision about the words.
 */

import {
  DISPOSITION_REASONS,
  LOCK_REASONS,
  chainReport,
  normalizeCarrierKind,
  normalizeDisposition,
  normalizeDispositionLock,
  type DispositionReport,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { dispositionAnchorOf } from '../comments/dispositionReport.ts';
import { isBasisSlot } from '../engine/text.ts';
import { safeJson } from '../engineState/rows.ts';
import {
  chooseDisposition,
  type ChooseDispositionInput,
  type DispositionCaps,
  type DispositionDecision,
  type DispositionProposal,
} from './disposition.ts';

type Facts = Omit<ChooseDispositionInput, 'proposal' | 'caps'>;

/** Is this chapter a basis-only slot — the frame and no prose? (BOOK-174 §4, lock 3.) */
function chapterIsBasisSlot(db: Db, chapter: number): boolean {
  const row = db.prepare('SELECT basis FROM chapters WHERE n = ?').get(chapter) as
    | { basis: number }
    | undefined;
  return isBasisSlot(row);
}

/**
 * The facts a decision is read from — the row, its chapter, its block and its ADR-044 sentence.
 * Nothing is re-derived from the text: the sentence the filing carries is the anchor, and the
 * paragraph and sentence numbers come from the live rows.
 */
export function dispositionFacts(db: Db, comment: CommentRow): Facts {
  const anchor = dispositionAnchorOf(db, comment);
  return {
    // A basis-only slot holds the frame and no prose: the frame is the whole text (lock 3).
    chapterIsBasis: chapterIsBasisSlot(db, comment.chapter),
    chapter: comment.chapter,
    blockText: anchor.blockText,
    blockIndex: anchor.blockIndex,
    sentenceIndex: anchor.sentenceIndex,
    sentenceId: comment.sentence_id,
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
  // The trailing run is read from the rows themselves, in decision order: a filing that is not
  // an in-world refusal ends the run, which is what keeps a refusal from being a template.
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

/**
 * The four columns, written once, in whatever transaction the caller already holds. The
 * sentence anchor is not among them: it is the filing's own place, not the reading's.
 */
export function storeChain(db: Db, commentId: string, decision: DispositionDecision): void {
  db.prepare(
    `UPDATE comments
        SET disposition = ?, lock = ?, carrier_kind = ?, quote_kept = ?
      WHERE id = ?`,
  ).run(decision.disposition, decision.lock, decision.carrierKind, decision.quoteKept, commentId);
}

/** The columns a re-opened row must not keep: a decision about the old words is not about the new. */
export const CHAIN_CLEARED = 'disposition = NULL, lock = NULL, carrier_kind = NULL, quote_kept = NULL';

/** The three lines of a decision, exactly as the reader of this row will read them. */
export function reportOfDecision(
  db: Db,
  decision: DispositionDecision,
  comment: CommentRow,
): DispositionReport {
  const anchor = dispositionAnchorOf(db, comment);
  return chainReport(
    {
      disposition: decision.disposition,
      lock: decision.lock,
      carrierKind: decision.carrierKind,
      quoteKept: decision.quoteKept,
      sentenceId: comment.sentence_id,
    },
    { chapter: comment.chapter, blockIndex: anchor.blockIndex, sentenceIndex: anchor.sentenceIndex },
    comment.sentence_id !== null,
  );
}

/**
 * A touched filing's reading: a document about the phrase (BOOK-174 §2; and the frame lock's own
 * alternative — «документом об этой фразе»). Forced, not licensed: the sentence's letters cannot
 * move, so paperwork is the only answer the book has for a filing that touches it, and no
 * decision line can propose anything else about one.
 */
export function paperDecisionOf(db: Db, comment: CommentRow): DispositionDecision {
  const anchor = dispositionAnchorOf(db, comment);
  return {
    disposition: 'through_paper',
    lock: null,
    carrierKind: 'document',
    reason: DISPOSITION_REASONS.through_paper,
    quoteKept: null,
    sentenceId: comment.sentence_id,
    blockIndex: anchor.blockIndex,
    sentenceIndex: anchor.sentenceIndex,
    // The as-said plan never existed here: the frame's letters do not move.
    alternate: false,
  };
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
  return {
    disposition,
    lock,
    carrierKind: normalizeCarrierKind(row.carrier_kind),
    reason: disposition === 'inadmissible' && lock !== null ? LOCK_REASONS[lock] : DISPOSITION_REASONS[disposition],
    quoteKept: row.quote_kept,
    sentenceId: row.sentence_id,
    blockIndex: null,
    sentenceIndex: null,
    alternate: disposition === 'through_paper',
  };
}

/**
 * Does a stored lock still rest on a fact? A reopened row keeps its verdicts cleared, but a
 * row whose rights verdict was lifted, whose legal flag was removed or whose chapter became
 * prose must not be re-refused by a chain nobody re-judged. A finale lock is a named decision,
 * not a fact, so it stands.
 */
function lockStillHolds(db: Db, row: CommentRow, lock: ReturnType<typeof normalizeDispositionLock>): boolean {
  if (lock === 'rights') return row.rights_verdict === 'REFUSED';
  if (lock === 'harm') {
    const flags = safeJson<string[]>(row.flags) ?? [];
    return row.guard === 'legal' || flags.includes('illegal-content');
  }
  if (lock === 'frame') return chapterIsBasisSlot(db, row.chapter);
  return true;
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
  /**
   * BOOK-206 — the reading a caller already chose (`chooseFor` over a proposal). A finale lock
   * is a **decision**, not a fact of the row, so re-choosing without it would lose the lock and
   * write the author's question instead of the lock's own clause.
   */
  decision?: DispositionDecision | null;
};

export type RejectionResult =
  | {
      status: 'rejected';
      /** The sentence the reader now owes: the lock's own closed clause. */
      reason: string;
      decision: DispositionDecision;
    }
  /** No lock applies: nothing was written and no row changed. A refusal needs a lock. */
  | { status: 'no-lock' };

/**
 * The rejection path's one writer, and it is a **lock writer only**: a lock → `rejected` with the
 * lock's chain and one `decided` event; no lock → nothing at all, and `{status:'no-lock'}` says
 * so. There is no escalation any more (BOOK-206): the ladder places every filing, and a caller
 * that asks to refuse one with no lock is asking for a state that does not exist. The caller
 * announces the frame; nothing here emits.
 */
export function disposeRejection(db: Db, input: RejectionInput): RejectionResult {
  // The row as it stands now: the accept path may have written a chain a moment ago, and a
  // decision already taken is not re-judged — unless the lock it names no longer rests on a fact.
  const row = readCommentRow(db, input.comment.id) ?? input.comment;
  const stored = storedDecision(row);
  const decision =
    stored !== null && (stored.disposition !== 'inadmissible' || lockStillHolds(db, row, stored.lock))
      ? stored
      : (input.decision ?? chooseFor(db, row, null));
  if (decision.disposition !== 'inadmissible') return { status: 'no-lock' };
  // A reader reads the book's word, not the engine's note about why it gave up.
  const reason = decision.reason;
  db.prepare(
    `UPDATE comments
        SET status = 'rejected', decided_at = ?, reason = ?, batch_id = COALESCE(?, batch_id),
            disposition = ?, lock = ?, carrier_kind = ?, quote_kept = ?
      WHERE id = ?`,
  ).run(
    input.at,
    reason,
    input.batch ?? null,
    decision.disposition,
    decision.lock,
    decision.carrierKind,
    decision.quoteKept,
    input.comment.id,
  );
  appendCommentEvent(db, input.comment.id, 'decided', input.at, {
    status: 'rejected',
    ...(decision.lock === null ? {} : { lock: decision.lock }),
    ...(input.note === undefined || input.note === null || input.note.length === 0 ? {} : { note: input.note }),
  });
  return { status: 'rejected', reason, decision };
}
