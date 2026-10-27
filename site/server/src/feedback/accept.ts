/**
 * Acceptance → a queued change, or — on the frozen frame — paperwork (ARCHITECTURE.md §12.1,
 * §12.6; BOOK-137).
 *
 * Acceptance is a promise, not a result: the comment becomes a `changes` row with an
 * *intent* and a base revision, and the FIFO lane applies it later. Both the host CLI and
 * the site's decisions tailer call this one function, so a change has exactly one shape no
 * matter which process wrote it, and re-running a decision is a no-op.
 *
 * BOOK-137: a filing that **touched** the frozen frame (ch01's opening sentence, ch67's
 * finale) is accepted as paperwork: a `changes` row with `frame='touched'`, a paperwork mode,
 * `status='done'` and `outcome='registered'` — no step, no ripple, no lane. The sentence's
 * letters are not touched by anything here; the land guard (`engine/write.ts`) is what keeps
 * them, and this row is the record that the world was told so. A filing beside the frame is an
 * ordinary change that carries its mark.
 *
 * Insert and link happen in one transaction: a crash can never leave a queued change with
 * no comment pointing at it (or a comment "accepted" with nothing in the queue).
 *
 * BOOK-9: acceptance also requires a recorded auditor verdict `FITS` on the comment. The
 * check lives here, not in a caller, so the CLI and the decisions tailer cannot skip it; the
 * one other creator of a `changes` row that names a comment — the internal queue route — asks
 * the same question (`engine/queue.ts`). A row that already points at a change keeps its
 * idempotent answer (pre-BOOK-9 rows are read, never re-decided).
 *
 * BOOK-61: three columns, three writers, no default — `status <> 'quarantined'` (A),
 * `rights_verdict = 'CLEAR'` (B), `audit_verdict = 'FITS'` (C). A gate that has not spoken is
 * a refusal, not a pass; `AUDIT_REQUIRED`, `RIGHTS_REQUIRED` and `QUARANTINED` name which one.
 */

import {
  DEFAULT_FRAME_MODE,
  classifyFrame,
  framePaperworkReason,
  normalizeFrameMark,
  normalizeInterventionKind,
  type FrameMark,
  type RetroMode,
} from '@book/shared';

