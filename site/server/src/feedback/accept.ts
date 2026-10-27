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

import { PREMISE_FROZEN_REASON, normalizeInterventionKind } from '@book/shared';

import { insertChange } from '../engine/store.ts';
import { PREMISE_SUPERSEDED_REASON, admitPremise } from '../engine/premise.ts';
import type { Db } from '../db/db.ts';
import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { newChangeId } from '../util/ulid.ts';

export type AcceptResult =
  | { changeId: string; created: boolean; superseded?: boolean }
  | { error: string; code?: 'AUDIT_REQUIRED' | 'FROZEN_FRAME' };

export type AcceptInput = {
  comment: CommentRow;
  intent: string;
  at: string;
  reason: string;
  changeId?: string | null;
  baseRev?: number | null;
  batch?: string | null;
};

/** A revision is 1..n; 0 is the premise base and never a base for text that exists. */
function positiveRev(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function acceptComment(db: Db, input: AcceptInput): AcceptResult {
  const run = db.transaction((): AcceptResult => {
    const comment = readCommentRow(db, input.comment.id) ?? input.comment;

    // A row created before BOOK-9 (or any row that already owns a change) keeps the
    // idempotent answer: a replay returns the change it has, and nothing is created here.
    if (comment.change_id !== null) {
      const linked = db.prepare('SELECT outcome FROM changes WHERE id = ?').get(comment.change_id) as
        | { outcome: string | null }
        | undefined;
      return {
        changeId: comment.change_id,
        created: false,
        ...(linked?.outcome === 'superseded' ? { superseded: true } : {}),
      };
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

    // BOOK-7: the frozen frame is decided from the slot itself, before the projection is
    // read. A basis slot is projected with a row (rev 0, one block), so "no row" would let
    // an intervention on ch01/ch67 through as an ordinary change on the frozen chapter.
    if (comment.chapter === 1 || comment.chapter === 67) {
      return { code: 'FROZEN_FRAME', error: PREMISE_FROZEN_REASON };
    }

    const chapter = db
      .prepare('SELECT rev, sha256, basis, block_count FROM chapters WHERE n = ?')
      .get(comment.chapter) as
      | { rev: number; sha256: string; basis: number; block_count: number }
      | undefined;
    const changeId = input.changeId ?? newChangeId(Date.parse(input.at));
    const existing = db.prepare('SELECT id FROM changes WHERE id = ?').get(changeId) as { id: string } | undefined;

    // BOOK-7: premise vs ordinary is "is the slot written", from the projection — a basis
    // row is a row, not prose. Only a written chapter takes an ordinary change.
    if (chapter === undefined || chapter.basis !== 0 || chapter.block_count === 0) {
      let superseded = false;
      if (existing === undefined) {
        superseded = admitPremise(db, {
          id: changeId,
          kind: 'accepted_comment',
          chapter: comment.chapter,
          intent: input.intent,
          interventionKind: normalizeInterventionKind(comment.intervention_kind),
          sourceComment: comment.id,
          sourceSession: null,
          at: input.at,
        }).superseded;
      } else {
        const linked = db.prepare('SELECT outcome FROM changes WHERE id = ?').get(changeId) as
          | { outcome: string | null }
          | undefined;
        superseded = linked?.outcome === 'superseded';
      }
      const status = superseded ? 'superseded' : 'accepted';
      const reason = superseded ? PREMISE_SUPERSEDED_REASON : input.reason.slice(0, 200);
      db.prepare(
        `UPDATE comments
            SET status = ?, decided_at = ?, reason = ?, batch_id = COALESCE(?, batch_id), change_id = ?
          WHERE id = ?`,
      ).run(status, input.at, reason, input.batch ?? null, changeId, comment.id);
      appendCommentEvent(db, comment.id, 'decided', input.at, { status, changeId, premise: true });
      return { changeId, created: existing === undefined, superseded };
    }

    const blocks = db
      .prepare('SELECT hash FROM blocks WHERE chapter = ? ORDER BY idx')
      .all(comment.chapter) as Array<{ hash: string }>;
    // A stored 0 is the premise base (an empty slot at posting time); once the chapter has
    // text, the change must be recorded against the revision that stands, not against 0.
    const baseRev = positiveRev(input.baseRev) ?? positiveRev(comment.base_rev) ?? chapter.rev;
    if (existing === undefined) {
      insertChange(db, {
        id: changeId,
        kind: 'accepted_comment',
        // BOOK-16: the kind travels with the comment into the change, so the writer's
        // assignment names it. A row stored before BOOK-16 has none, and that stays null —
        // an old intervention is decided exactly as before.
        interventionKind: normalizeInterventionKind(comment.intervention_kind),
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
        premise: 0,
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
