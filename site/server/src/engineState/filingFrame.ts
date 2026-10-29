/**
 * BOOK-219/BOOK-206 B2 — one filing transition, told to the open page as `comment:decision`.
 *
 * The engine writes facts; the reader's page moves a filing row only on this frame. So every
 * transition that moved a filing has to speak one, and it has to speak the **same** words the
 * next reload prints: the frame is built from `toCommentDto`, which is the DTO the thread reads.
 * A second derivation here would let the frame and the row disagree the day one of them moves —
 * exactly the class the audit named (B2: three surfaces, three answers about one stop).
 *
 * One door into this module: `filingCloseFrame` — a change's close that left the filing in a
 * terminal state: a landing (`applied`, with the chapter's receipt) or a stop (`rejected`, with
 * its own sentence). A reading's own phases are `filing:reading` (§10.1), not this frame.
 *
 * A change no reader filed (a continuity pass, an operator's edit) has no filing, and a withdrawn
 * one is never republished (BOOK-101): both answer `null` here rather than an empty frame.
 */

import type { CommentDecisionPayload, CommentStatus } from '@book/shared';

import { attemptCounts } from '../comments/attemptToday.ts';
import { readCommentRow, toCommentDto, type CommentRow } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';

import type { ChangeRow } from './rows.ts';

/**
 * The derived states a change's **close** can leave a filing in. Only a terminal state speaks:
 * `accepted` is «the lane has it» (no close produced it), `new` is a filing no change ever held,
 * and neither is a transition this frame is owed for.
 */
export const TERMINAL_FILING_STATES = new Set<CommentStatus>([
  'applied',
  'rejected',
  'superseded',
  'registered',
]);

/** One frame from one comment row, derived exactly as the reader's next reload would read it. */
export function filingFrameOf(
  db: Db,
  comment: CommentRow,
  at: string,
  nowMs: number,
): CommentDecisionPayload {
  const dto = toCommentDto(db, comment, nowMs);
  return {
    id: dto.id,
    chapter: dto.chapter,
    status: dto.status,
    // The frame is a public surface: the DTO's sentence, never an engine code. A `new` filing
    // that just lost its read says the rescheduled sentence; a stopped one says its stop line.
    reason: dto.reason ?? '',
    decidedAt: dto.decidedAt ?? at,
    batchId: comment.batch_id,
    changeId: dto.changeId,
    disposition: dto.disposition ?? null,
    carrierKind: dto.carrierKind ?? null,
    // The receipt is the one storage derives for the filing: the chapter it entered and that
    // chapter's revision. `null` for anything that did not land — present, never omitted, so a
    // consumer can tell «nothing landed» from «this frame forgot to say» (BOOK-206 B2).
    applied: dto.applied ?? null,
    // BOOK-DOC-84 #19 — the tries left, from the same ledger the record reads, and the decision's
    // own moment in ms. A frame without them leaves the row printing a count it no longer has.
    attemptsLeft: attemptCounts(db, comment.id, nowMs).attemptsLeft,
    at: Date.parse(at),
  };
}

/**
 * The frame a change's close owes its filing, or `null` when the close left the filing in no
 * terminal state or no reader filed it. The caller emits it **beside** the `change:*` frames,
 * never instead of them.
 */
export function filingCloseFrame(
  db: Db,
  change: Pick<ChangeRow, 'source_comment'>,
  at: string,
  nowMs: number,
): CommentDecisionPayload | null {
  if (change.source_comment === null) return null;
  const comment = readCommentRow(db, change.source_comment);
  if (comment === undefined || comment.status === 'hidden') return null;
  const frame = filingFrameOf(db, comment, at, nowMs);
  return TERMINAL_FILING_STATES.has(frame.status) ? frame : null;
}
