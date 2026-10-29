/**
 * `feedback.mjs audit` — Gate C's verdict and its one writer (BOOK-9, BOOK-61, BOOK-174).
 *
 * It lives beside `cli.ts` for the same reason `decide.ts` does: the argv shape and the act are
 * two jobs, and the operator module has to stay one screen long.
 */

import { validateReason, type CommentAuditVerdict } from '@book/shared';

import { openAttempt } from '../comments/attempts.ts';
import { readCommentRow } from '../comments/repo.ts';
import { readAnswer } from './answer.ts';
import { recordAudit } from './audit.ts';
import { chargeTriageSpend, spendFromFlags } from './triage.ts';
import { operatorLabel, type OperatorArgs, type OperatorIo } from './operator.ts';

/**
 * `audit <commentId> --verdict FITS|OFF --reason "…" [--by label]` (BOOK-9), or the auditor's
 * own answer: `audit <commentId> --answer <json | @file | ->` (BOOK-61 review B2).
 *
 * The verdict is recorded once, before triage, and no change exists without `FITS`. BOOK-206:
 * `OFF` **records and leaves** — the row keeps its state and the automatic applier places the
 * reading the answer carried, so this command writes no decision line and closes no attempt.
 * The auditor's own note stays for the operator (`audit_reason`). An `--answer` is parsed and
 * post-checked against the batch's envelope first: a malformed answer, or a quote that is not
 * in the field it names, records nothing and exits 1.
 */
export function audit(parsed: OperatorArgs, io: OperatorIo, now: () => Date): number {
  const commentId = parsed.positionals[0];
  const answer = parsed.flags.get('answer');
  const flagVerdict = parsed.flags.get('verdict');
  const rawReason = parsed.flags.get('reason');
  if (commentId === undefined) {
    io.print('usage: feedback.mjs audit <commentId> --verdict FITS|OFF --reason "…" [--by label]');
    io.print('       feedback.mjs audit <commentId> --answer <json | @file | ->');
    return 2;
  }

  let verdict: CommentAuditVerdict;
  let reason: string | null;
  if (answer !== undefined) {
    // A model's answer and an operator's decision are two paths, never one call.
    if (flagVerdict !== undefined || rawReason !== undefined) {
      io.print('refused: --answer carries the verdict and its reason; do not add --verdict/--reason');
      return 2;
    }
    const read = readAnswer({ db: io.db, dir: io.dir, commentId, gate: 'C', raw: answer });
    if (!read.ok) {
      io.print(`refused (${read.code}): ${read.message}`);
      return 1;
    }
    verdict = read.verdict.verdict === 'OFF' ? 'OFF' : 'FITS';
    // Gate C's `OFF` carries the reader's line inside the object; the parser required it.
    reason = read.verdict.reason;
  } else {
    if (flagVerdict !== 'FITS' && flagVerdict !== 'OFF') {
      io.print('usage: feedback.mjs audit <commentId> --verdict FITS|OFF --reason "…" [--by label]');
      return 2;
    }
    verdict = flagVerdict;
    const checked = rawReason === undefined ? null : validateReason(rawReason);
    if (checked !== null && !checked.ok) {
      io.print(`refused: ${checked.reason}`);
      return 1;
    }
    reason = checked === null ? null : checked.reason;
  }

  const comment = readCommentRow(io.db, commentId);
  if (comment === undefined) {
    io.print(`unknown comment: ${commentId}`);
    return 1;
  }
  if (comment.audit_verdict !== null) {
    io.print(`refused: ${commentId} already has a verdict (first verdict wins)`);
    return 1;
  }
  if (comment.decided_at !== null) {
    io.print(`refused: ${commentId} is already decided — triage is not audited after the fact`);
    return 1;
  }
  const label = operatorLabel(parsed, io);
  if (label === null) return 1;
  const by = label.length === 0 ? null : label;

  const at = now().toISOString();
  if (verdict === 'OFF' && reason === null) {
    io.print('refused: OFF needs --reason "…" — the reader sees that line as the refusal');
    return 1;
  }
  // BOOK-158: Gate C's `OFF` is the answer to a submitted attempt — it closes it, and the model
  // call that wrote the line is a `triage` pass in the money ledger. The flags are read before
  // the verdict is written, so a bad value refuses the call instead of half-applying it.
  const spend = verdict === 'OFF' ? spendFromFlags(parsed.flags) : null;
  if (spend !== null && 'error' in spend) {
    io.print(`refused: ${spend.error}`);
    return 2;
  }
  const recorded = recordAudit(io.db, { commentId: comment.id, verdict, reason, by, at });
  if (!recorded.ok) {
    io.print(`refused (${recorded.code}): ${recorded.message}`);
    return 1;
  }
  if (verdict === 'OFF') {
    // BOOK-206: the row is left exactly as it is — no line, no status, no closed attempt — so
    // the automatic applier can place the reading. The model call is still charged: it was paid.
    if (spend !== null && 'spend' in spend) {
      const open = openAttempt(io.db, comment.id);
      if (open !== undefined) {
        chargeTriageSpend(io.db, {
          chapter: comment.chapter,
          passId: `triage:${comment.id}:${String(open.n)}`,
          at,
          ...spend.spend,
        });
      }
    }
    io.print(`${comment.id}: OFF записан · чтение вынесет триаж`);
    return 0;
  }
  io.print(`${comment.id}: FITS · можно решать`);
  return 0;
}
