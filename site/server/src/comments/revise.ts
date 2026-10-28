/**
 * BOOK-158 — a refused filing is revised in place, not posted again.
 *
 * A filing keeps its id, its chapter, its anchor and the revision its quote came from: a
 * revision replaces **the text** and reopens the row, so the reader's place in the book cannot
 * move between tries and the thread shows one filing with one history instead of a pile of
 * near-duplicates. The gate columns are cleared because the words they judged are gone, and both
 * gates judge the new words before the row is reopened: Gate A here (a revision must not be a way
 * to hand a model an instruction the posting path would have stopped) and Gate B in the same act
 * (`applyRights`, as at posting), so an unlawful revision is refused at once instead of turning
 * up in a batch.
 *
 * The order is the same security design as posting, and it is why a refusal costs nothing:
 * ownership → state (cooldown, the filing's day, the identity's and the network's) → identical
 * text → the text's own bounds → the gates → the write → the attempt. Nothing is stored and no
 * attempt is spent before every check has passed.
 */

import type { CommentDto, ReviseCommentInput } from '@book/shared';

import type { Db } from '../db/db.ts';
import type { IdentityRow } from '../db/repo/identities.ts';
import {
  anchorSha,
  attemptState,
  identicalAttempt,
  recordAttempt,
  setAttemptOutcome,
} from './attempts.ts';
import { fail, type ServiceFailure } from './failure.ts';
import { readFilingText } from './filing.ts';
import { commentAddedPayload } from './frame.ts';
import { classifyComment } from './guard.ts';
import { appendCommentEvent, readCommentRow, toCommentDto, type CommentRow } from './repo.ts';
import { applyRights, scanFiling } from '../rights/apply.ts';

export type ReviseDeps = {
  db: Db;
  now: () => Date;
  /** The broadcast a post makes, made by a revision too: a second tab re-reads the chapter. */
  emit?: (type: 'comment:added', data: unknown) => void;
};

/** The author a revision is judged against: the session's identity, never the request's. */
export type ReviseAuthor = Pick<IdentityRow, 'id' | 'blocked'>;

export type ReviseResult = { ok: true; status: number; body: { comment: CommentDto } } | ServiceFailure;

