/**
 * The two operator acts of Gate A (BOOK-61, BOOK-DOC-42 §5), and the view of what they hold.
 *
 * `hold` is the write the A pass makes — the filing becomes `quarantined` with the rule that
 * stopped it — and `release` is the operator's undo (BOOK-43): HELD → `new` with a `released`
 * event, so the row appears in the next batch. Neither calls a model, and neither invents a
 * verdict: a decided row is closed, a first hold wins, a released row keeps the record.
 *
 * The module takes the CLI's parsed flags and printer structurally, so `cli.ts` stays the one
 * place that knows the argv shape and this file stays one screen long.
 */

import {
  COMMENT_AUDITED_BY_MAX_CHARS,
  COMMENT_REASON_MAX_CHARS,
  INJECTION_RULES,
  validateReason,
  type CommentAuditVerdict,
  type InjectionRule,
} from '@book/shared';

import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';
import { recordAudit } from './audit.ts';
import { appendDecision } from './decisionsFile.ts';
import { RIGHTS_FLAG, recordRights } from '../rights/record.ts';
import { isReleasableRights, isRightsRule, RIGHTS_RULES, type RightsRuleId } from '../rights/rules.ts';
import { readAnswer } from './answer.ts';
import { filingValues, listCommentsByStatus } from './batches.ts';
import { ENVELOPE_FIELDS, quoteIn, type EnvelopeField } from './envelope.ts';
import { settleAttempt, spendFromFlags } from './triage.ts';

export type OperatorArgs = {
  positionals: string[];
  flags: Map<string, string>;
};

export type OperatorIo = {
  db: Db;
  /** The feedback exchange directory — where a batch file (and so a `--answer`) is read. */
  dir: string;
  print: (line: string) => void;
};

/** The statuses a hold may not touch: a decided row is closed, and no gate reopens it. */
const DECIDED_STATUSES = new Set(['accepted', 'applied', 'superseded', 'rejected', 'expired', 'hidden']);

/** `inbox --held`: HELD is not a black hole (BOOK-43) — the operator sees what stopped, and why. */
export function heldInbox(parsed: OperatorArgs, io: OperatorIo): number {
  const limit = intFlag(parsed.flags.get('limit'), 50);
  const rows = listCommentsByStatus(io.db, 'quarantined', limit);
  if (rows.length === 0) {
    io.print('no held comments');
    return 0;
  }
  for (const row of rows) {
    io.print(
      `${row.id}  ch${String(row.chapter).padStart(2, '0')}  ${row.held_rule ?? '—'}  ` +
        `${row.held_by ?? '—'}  ${row.created_at}`,
    );
  }
  return 0;
}

/**
 * `hold <commentId> --rule <INJ-…> --evidence <field>:<quote> [--by label]`.
 *
 * The evidence must be a quote that really sits in the field it names — the same post-check a
 * model's verdict passes — so an operator cannot record a hold on words the filing does not
 * contain. Idempotent: a row already held keeps its first rule and gains no second event.
 */
export function hold(parsed: OperatorArgs, io: OperatorIo, now: () => Date): number {
  const commentId = parsed.positionals[0];
  const rule = parsed.flags.get('rule');
  const rawEvidence = parsed.flags.get('evidence');
  if (commentId === undefined || rule === undefined || rawEvidence === undefined) {
    io.print('usage: feedback.mjs hold <commentId> --rule <INJ-…> --evidence <field>:<quote> [--by label]');
    return 2;
  }
  if (!INJECTION_RULES.includes(rule as InjectionRule)) {
    io.print(`refused (RULE_UNKNOWN): ${rule} is not one of ${INJECTION_RULES.join('|')}`);
    return 1;
  }
  const evidence = parseEvidence(rawEvidence);
  if (evidence === null) {
    io.print(`usage: --evidence must look like text:«…» — one of ${ENVELOPE_FIELDS.join('|')}`);
    return 2;
  }
  const comment = readCommentRow(io.db, commentId);
  if (comment === undefined) {
    io.print(`unknown comment: ${commentId}`);
    return 1;
  }
  const label = operatorLabel(parsed, io);
  if (label === null) return 1;
  if (comment.status === 'quarantined') {
    io.print(`${comment.id}: already held (${comment.held_rule ?? '—'})`);
    return 0;
  }
  if (comment.decided_at !== null || DECIDED_STATUSES.has(comment.status)) {
    io.print(`refused: ${comment.id} is already decided — a hold is not a verdict on a closed row`);
    return 1;
  }
  const values = filingValues(comment);
  if (!quoteIn(values[evidence.field], evidence.quote)) {
    io.print(`refused (POSTCHECK_FAILED): the quote is not in «${evidence.field}» of ${comment.id}`);
    return 1;
  }
  const at = now().toISOString();
  const changed = io.db
    .prepare(
      // BOOK-61 review m6: acceptance may move the row between the read above and this write,
      // so the status is part of the condition, not only of the earlier check.
      `UPDATE comments SET status = 'quarantined', held_rule = ?, held_by = 'classifier', held_at = ?
        WHERE id = ? AND status IN ('new','batched','delivered')`,
    )
    .run(rule, at, comment.id).changes;
  if (changed === 0) {
    io.print(`${comment.id}: already held`);
    return 0;
  }
  appendCommentEvent(io.db, comment.id, 'held', at, {
    rule,
    field: evidence.field,
    quote: evidence.quote,
    by: label.length === 0 ? 'classifier' : label,
  });
  // BOOK-158: the attempt this hold answers is closed as `held` — no model call, no charge.
  settleAttempt(io.db, { commentId: comment.id, chapter: comment.chapter, outcome: 'held', at });
  io.print(`${comment.id}: held ${rule} · замечание сохранено и ждёт человека`);
  return 0;
}

