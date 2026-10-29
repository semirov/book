/**
 * The author's side of an escalated filing (BOOK-174 §4) — the two answers to the one question
 * the ladder asks, and the queue that shows what is waiting.
 *
 * Escalation is not a bin: the filing keeps its words, its place and its reader, and the author
 * either places it (`feedback.mjs decide <id> accepted`, an ordinary acceptance with the gates
 * it always had) or says no. Saying no is the one refusal that needs no lock — the book's owner
 * is the party the question was put to, and «нет» is an answer, not an accident — so it is
 * written here, with the operator's sentence, its chain cleared (the reading described a
 * question that is no longer pending) and one `decided` event.
 *
 * The inbox half is the same fact read in the other direction: an escalated row never enters a
 * batch (nothing more will be judged about it), so this listing is how the author finds it.
 */

import type { Db } from '../db/db.ts';
import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { listCommentsByStatus } from './batches.ts';
import { CHAIN_CLEARED, storedDecision } from './dispositionStore.ts';

export const ESCALATED_INBOX_EMPTY = 'no escalated comments';

/** The author's «no»: the end of the ladder, and nothing else is written. */
export function refuseEscalated(
  db: Db,
  input: { comment: CommentRow; at: string; reason: string },
): boolean {
  const changed = db
    .prepare(
      `UPDATE comments
          SET status = 'rejected', decided_at = ?, reason = ?, ${CHAIN_CLEARED}
        WHERE id = ? AND status = 'escalated'`,
    )
    .run(input.at, input.reason.slice(0, 200), input.comment.id).changes;
  if (changed === 0) return false;
  appendCommentEvent(db, input.comment.id, 'decided', input.at, { status: 'rejected', by: 'author' });
  return true;
}

/**
 * `inbox --escalated`: what waits for the author, with the question each filing asks. The line
 * names the filing, its chapter and its reading — never a reason the reader has not been told.
 */
export function escalatedInbox(
  args: { flags: Map<string, string> },
  io: { db: Db; print: (line: string) => void },
): number {
  const raw = args.flags.get('limit');
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : 50;
  const rows = listCommentsByStatus(io.db, 'escalated', limit);
  if (rows.length === 0) {
    io.print(ESCALATED_INBOX_EMPTY);
    return 0;
  }
  for (const row of rows) {
    const chain = storedDecision(row);
    io.print(
      `${row.id}  ch${String(row.chapter).padStart(2, '0')}  ` +
        `${chain === null ? '—' : chain.reason}  ${row.author}  ${row.created_at}`,
    );
  }
  return 0;
}

/** Re-read a row for a caller that is about to answer it (one indexed read, no cache). */
export function reread(db: Db, id: string): CommentRow | undefined {
  return readCommentRow(db, id);
}