/** A refusal the reader may come back from: 200 with the reopened filing, or the coded refusal. */
export function reviseComment(
  deps: ReviseDeps,
  comment: CommentRow,
  author: ReviseAuthor,
  input: ReviseCommentInput,
): ReviseResult {
  // The posting path's first line, and for the same reason: a blocked author may not reach a
  // model through a revision any more than through a new filing (same sentence, same code).
  if (author.blocked !== 0) {
    return fail(403, 'BLOCKED', 'замечания от этого автора не принимаются');
  }
  // Another reader's row is not found — a 403 would tell them the filing exists.
  if (comment.identity_id !== author.id) return fail(404, 'NOT_FOUND', 'нет такого замечания');
  // BOOK-174: two states are still the reader's to rework — a refusal under a lock, and a filing
  // that waits for the author. An escalated filing is not a verdict about the words; a revision
  // withdraws it from the author's desk and puts the new words back in the queue.
  if (comment.status !== 'rejected' && comment.status !== 'escalated') {
    return fail(409, 'NOT_REVISABLE', 'поправить можно только отклонённое замечание');
  }

  const now = deps.now();
  const nowMs = now.getTime();
  const state = attemptState(deps.db, comment, nowMs);
  if (state.blocked === 'cooldown') {
    const until = state.cooldownUntil === null ? nowMs : Date.parse(state.cooldownUntil);
    return {
      ...fail(429, 'REVISE_COOLDOWN', 'слишком быстро — попробуйте ещё раз чуть позже'),
      retryAfterMs: Math.max(0, until - nowMs),
    };
  }
  if (state.blocked === 'attempts') {
    return { ...fail(429, 'ATTEMPTS_EXHAUSTED', 'исчерпаны попытки — в следующий раз'), reopenAt: state.reopenAt };
  }
  if (state.blocked === 'identity' || state.blocked === 'network') {
    // One public sentence for both caps; the route logs which one, an operator only.
    return {
      ...fail(429, 'ATTEMPT_LIMIT', 'слишком много попыток сегодня — попробуйте завтра'),
      budget: state.blocked === 'network' ? 'ip' : 'identity',
    };
  }

  const text = readFilingText({
    body: input.body,
    proposedText: input.proposedText,
    interventionKind: input.interventionKind,
  });
  if (text.ok === false) return text;

  const anchor = anchorSha(comment);
  if (identicalAttempt(deps.db, author.id, text.body.hash, anchor, nowMs)) {
    return fail(409, 'IDENTICAL', 'это уже было — поправьте формулировку');
  }

  // Gates A and B on the new words: a revision may not become a delivery route the posting path
  // closed, so both are asked before the row is reopened and both answers are stored on it.
  const guard = classifyComment(text.body.text, text.proposedText);
  const filing = { body: text.body.text, proposed: text.proposedText, quote: comment.quote };
  const scan = scanFiling(deps.db, comment.chapter, filing);
  const at = now.toISOString();
  const refusedByGuard = guard.status === 'rejected';

  const written = deps.db.transaction((): number | null => {
    // Conditional on the row still being the refused filing this call read: a second revision
    // that raced us here lost, and says so instead of overwriting the winner's text.
    //
    // BOOK-174: the four disposition columns are cleared with every other verdict. A reading is
    // a decision about the words that were refused; the revised words have not been read yet, and
    // keeping the old chain would re-refuse them under a lock nobody re-judged.
    const changed = deps.db
      .prepare(
        `UPDATE comments
            SET body = ?, body_sha = ?, proposed_text = ?, intervention_kind = ?,
                status = ?, guard = ?, flags = ?, reason = ?, decided_at = ?,
                batch_id = NULL, change_id = NULL, applied_chapter = NULL, applied_rev = NULL,
                audit_verdict = NULL, audit_reason = NULL, audited_at = NULL, audited_by = NULL,
                rights_verdict = NULL, rights_rule = NULL, rights_at = NULL, rights_by = NULL,
                rights_source = NULL, held_rule = NULL, held_by = NULL, held_at = NULL,
                disposition = NULL, lock = NULL, carrier_kind = NULL, quote_kept = NULL
          WHERE id = ? AND status IN ('rejected','escalated')`,
      )
      .run(
        text.body.text,
        text.body.hash,
        text.proposedText,
        text.kind,
        guard.status,
        guard.guard,
        JSON.stringify(guard.flags),
        refusedByGuard ? guard.reason : null,
        refusedByGuard ? at : null,
        comment.id,
      ).changes;
    if (changed !== 1) return null;
    const row = readCommentRow(deps.db, comment.id);
    if (row === undefined) return null;
    const n = recordAttempt(deps.db, row, at);
    // A revision the guard stops is already decided: its attempt is closed with the answer.
    if (guard.status === 'rejected') setAttemptOutcome(deps.db, comment.id, n, 'refused', at);
    else if (guard.status === 'quarantined') setAttemptOutcome(deps.db, comment.id, n, 'held', at);
    appendCommentEvent(deps.db, comment.id, 'revised', at, { n, body_sha: text.body.hash });
    return n;
  })();

  if (written === null) return fail(409, 'NOT_REVISABLE', 'это замечание уже поправлено');
  // Gate B's write, as at posting: a refusal is one act with its sentence (and closes the
  // attempt), a flag leaves the row undecided for the batch boundary to pick up, and a clean
  // scan records CLEAR so the row can be accepted.
  if (applyRights(deps.db, comment.id, comment.chapter, filing, at, scan) === 'refused') {
    setAttemptOutcome(deps.db, comment.id, written, 'refused', at);
  }
  const row = readCommentRow(deps.db, comment.id);
  if (row === undefined) return fail(500, 'INTERNAL', 'замечание не сохранилось');
  const dto = toCommentDto(deps.db, row, nowMs);
  // The same broadcast a post makes: a second tab reloads this chapter instead of keeping the
  // frozen cooldown it was told at the last read.
  deps.emit?.('comment:added', commentAddedPayload(dto));
  return { ok: true, status: 200, body: { comment: dto } };
}
