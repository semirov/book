/**
 * The auditor's verdict as data (ARCHITECTURE.md §8 row 35, BOOK-9).
 *
 * Before triage may accept an intervention, it is judged against the book's canvas. The
 * verdict is one fact on the comment row and it is written **once**: a second attempt is
 * refused, and the conditional `UPDATE … WHERE audit_verdict IS NULL AND decided_at IS NULL`
 * is what makes "first verdict wins" true even if two operators run at the same moment.
 *
 * `OFF` is one act with the refusal: the verdict and the reader's public reason are written
 * in a single transaction, so there is no window in which a refused intervention looks
 * acceptable. `acceptComment` reads the same column and refuses anything that is not `FITS`.
 *
 * The verdict's name never leaves the operator surface: the reader sees `reason` and `status`.
 */

import { COMMENT_AUDITED_BY_MAX_CHARS, COMMENT_REASON_MAX_CHARS, type CommentAuditVerdict } from '@book/shared';

import { appendCommentEvent } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';

export type AuditVerdict = CommentAuditVerdict;

export type RecordAuditInput = {
  commentId: string;
  verdict: AuditVerdict;
  /** Required for `OFF` (the reader sees it), optional for `FITS`. Already validated. */
  reason: string | null;
  /** The operator/session label, ≤64 chars; null when unnamed. */
  by: string | null;
  at: string;
};

export type AuditFailureCode =
  | 'AUDIT_UNKNOWN_COMMENT'
  | 'AUDIT_ALREADY_RECORDED'
  | 'AUDIT_ALREADY_DECIDED'
  | 'AUDIT_AFTER_HOLD'
  | 'AUDIT_REASON_REQUIRED'
  | 'AUDIT_REASON_TOO_LONG'
  | 'AUDIT_LABEL_TOO_LONG';

export type RecordAuditResult =
  | { ok: true; verdict: AuditVerdict }
  | { ok: false; code: AuditFailureCode; message: string };

type CommentAuditRow = { audit_verdict: string | null; decided_at: string | null };

/** The one writer of `comments.audit_*` (BOOK-9). */
export function recordAudit(db: Db, input: RecordAuditInput): RecordAuditResult {
  // Normalise first, then bound: a non-CLI caller must not be able to store a multi-line
  // reason that the thread would print verbatim (BOOK-9 review). One line, ≤200 characters;
  // a blank reason is no reason at all.
  const normalized = input.reason === null ? null : input.reason.replace(/\s+/gu, ' ').trim();
  const reason = normalized === null || normalized.length === 0 ? null : normalized;
  if (reason !== null && reason.length > COMMENT_REASON_MAX_CHARS) {
    return {
      ok: false,
      code: 'AUDIT_REASON_TOO_LONG',
      message: `the reason is longer than ${COMMENT_REASON_MAX_CHARS} characters`,
    };
  }
  if (input.by !== null && input.by.length > COMMENT_AUDITED_BY_MAX_CHARS) {
    return {
      ok: false,
      code: 'AUDIT_LABEL_TOO_LONG',
      message: `the auditor label is longer than ${COMMENT_AUDITED_BY_MAX_CHARS} characters`,
    };
  }

  const run = db.transaction((): RecordAuditResult => {
    // BOOK-61 (BOOK-DOC-42 §1 step 3): a held row is never audited. Gate A stopped it before
    // any model read it, so an audit would be a verdict about text nobody was allowed to read —
    // and the auditor's OFF would refuse a reader whose note was never judged. The conditional
    // UPDATE below cannot express this (a held row still has both columns null), so the status
    // is read first, inside the same transaction.
    const current = db.prepare('SELECT status FROM comments WHERE id = ?').get(input.commentId) as
      | { status: string }
      | undefined;
    if (current === undefined) {
      return { ok: false, code: 'AUDIT_UNKNOWN_COMMENT', message: `unknown comment: ${input.commentId}` };
    }
    if (current.status === 'quarantined') {
      return {
        ok: false,
        code: 'AUDIT_AFTER_HOLD',
        message: `${input.commentId} is held — a model has not read it, so it is not audited`,
      };
    }

    // An `OFF` without a public reason would refuse a reader silently: refuse the verdict.
    if (input.verdict === 'OFF' && reason === null) {
      return {
        ok: false,
        code: 'AUDIT_REASON_REQUIRED',
        message: 'OFF needs the plain reason the reader will see',
      };
    }

    const recorded = db
      .prepare(
        `UPDATE comments
            SET audit_verdict = ?, audit_reason = ?, audited_at = ?, audited_by = ?
          WHERE id = ? AND audit_verdict IS NULL AND decided_at IS NULL`,
      )
      .run(input.verdict, reason, input.at, input.by, input.commentId);
    if (recorded.changes !== 1) {
      const row = db
        .prepare('SELECT audit_verdict, decided_at FROM comments WHERE id = ?')
        .get(input.commentId) as CommentAuditRow | undefined;
      if (row === undefined) {
        return { ok: false, code: 'AUDIT_UNKNOWN_COMMENT', message: `unknown comment: ${input.commentId}` };
      }
      if (row.audit_verdict !== null) {
        return {
          ok: false,
          code: 'AUDIT_ALREADY_RECORDED',
          message: `${input.commentId} already has a verdict (first verdict wins)`,
        };
      }
      return {
        ok: false,
        code: 'AUDIT_ALREADY_DECIDED',
        message: `${input.commentId} is already decided — triage is not audited after the fact`,
      };
    }

    if (input.verdict === 'OFF') {
      // Same transaction as the verdict: the refusal cannot exist without it, or without
      // the reason the reader is owed.
      db.prepare(`UPDATE comments SET status = 'rejected', decided_at = ?, reason = ? WHERE id = ?`).run(
        input.at,
        reason,
        input.commentId,
      );
      appendCommentEvent(db, input.commentId, 'decided', input.at, { status: 'rejected' });
    }

    return { ok: true, verdict: input.verdict };
  });
  return run();
}
