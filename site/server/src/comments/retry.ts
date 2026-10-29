/**
 * `POST /api/comments/:id/retry` — the door behind «повторить».
 *
 * A retry is **not a new filing**: the row, its id, its anchor, its words, its place in the
 * thread and the reader's day are all the same submission. What is re-armed is the machinery that
 * failed — one fresh attempt ladder on the filing (a new `comment_attempts` row at `tries = 0`)
 * and, when a pass had already taken the filing, that same `changes` row back in the queue at
 * `attempts = 0`. The filing then reads `new` again («читается»), with no sentence in `reason`:
 * the neutral reading line is **no sentence at all** — the page prints its own word from the
 * status, exactly as it does after a post or a revision.
 *
 * What stays is the record: the failure keeps its own `comment_events` rows (`triage.failed`,
 * `triage.abandoned`, `decided`) and the retry adds one `retry` row carrying `{ n, because }` and
 * what the row looked like when it was re-armed. Nothing is erased, so the trail says «we broke,
 * we tried again» instead of pretending the first attempt never happened.
 *
 * The order is the refusal path's, and for the same reason — nothing is written before every
 * question has been answered: blocked author → ownership → the offer (`retryOffer`, the one rule
 * about whether a retry would be a lie) → one transaction (the row, the change, the ladder, the
 * event). The rate and attempt budgets are **not** charged here: a retry is the same submission,
 * and `attempts.ts` leaves its own attempt rows out of the reader's and the network's day.
 */

import type { CommentDto } from '@book/shared';

import type { Db } from '../db/db.ts';
import type { IdentityRow } from '../db/repo/identities.ts';
import { appendEvent, appendChangeEvent } from '../history/log.ts';
import { recordAttempt } from './attempts.ts';
import { fail, type ServiceFailure } from './failure.ts';
import { decisiveChange, filingChanges } from './filingState.ts';
import { appendCommentEvent, readCommentRow, toCommentDto, type CommentRow } from './repo.ts';
import {
  RETRY_CAP_MESSAGE,
  RETRY_NOT_OFFERED,
  RETRY_REFUSED_MESSAGE,
  retryOffer,
} from './retryOffer.ts';

export type RetryDeps = {
  db: Db;
  now: () => Date;
};

/** The author a retry is judged against: the session's identity, never the request's. */
export type RetryAuthor = Pick<IdentityRow, 'id' | 'blocked'>;

export type RetryResult = { ok: true; status: number; body: { comment: CommentDto } } | ServiceFailure;

/** One re-arm of the same filing, or the coded refusal that says why not. */
export function retryComment(deps: RetryDeps, comment: CommentRow, author: RetryAuthor): RetryResult {
  // The posting path's first line: a blocked author reaches no model through any door.
  if (author.blocked !== 0) {
    return fail(403, 'BLOCKED', 'замечания от этого автора не принимаются');
  }
  // Another reader's row is not found — a 403 would tell them the filing exists.
  if (comment.identity_id !== author.id) return fail(404, 'NOT_FOUND', 'нет такого замечания');

  const now = deps.now();
  const at = now.toISOString();
  const nowMs = now.getTime();
  // The one derivation of the filing's state (repo.ts), so the door and the button agree: the
  // armed change is the newest one, and a landing is never re-armed.
  const dto = toCommentDto(deps.db, comment, nowMs);
  const { landed, attempt } = filingChanges(deps.db, comment.id, comment.change_id);
  const change = decisiveChange({ landed, attempt });
  const offer = retryOffer(deps.db, {
    row: comment,
    status: dto.status,
    refusal: dto.refusal,
    change,
    landed: landed !== undefined,
  });
  if (!offer.retryable || offer.because === null) {
    return fail(409, RETRY_NOT_OFFERED, offer.closed === 'cap' ? RETRY_CAP_MESSAGE : RETRY_REFUSED_MESSAGE);
  }

  // The change the state was read from is the one that goes back to the queue. A filing that
  // never became a change has none to re-arm: its ladder alone is re-opened and triage reads it.
  const changeId = change === undefined ? null : change.id;
  const because = offer.because;

  const written = deps.db.transaction((): number | null => {
    // Conditional on the row still standing where this call read it: a second retry that raced
    // us lost, and says so instead of writing over the winner's re-arm.
    const moved = deps.db
      .prepare(
        `UPDATE comments
            SET status = 'new', reason = NULL, decided_at = NULL, batch_id = NULL,
                disposition = NULL, lock = NULL, carrier_kind = NULL, quote_kept = NULL,
                change_id = COALESCE(?, change_id)
          WHERE id = ? AND status = ?`,
      )
      .run(changeId, comment.id, comment.status).changes;
    if (moved !== 1) return null;

    if (changeId !== null && change !== undefined) {
      // The same change row, not a second one: one filing may never become two changes, and the
      // lane's history for this filing stays one line with two attempts. `attempts` restarts
      // because this is a fresh window, not the fourth try of a closed one.
      const armed = deps.db
        .prepare(
          `UPDATE changes
              SET status = 'pending', outcome = NULL, reason = NULL, started_at = NULL,
                  finished_at = NULL, cascade_id = NULL, attempts = 0
            WHERE id = ? AND status = ?`,
        )
        .run(changeId, change.status).changes;
      if (armed !== 1) return null;
      // The queue place the arm promises, in the engine's own vocabulary: the bridge narrates it
      // as `change:queued` and the chronicle gets its tick.
      appendChangeEvent(deps.db, changeId, 'queued', { chapter: comment.chapter, retry: true }, nowMs);
      appendEvent(
        deps.db,
        {
          kind: 'change.queued',
          changeId,
          chapter: comment.chapter,
          authorKind: 'reader',
          payload: { retry: true },
        },
        nowMs,
      );
    }

    const row = readCommentRow(deps.db, comment.id);
    if (row === undefined) return null;
    // A fresh ladder: `n` is the next number of this filing, `tries` starts at 0, and the row is
    // `submitted` because the outcome is not known until the read answers or breaks again.
    const n = recordAttempt(deps.db, row, at);
    appendCommentEvent(deps.db, comment.id, 'retry', at, {
      n,
      because,
      // What the reader's row said when we gave up: the failure and the reading stay on the
      // record even though the columns they lived in are cleared for the next read.
      was: { status: comment.status, reason: comment.reason, disposition: comment.disposition },
    });
    return n;
  })();

  if (written === null) return fail(409, 'NOT_RETRYABLE', 'это замечание уже повторено');
  const row = readCommentRow(deps.db, comment.id);
  if (row === undefined) return fail(500, 'INTERNAL', 'замечание не сохранилось');
  return { ok: true, status: 200, body: { comment: toCommentDto(deps.db, row, nowMs) } };
}
