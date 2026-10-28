/**
 * The one writer of `comments.rights_*` (BOOK-61, BOOK-DOC-42 §5).
 *
 * Three columns, three writers: A owns `status`/`held_*`, B owns `rights_*`, C owns `audit_*`.
 * No gate overwrites another's column, and inside a column **the first verdict wins** — the
 * conditional `UPDATE … WHERE rights_verdict IS NULL` is what makes that true when the posting
 * path and the batch boundary race for the same row. It is the same pattern `recordAudit` uses.
 *
 * A `REFUSED` is one act with the reader's line: the verdict, the status, the fixed sentence
 * (`rules.ts` — never a model's words) and the `rights` event are written in one transaction,
 * so there is no window in which an unlawful filing looks acceptable. The operator's English
 * reason and the quote never reach this column; they stay in findings and the event meta.
 * The status half is conditional on no gate having spoken yet: a held row stays held and a row
 * A rejected keeps A's reason (B1), while B's own verdict column is always written.
 *
 * A **flag** is not a verdict: it adds `rights-flag` to `flags`, writes a `rights` event, and
 * leaves the column null. A row without a verdict is never accepted, so a flag fails closed.
 */

import { COMMENT_AUDITED_BY_MAX_CHARS } from '@book/shared';

import { appendCommentEvent } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';
import { lockDecision } from '../feedback/disposition.ts';
import { storeChain } from '../feedback/dispositionStore.ts';
import { isRightsRule, rightsRefusalLine, type RightsRuleId } from './rules.ts';

export type RightsVerdict = 'CLEAR' | 'REFUSED';

/** What decided: the deterministic scan, the rights gate, or an operator. */
export type RightsSource = 'scan' | 'model' | 'operator';

/** The flag a row carries while its rights answer is still open. */
export const RIGHTS_FLAG = 'rights-flag';

export type RecordRightsInput = {
  commentId: string;
  verdict: RightsVerdict;
  /** Required for `REFUSED` (a rule id from the closed table), forbidden for `CLEAR`. */
  rule: RightsRuleId | null;
  source: RightsSource;
  /** The operator/session label, ≤64 chars; null when unnamed. */
  by: string | null;
  at: string;
  /** A named source for `RIGHTS-PARAPHRASE` (`--source`): a title or an author, operator-only. */
  sourceText?: string | null;
  /**
   * Whether the refusal may also reach the reader (status/reason/decided_at). The default is
   * `true`; the backfill passes `false` for a row already in triage, where the verdict is
   * recorded and the status is left to the pass that owns it (BOOK-61 review B3).
   */
  publishRefusal?: boolean;
};

export type RightsFailureCode =
  | 'RIGHTS_UNKNOWN_COMMENT'
  | 'RIGHTS_ALREADY_RECORDED'
  | 'RIGHTS_RULE_REQUIRED'
  | 'RIGHTS_RULE_UNKNOWN'
  | 'RIGHTS_RULE_WITH_CLEAR'
  | 'RIGHTS_LABEL_TOO_LONG';

/**
 * The statuses in which **no gate has spoken to the reader yet**. B may record its verdict on
 * any row, but it may write the reader-facing refusal (status/reason/decided) only while the
 * row is still one of these: a held row stays held with A's state, and a row A already rejected
 * keeps A's public reason — one gate never prints another's refusal (BOOK-61 review B1).
 */
const UNDECIDED_STATUSES = `('new','batched','delivered')`;

export type RecordRightsResult = { ok: true; verdict: RightsVerdict } | { ok: false; code: RightsFailureCode; message: string };

type RightsRow = { rights_verdict: string | null; flags: string | null };

/** The public flag a refusal keeps so the body is never republished (audit m5 precedent). */
function refusalFlags(rule: string): string[] {
  if (rule === 'STOP-PERSON' || rule === 'RIGHTS-PERSON') return ['real-person'];
  // A quote or a paraphrase is about provenance, not about unlawful content: the body stays
  // visible, and only a law category hides it.
  if (rule === 'RIGHTS-QUOTE' || rule === 'RIGHTS-PARAPHRASE') return [];
  return ['illegal-content'];
}