/**
 * `inbox --rights`: rows a scan flagged. `rights_verdict` is null on purpose — a flag is not a
 * verdict — so this is the one inbox that must be emptied before those rows can be decided.
 */
export function rightsInbox(parsed: OperatorArgs, io: OperatorIo): number {
  const limit = intFlag(parsed.flags.get('limit'), 50);
  const rows = io.db
    .prepare(
      `SELECT * FROM comments
        WHERE rights_verdict IS NULL
          AND EXISTS (SELECT 1 FROM json_each(comments.flags) WHERE json_each.value = ?)
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(RIGHTS_FLAG, limit) as CommentRow[];
  if (rows.length === 0) {
    io.print('no comments waiting for a rights verdict');
    return 0;
  }
  for (const row of rows) {
    io.print(`${row.id}  ch${String(row.chapter).padStart(2, '0')}  ${RIGHTS_FLAG}  ${row.created_at}`);
  }
  return 0;
}

/**
 * `audit <commentId> --verdict FITS|OFF --reason "…" [--by label]` (BOOK-9), or the auditor's
 * own answer: `audit <commentId> --answer <json | @file | ->` (BOOK-61 review B2).
 *
 * The verdict is recorded once, before triage. `OFF` is also the refusal: the comment becomes
 * `rejected` with the auditor's plain reason and a decision line, exactly like any other
 * refusal, and no change exists. `FITS` only permits a later `decide`. An `--answer` is parsed
 * and post-checked against the batch's envelope first: a malformed answer, or a quote that is
 * not in the field it names, records nothing and exits 1.
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
    if (spend !== null && 'spend' in spend) {
      settleAttempt(io.db, { commentId: comment.id, chapter: comment.chapter, outcome: 'refused', at, spend: spend.spend });
    }
    appendDecision(io.dir, {
      id: comment.id,
      status: 'rejected',
      reason,
      at,
      batch: comment.batch_id,
      changeId: null,
    });
    io.print(`${comment.id}: OFF · отклонено, читатель увидит причину`);
    return 0;
  }
  io.print(`${comment.id}: FITS · можно решать`);
  return 0;
}

/**
 * `rights <commentId> --verdict CLEAR|REFUSED --rule <id> [--source "…"] [--by label]` — the
 * rights gate's write (BOOK-DOC-42 §3, §5) — or the same act from the model's own answer:
 * `rights <commentId> --answer <json | @file | ->` (BOOK-61 review B2).
 *
 * Both paths end in the same write, and both are bound to the closed table: a refusal names an
 * id from `rights/rules.ts` or it is not recorded at all. `RIGHTS-PARAPHRASE` is allowed
 * **only** with a named source, because an unnamed suspicion is not a refusal — it escalates,
 * and the row stays undecided, which the acceptance gate reads as "no". `CLEAR` names no rule.
 * An `--answer` is parsed and post-checked against the batch's own envelope before anything is
 * recorded: a malformed answer, or a quote that is not in the field it names, records nothing.
 */
export function rights(parsed: OperatorArgs, io: OperatorIo, now: () => Date): number {
  const commentId = parsed.positionals[0];
  const answer = parsed.flags.get('answer');
  const flagVerdict = parsed.flags.get('verdict');
  const flagRule = parsed.flags.get('rule') ?? null;
  if (commentId === undefined) {
    io.print('usage: feedback.mjs rights <commentId> --verdict CLEAR|REFUSED --rule <id> [--source "…"] [--by label]');
    io.print('       feedback.mjs rights <commentId> --answer <json | @file | ->');
    return 2;
  }

  let verdict: 'CLEAR' | 'REFUSED';
  let rule: string | null;
  if (answer !== undefined) {
    // The model's own answer and the operator's decision are two paths, never one call.
    if (flagVerdict !== undefined || flagRule !== null) {
      io.print('refused: --answer carries the verdict, its rule and its evidence; do not add --verdict/--rule');
      return 2;
    }
    const read = readAnswer({ db: io.db, dir: io.dir, commentId, gate: 'B', raw: answer });
    if (!read.ok) {
      io.print(`refused (${read.code}): ${read.message}`);
      return 1;
    }
    verdict = read.verdict.verdict === 'CLEAR' ? 'CLEAR' : 'REFUSED';
    rule = read.verdict.rule;
  } else {
    if (flagVerdict !== 'CLEAR' && flagVerdict !== 'REFUSED') {
      io.print('usage: feedback.mjs rights <commentId> --verdict CLEAR|REFUSED --rule <id> [--source "…"] [--by label]');
      return 2;
    }
    verdict = flagVerdict;
    rule = flagRule;
    if (verdict === 'CLEAR' && rule !== null) {
      io.print('refused: CLEAR names no rule — a clearance is not a refusal');
      return 2;
    }
    if (verdict === 'REFUSED') {
      if (rule === null) {
        io.print(`usage: REFUSED needs --rule, one of ${RIGHTS_RULES.join('|')}`);
        return 2;
      }
      if (!isRightsRule(rule)) {
        io.print(`refused (RULE_UNKNOWN): ${rule} is not in the rights table`);
        return 1;
      }
    }
  }
  const source = (parsed.flags.get('source') ?? '').replace(/\s+/gu, ' ').trim();
  if (source.length > COMMENT_REASON_MAX_CHARS) {
    io.print(`refused: --source is longer than ${COMMENT_REASON_MAX_CHARS} characters`);
    return 1;
  }
  if (verdict === 'REFUSED' && rule === 'RIGHTS-PARAPHRASE' && source.length === 0) {
    // An unnamed suspicion is not a refusal (BOOK-DOC-42 §3): refuse the write, keep the row
    // undecided, and let the escalation decide.
    io.print('refused (RIGHTS_SOURCE_REQUIRED): RIGHTS-PARAPHRASE needs --source "название или автор"');
    return 1;
  }
  const comment = readCommentRow(io.db, commentId);
  if (comment === undefined) {
    io.print(`unknown comment: ${commentId}`);
    return 1;
  }
  if (comment.status === 'quarantined') {
    io.print(`refused (RIGHTS_HELD): ${comment.id} is held — a model has not read it`);
    return 1;
  }
  const label = operatorLabel(parsed, io);
  if (label === null) return 1;
  const at = now().toISOString();
  const recorded = recordRights(io.db, {
    commentId: comment.id,
    verdict,
    rule: verdict === 'REFUSED' ? (rule as RightsRuleId) : null,
    source: 'model',
    by: label.length === 0 ? null : label,
    at,
    ...(source.length === 0 ? {} : { sourceText: source }),
  });
  if (!recorded.ok) {
    io.print(`refused (${recorded.code}): ${recorded.message}`);
    return 1;
  }
  io.print(
    verdict === 'REFUSED'
      ? `${comment.id}: REFUSED ${rule} · не принято, читатель увидит строку`
      : `${comment.id}: CLEAR · право подтверждено — можно решать`,
  );
  return 0;
}

/**
 * `release <commentId> --reason "…" [--by label]` — HELD → `new`, a `released` event with the
 * reason, `held_by='operator'`, the guard's flags kept. The row appears in the next batch.
 *
 * BOOK-61 adds Gate B's releasable refusals here and nowhere else: a `RIGHTS-QUOTE` or
 * `RIGHTS-PARAPHRASE` refusal goes back to `new` and the operator's clearance replaces the
 * model's (the record of what was released stays in `rights_rule` and the event). A stop-list
 * or real-person refusal is **not** releasable — a false positive is fixed by editing the list,
 * never by an exception.
 */
export function release(parsed: OperatorArgs, io: OperatorIo, now: () => Date): number {
  const commentId = parsed.positionals[0];
  const rawReason = parsed.flags.get('reason');
  if (commentId === undefined || rawReason === undefined) {
    io.print('usage: feedback.mjs release <commentId> --reason "…" [--by label]');
    return 2;
  }
  const label = operatorLabel(parsed, io);
  if (label === null) return 1;
  const checked = validateReason(rawReason);
  if (!checked.ok) {
    io.print(`refused: ${checked.reason}`);
    return 1;
  }
  const comment = readCommentRow(io.db, commentId);
  if (comment === undefined) {
    io.print(`unknown comment: ${commentId}`);
    return 1;
  }
  if (comment.status === 'rejected' && comment.rights_verdict === 'REFUSED') {
    return releaseRights(io, comment, checked.reason, label, now().toISOString());
  }
  if (comment.status !== 'quarantined') {
    io.print(`refused: ${comment.id} is not held (status ${comment.status})`);
    return 1;
  }
  const at = now().toISOString();
  const changed = io.db
    .prepare(`UPDATE comments SET status = 'new', held_by = 'operator' WHERE id = ? AND status = 'quarantined'`)
    .run(comment.id).changes;
  if (changed === 0) {
    io.print(`refused: ${comment.id} moved on — nothing released`);
    return 1;
  }
  appendCommentEvent(io.db, comment.id, 'released', at, {
    reason: checked.reason,
    rule: comment.held_rule,
    by: label,
  });
  io.print(`${comment.id}: released · замечание снова в очереди`);
  return 0;
}

/**
 * The operator's override of a rights refusal. The two provenance refusals — `RIGHTS-QUOTE` and
 * `RIGHTS-PARAPHRASE` — are releasable (BOOK-61 review B5): a model judged a text it could
 * misread, and an operator who can name the source may lift it. Everything else in the table is
 * the law or a real person, and a false positive there is a list edit. The rule and its time
 * stay on the row; `rights_source` becomes `operator` and the verdict `CLEAR`, so the row can be
 * accepted without pretending nobody spoke.
 */
function releaseRights(
  io: OperatorIo,
  comment: CommentRow,
  reason: string,
  label: string,
  at: string,
): number {
  const rule = comment.rights_rule ?? '';
  if (!isReleasableRights(rule)) {
    io.print(
      `refused (RIGHTS_STOPLIST): ${rule === '' ? '—' : rule} не снимается — ошибка в списке ` +
        'исправляется правкой списка, не исключением',
    );
    return 1;
  }
  const changed = io.db
    .prepare(
      `UPDATE comments
          SET status = 'new', decided_at = NULL, rights_verdict = 'CLEAR',
              rights_source = 'operator', rights_by = ?, rights_at = ?
        WHERE id = ? AND status = 'rejected' AND rights_verdict = 'REFUSED'
          AND rights_rule IN ('RIGHTS-QUOTE','RIGHTS-PARAPHRASE')`,
    )
    .run(label, at, comment.id).changes;
  if (changed === 0) {
    io.print(`refused: ${comment.id} moved on — nothing released`);
    return 1;
  }
  appendCommentEvent(io.db, comment.id, 'released', at, { reason, rule, by: label, rights: true });
  io.print(`${comment.id}: released ${rule} · замечание снова в очереди`);
  return 0;
}

/** `--by label`: the operator/session name recorded with the act; `''` means anonymous. */
function operatorLabel(parsed: OperatorArgs, io: OperatorIo): string | null {
  const label = (parsed.flags.get('by') ?? '').replace(/\s+/gu, ' ').trim();
  if (label.length > COMMENT_AUDITED_BY_MAX_CHARS) {
    io.print(`refused: --by is longer than ${COMMENT_AUDITED_BY_MAX_CHARS} characters`);
    return null;
  }
  return label;
}

/** `--evidence <field>:<quote>`: the first colon splits the two, so a quote may hold its own. */
function parseEvidence(raw: string): { field: EnvelopeField; quote: string } | null {
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const field = raw.slice(0, at).trim();
  const quote = raw.slice(at + 1).trim();
  if (quote.length === 0) return null;
  if (!ENVELOPE_FIELDS.includes(field as EnvelopeField)) return null;
  return { field: field as EnvelopeField, quote };
}

function intFlag(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
