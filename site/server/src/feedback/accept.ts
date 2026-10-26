/**
 * Acceptance → a queued change (ARCHITECTURE.md §12.1, §12.6).
 *
 * Acceptance is a promise, not a result: the comment becomes a `changes` row with an
 * *intent* and a base revision, and the FIFO lane applies it later. Both the host CLI and
 * the site's decisions tailer call this one function, so a change has exactly one shape no
 * matter which process wrote it, and re-running a decision is a no-op.
 *
 * Insert and link happen in one transaction: a crash can never leave a queued change with
 * no comment pointing at it (or a comment "accepted" with nothing in the queue).
 *
 * BOOK-9: acceptance also requires a recorded auditor verdict `FITS` on the comment. The
 * check lives here, not in a caller, so the CLI and the decisions tailer cannot skip it; the
 * one other creator of a `changes` row that names a comment — the internal queue route — asks
 * the same question (`engine/queue.ts`). A row that already points at a change keeps its
 * idempotent answer (pre-BOOK-9 rows are read, never re-decided).
 */

import { insertChange } from '../engine/store.ts';
import type { Db } from '../db/db.ts';
import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { newChangeId } from '../util/ulid.ts';

export type AcceptResult =
  | { changeId: string; created: boolean }
  | { error: string; code?: 'AUDIT_REQUIRED' };

export type AcceptInput = {
  comment: CommentRow;
  intent: string;
  at: string;
  reason: string;
  changeId?: string | null;
  baseRev?: number | null;
  batch?: string | null;
};

export function acceptComment(db: Db, input: AcceptInput): AcceptResult {
  const run = db.transaction((): AcceptResult => {
    const comment = readCommentRow(db, input.comment.id) ?? input.comment;

    // A row created before BOOK-9 (or any row that already owns a change) keeps the
    // idempotent answer: a replay returns the change it has, and nothing is created here.
    if (comment.change_id !== null) {
      return { changeId: comment.change_id, created: false };
    }

    // BOOK-9: a recorded `FITS` is the only permission a new change has. Fail closed — no
    // default, no "assume fits" — because both the host CLI and the site's decisions tailer
    // call this one function and neither may skip the gate.
    if (comment.audit_verdict !== 'FITS') {
      return {
        code: 'AUDIT_REQUIRED',
        error: 'замечание не прошло проверку на соответствие книге — правку из него не делают',
      };
    }

    const chapter = db.prepare('SELECT rev, sha256 FROM chapters WHERE n = ?').get(comment.chapter) as
      | { rev: number; sha256: string }
      | undefined;
    if (chapter === undefined) return { error: 'глава ещё не написана: правку не к чему привязать' };

    const blocks = db
      .prepare('SELECT hash FROM blocks WHERE chapter = ? ORDER BY idx')
      .all(comment.chapter) as Array<{ hash: string }>;
    const baseRev = input.baseRev ?? comment.base_rev ?? chapter.rev;
    const changeId = input.changeId ?? newChangeId(Date.parse(input.at));
    const existing = db.prepare('SELECT id FROM changes WHERE id = ?').get(changeId) as { id: string } | undefined;
    if (existing === undefined) {
      insertChange(db, {
        id: changeId,
        kind: 'accepted_comment',
        chapter: comment.chapter,
        anchor: JSON.stringify({
          blockIds: comment.block_id === null ? [] : [comment.block_id],
          quote: comment.quote,
          prefix: comment.prefix,
          suffix: comment.suffix,
        }),
        intent: input.intent,
        proposedText: comment.proposed_text,
        sourceComment: comment.id,
        sourceSession: null,
        baseRev,
        baseSha: chapter.sha256,
        baseBlocks: JSON.stringify(blocks.map((block) => block.hash)),
        scopeHint: 'phrase',
        enqueuedAt: input.at,
      });
    }

    db.prepare(
      `UPDATE comments
          SET status = 'accepted', decided_at = ?, reason = ?, batch_id = COALESCE(?, batch_id), change_id = ?
        WHERE id = ?`,
    ).run(input.at, input.reason.slice(0, 200), input.batch ?? null, changeId, comment.id);
    appendCommentEvent(db, comment.id, 'decided', input.at, { status: 'accepted', changeId });

    return { changeId, created: existing === undefined };
  });
  return run();
}
