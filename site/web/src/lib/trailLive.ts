/**
 * BOOK-DOC-84 §2.1 #17 / D6 — a filing's own row, patched by its frame.
 *
 * The trail used to be a mount-only fetch (`GET /api/me/filings`): a filing accepted while the
 * reader watched the page stayed «ждёт» until a reload. The frame carries the state, the tries
 * used and the tries left, so the row is updated in place — no GET, no second store.
 *
 * The two vocabularies are not the same one: the server's filing state (`refused`, `held`) is a
 * wire word, while a `CommentDto` carries the reader's word (`rejected`, `quarantined`). The map
 * below is the whole of the translation, in one place.
 */

import type { CommentDto, CommentStatus, FilingState, FilingUpdatePayload, LiveFiling } from '@book/shared';

const STATUS: Record<FilingState, CommentStatus> = {
  new: 'new',
  accepted: 'accepted',
  refused: 'rejected',
  held: 'quarantined',
  expired: 'expired',
  quarantined: 'quarantined',
  registered: 'registered',
};

/**
 * The row with the frame's facts carried onto it, or `null` when nothing changed (a duplicate
 * frame or a state the row already has). The tries-left count lives in `revise`, which the
 * server sends with every filing; a row that carries none keeps none.
 */
export function withFilingUpdate(comment: CommentDto, update: FilingUpdatePayload): CommentDto | null {
  const status = STATUS[update.state] ?? comment.status;
  const revise =
    comment.revise === undefined
      ? undefined
      : { ...comment.revise, attemptsLeft: update.attemptsLeft };
  const changeId = update.changeId ?? comment.changeId;
  if (
    status === comment.status &&
    changeId === comment.changeId &&
    (comment.revise === undefined || comment.revise.attemptsLeft === update.attemptsLeft)
  ) {
    return null;
  }
  return {
    ...comment,
    status,
    changeId,
    ...(revise === undefined ? {} : { revise }),
  };
}

/** The live filings the fetched page does not hold: a row the reader made in another tab. */
export function filingsMissingFrom(rows: readonly CommentDto[], filings: readonly LiveFiling[] | undefined): string[] {
  if (filings === undefined || filings.length === 0) return [];
  const known = new Set(rows.map((row) => row.id));
  return filings.map((filing) => filing.commentId).filter((id) => !known.has(id));
}