import { insertChange } from '../engine/store.ts';
import { PREMISE_SUPERSEDED_REASON, admitPremise } from '../engine/premise.ts';
import type { Db } from '../db/db.ts';
import { appendCommentEvent, readBlock, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { newChangeId } from '../util/ulid.ts';

export type AcceptResult =
  | { changeId: string; created: boolean; superseded?: boolean }
  | {
      error: string;
      /**
       * BOOK-61/BOOK-137 — which gate refused: A's hold, B's rights, C's auditor. The frozen
       * frame is no longer a refusal here: a touched filing is accepted as paperwork.
       */
      code?: 'AUDIT_REQUIRED' | 'RIGHTS_REQUIRED' | 'QUARANTINED';
    };

export type AcceptInput = {
  comment: CommentRow;
  intent: string;
  at: string;
  reason: string;
  /**
   * BOOK-137 — the paperwork mode the caller named for a filing that touches the frame;
   * `null`/absent takes `DEFAULT_FRAME_MODE` (`оформление`). A mode on any other filing is
   * ignored: a text change has no paperwork to file.
   */
  frameMode?: RetroMode | null;
  changeId?: string | null;
  baseRev?: number | null;
  batch?: string | null;
};

type ChapterRow = { rev: number; sha256: string; basis: number; block_count: number };

/** A revision is 1..n; 0 is the premise base and never a base for text that exists. */
function positiveRev(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The one frame rule (BOOK-137): the mark the comment carries, or — for a row stored before
 * v14, which carries none — the same classifier applied to the stored anchor and the chapter's
 * projection. One helper, never a second rule.
 */
function frameMarkOf(db: Db, comment: CommentRow, chapter: ChapterRow | undefined): FrameMark {
  const stored = normalizeFrameMark(comment.frame);
  if (stored !== null) return stored;
  const block = comment.block_id === null ? undefined : readBlock(db, comment.block_id);
  return classifyFrame({
    chapter: comment.chapter,
    quote: comment.quote,
    blockIndex: block?.idx ?? comment.block_idx,
    blockText: block?.text ?? null,
    blockCount: chapter?.block_count ?? 0,
  });
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

    // BOOK-61: three columns, three writers, no default. A held row was never read by a model;
    // a row with no rights verdict is not cleared; only a granted right and a recorded FITS
    // make a change. The order is the order of the gates — A, then B, then C.
    if (comment.status === 'quarantined') {
      return { code: 'QUARANTINED', error: 'замечание ещё проверяется — правку из него не делают' };
    }
    if (comment.rights_verdict !== 'CLEAR') {
      return {
        code: 'RIGHTS_REQUIRED',
        error: 'право на текст не подтверждено — правку из него не делают',
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

    const chapter = db
      .prepare('SELECT rev, sha256, basis, block_count FROM chapters WHERE n = ?')
      .get(comment.chapter) as ChapterRow | undefined;
    const changeId = input.changeId ?? newChangeId(Date.parse(input.at));
    const existing = db.prepare('SELECT id FROM changes WHERE id = ?').get(changeId) as { id: string } | undefined;

    // BOOK-137: a filing that touches the frozen frame is accepted as paperwork — recorded,
    // done, and never handed to the lane. The mark comes from the row (or, for a pre-v16 row,
    // from the same classifier over the anchor).
    const mark = frameMarkOf(db, comment, chapter);
    if (mark === 'touched') {
      return register(db, {
        comment,
        chapter,
        changeId,
        existing: existing !== undefined,
        intent: input.intent,
        at: input.at,
        mode: input.frameMode ?? DEFAULT_FRAME_MODE,
        batch: input.batch ?? null,
        baseRev: positiveRev(input.baseRev),
      });
    }

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
          frame: mark,
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
      const seq = insertChange(db, {
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
        // BOOK-137: an ordinary change carries the mark its filing carried, so the history can
        // tell an edit beside the frame from an edit of it.
        frame: mark,
        enqueuedAt: input.at,
      });
      // BOOK-65: a change written through the interface is a public record entry, so its
      // clock row is written here, in the same transaction — exactly as `engine/queue.ts`
      // does for a change it enqueues and `admitPremise` does for a premise. Without this
      // line the ordinary acceptance path produced a change with no place on the clock and
      // the record stayed empty while `history.live` was already true.
      //
      // A corrupt `decisions.jsonl` line can carry a non-ISO `at` (`parseDecision` passes it
      // through), and `readNewLines` advances its offset before this call: throwing here would
      // drop the rest of the chunk. So the clock falls back to now rather than fail; the row's
      // own `enqueued_at` and the comment's `decided_at` keep the stored string unchanged.
      const parsedAt = Date.parse(input.at);
      const atMs = Number.isFinite(parsedAt) ? parsedAt : Date.now();
      appendChangeEvent(db, changeId, 'queued', { chapter: comment.chapter, kind: 'accepted_comment' }, atMs);
      appendEvent(
        db,
        {
          kind: 'change.queued',
          changeId,
          chapter: comment.chapter,
          authorKind: 'reader',
          payload: { seq, intent: input.intent },
        },
        atMs,
      );
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

/**
 * The paperwork branch of an acceptance (BOOK-137): a `done` change with `outcome='registered'`,
 * one `registered` event and a comment that says «рассмотрено». No step, no cascade, no lane,
 * no `queued` event — this change was never text, so nothing may think it is.
 */
function register(
  db: Db,
  input: {
    comment: CommentRow;
    chapter: ChapterRow | undefined;
    changeId: string;
    existing: boolean;
    intent: string;
    at: string;
    mode: RetroMode;
    batch: string | null;
    baseRev: number | null;
  },
): AcceptResult {
  const { comment, chapter } = input;
  const reason = framePaperworkReason(input.mode);
  const atMs = Number.isFinite(Date.parse(input.at)) ? Date.parse(input.at) : Date.now();
  // A replay: the change is already there, so the row, its `registered` event and the comment
  // event all exist. Writing any of them again would tell the reader something happened twice.
  if (input.existing) return { changeId: input.changeId, created: false };
  // A basis slot has no prose to record as a base: the projection's block list is empty, and
  // the revision is the comment's own or the chapter's (0 for a slot that only holds its
  // sentence).
  const blocks =
    chapter === undefined || chapter.basis !== 0
      ? []
      : (db.prepare('SELECT hash FROM blocks WHERE chapter = ? ORDER BY idx').all(comment.chapter) as Array<{
          hash: string;
        }>);
  insertChange(db, {
    id: input.changeId,
    kind: 'accepted_comment',
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
    baseRev: input.baseRev ?? positiveRev(comment.base_rev) ?? chapter?.rev ?? 0,
    baseSha: chapter?.sha256 ?? '',
    baseBlocks: JSON.stringify(blocks.map((block) => block.hash)),
    scopeHint: 'phrase',
    premise: 0,
    frame: 'touched',
    frameMode: input.mode,
    status: 'done',
    outcome: 'registered',
    reason,
    finishedAt: input.at,
    enqueuedAt: input.at,
  });
  appendChangeEvent(db, input.changeId, 'registered', { frame: 'touched', mode: input.mode }, atMs);

  db.prepare(
    `UPDATE comments
        SET status = 'registered', decided_at = ?, reason = ?, batch_id = COALESCE(?, batch_id), change_id = ?
      WHERE id = ?`,
  ).run(input.at, reason, input.batch, input.changeId, comment.id);
  appendCommentEvent(db, comment.id, 'decided', input.at, {
    status: 'registered',
    changeId: input.changeId,
    frame: 'touched',
    mode: input.mode,
  });
  return { changeId: input.changeId, created: true };
}