/** The row's flags as a list; a malformed value is an empty list, never a crash. */
function readFlags(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function withFlags(raw: string | null, extra: readonly string[]): string[] {
  const flags = readFlags(raw);
  for (const flag of extra) if (!flags.includes(flag)) flags.push(flag);
  return flags;
}

export function recordRights(db: Db, input: RecordRightsInput): RecordRightsResult {
  if (input.by !== null && input.by.length > COMMENT_AUDITED_BY_MAX_CHARS) {
    return {
      ok: false,
      code: 'RIGHTS_LABEL_TOO_LONG',
      message: `the label is longer than ${COMMENT_AUDITED_BY_MAX_CHARS} characters`,
    };
  }
  if (input.verdict === 'CLEAR' && input.rule !== null) {
    return { ok: false, code: 'RIGHTS_RULE_WITH_CLEAR', message: 'a CLEAR names no rule' };
  }
  if (input.verdict === 'REFUSED') {
    if (input.rule === null) {
      return { ok: false, code: 'RIGHTS_RULE_REQUIRED', message: 'a REFUSED needs a rule id' };
    }
    if (!isRightsRule(input.rule) || rightsRefusalLine(input.rule) === null) {
      return { ok: false, code: 'RIGHTS_RULE_UNKNOWN', message: `${input.rule} is not in the rights table` };
    }
  }

  const run = db.transaction((): RecordRightsResult => {
    const rule = input.rule;
    const recorded = db
      .prepare(
        `UPDATE comments
            SET rights_verdict = ?, rights_rule = ?, rights_at = ?, rights_by = ?, rights_source = ?
          WHERE id = ? AND rights_verdict IS NULL`,
      )
      .run(input.verdict, rule, input.at, input.by, input.source, input.commentId);
    if (recorded.changes !== 1) {
      const row = db.prepare('SELECT rights_verdict FROM comments WHERE id = ?').get(input.commentId) as
        | { rights_verdict: string | null }
        | undefined;
      if (row === undefined) {
        return { ok: false, code: 'RIGHTS_UNKNOWN_COMMENT', message: `unknown comment: ${input.commentId}` };
      }
      return {
        ok: false,
        code: 'RIGHTS_ALREADY_RECORDED',
        message: `${input.commentId} already has a rights verdict (first verdict wins)`,
      };
    }

    if (input.verdict === 'REFUSED') {
      // The verdict checks above make both of these true; the casts keep the closure total.
      const sentence = rightsRefusalLine(rule as string) as string;
      // B1: the refusal reaches the reader only while no gate has spoken. A `quarantined` row
      // stays held (A's state, for an operator to release) and a `rejected` row keeps A's
      // public reason; the verdict column above is B's and is written regardless. A caller that
      // owns the status (the backfill on a batched row) records the verdict without the line.
      if (input.publishRefusal !== false) {
        const rejected = db
          .prepare(
            `UPDATE comments SET status = 'rejected', decided_at = ?, reason = ?
              WHERE id = ? AND status IN ${UNDECIDED_STATUSES}`,
          )
          .run(input.at, sentence, input.commentId);
        // BOOK-174: a rights refusal is the rights lock, and its chain travels with the row it
        // refuses — the reader's report says «не принято» and why, with the alternative.
        if (rejected.changes > 0) storeChain(db, input.commentId, lockDecision('rights'));
      }
      const row = db.prepare('SELECT flags FROM comments WHERE id = ?').get(input.commentId) as RightsRow;
      db.prepare('UPDATE comments SET flags = ? WHERE id = ?').run(
        JSON.stringify(withFlags(row.flags, refusalFlags(rule as string))),
        input.commentId,
      );
      appendCommentEvent(db, input.commentId, 'rights', input.at, {
        verdict: 'REFUSED',
        rule,
        source: input.source,
        ...(input.sourceText === undefined || input.sourceText === null || input.sourceText.length === 0
          ? {}
          : { credited: input.sourceText }),
      });
      return { ok: true, verdict: 'REFUSED' };
    }

    appendCommentEvent(db, input.commentId, 'rights', input.at, { verdict: 'CLEAR', source: input.source });
    return { ok: true, verdict: 'CLEAR' };
  });
  return run();
}

export type FlagRightsInput = {
  commentId: string;
  /** Operator-only: why the scan could not clear it. Never printed to a reader. */
  detail: string;
  at: string;
};

/**
 * A flag: no verdict, a `rights-flag` in `flags`, and a `rights` event. Conditional on the
 * column staying null, so a flag cannot resurrect a row another writer has already decided.
 */
export function flagRights(db: Db, input: FlagRightsInput): boolean {
  const run = db.transaction((): boolean => {
    const current = readFlagsOf(db, input.commentId);
    // One flag per row: a second batch attempt must not write a second event for the same fact.
    if (readFlags(current).includes(RIGHTS_FLAG)) return false;
    const changed = db
      .prepare('UPDATE comments SET flags = ? WHERE id = ? AND rights_verdict IS NULL')
      .run(JSON.stringify(withFlags(current, [RIGHTS_FLAG])), input.commentId).changes;
    if (changed !== 1) return false;
    appendCommentEvent(db, input.commentId, 'rights', input.at, {
      verdict: 'flag',
      rule: 'RIGHTS-FLAG',
      detail: input.detail,
    });
    return true;
  });
  return run();
}

function readFlagsOf(db: Db, commentId: string): string | null {
  const row = db.prepare('SELECT flags FROM comments WHERE id = ?').get(commentId) as { flags: string | null } | undefined;
  return row?.flags ?? null;
}
