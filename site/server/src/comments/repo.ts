/**
 * Comment storage (ARCHITECTURE.md §8, §12.2, §9).
 *
 * Rows only; the decisions about what may be stored live in `service.ts`. Every read that
 * leaves this module is a DTO with bounded strings, an anchor and a decision — never a raw
 * row, never an identity id, never an IP hash.
 */

import {
  MY_FILINGS_LIMIT,
  PUBLIC_COMMENT_STATUSES,
  TOTAL_CHAPTERS,
  authorColor,
  holdsInternalCode,
  normalizeFrameMark,
  normalizeInterventionKind,
  readerReason,
  type CommentAnchor,
  type CommentDto,
  type CommentGuard,
  type CommentStatus,
  type FrameMark,
  type InterventionKind,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { safeJson } from '../engineState/rows.ts';
import { findLiveSentence } from '../sentences/store.ts';
import { dispositionFieldsOf } from './dispositionReport.ts';
import { refusalHint, reviseState, triageAttemptFailed, unrevisedState } from './attempts.ts';
import { failedAttempt, isStopped, OWN_STATES, premiseStatus, refusalOf, stoppedLine } from './states.ts';
// BOOK-174 taught storage to hand the ladder's report out; BOOK-136's selection reads the
// changes a filing became, so `states.ts` keeps the pure words and this module stays rows.
import { decisiveChange, filingChanges, filingStatus, linkedChangeStatus } from './filingState.ts';

// BOOK-7: the premise's landing rule is read by the author's own record and the engine alike;
// it is re-exported here so a caller that already imports storage does not need a second path.
export { premiseLanded } from './states.ts';

export type CommentRow = {
  id: string;
  identity_id: string;
  chapter: number;
  block_id: string | null;
  block_idx: number | null;
  base_rev: number | null;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  /** ADR-044 — the sentence anchor and the reader's selection in it; null = the block anchor. */
  sentence_id: string | null;
  sel_start: number | null;
  sel_end: number | null;
  author: string;
  body: string;
  proposed_text: string | null;
  /** BOOK-16 — the intervention's kind (a column value; null for a note or a pre-BOOK-16 row). */
  intervention_kind: string | null;
  body_sha: string;
  flags: string;
  ip_hash: string;
  status: string;
  /** BOOK-137 — the frame mark taken at posting time; null for a row stored before v16. */
  frame: string | null;
  guard: string | null;
  created_at: string;
  delivered_at: string | null;
  decided_at: string | null;
  reason: string | null;
  batch_id: string | null;
  change_id: string | null;
  applied_chapter: number | null;
  applied_rev: number | null;
  /** BOOK-9 — the auditor's verdict, written once before triage; null = not audited. */
  audit_verdict: string | null;
  audit_reason: string | null;
  audited_at: string | null;
  audited_by: string | null;
  /** BOOK-61 Gate A — the hold: the rule that stopped the row, who decided, and when. */
  held_rule: string | null;
  held_by: string | null;
  held_at: string | null;
  /** BOOK-61 Gate B — the rights verdict; one writer per column, first verdict wins. */
  rights_verdict: string | null;
  rights_rule: string | null;
  rights_at: string | null;
  rights_by: string | null;
  rights_source: string | null;
  /** BOOK-58 — the terms this filing accepted (null for a row stored before v19). */
  terms_version: string | null;
  terms_sha: string | null;
  /** BOOK-58 — the moment a landed variant was entered, and the version it accepted. */
  accepted_at: string | null;
  accepted_terms_version: string | null;
  /** BOOK-174 — how the filing was read; all four null for a row stored before v27. */
  disposition: string | null;
  lock: string | null;
  carrier_kind: string | null;
  quote_kept: string | null;
  idem_key: string | null;
};

export type NewCommentRow = {
  id: string;
  identityId: string;
  chapter: number;
  blockId: string | null;
  blockIndex: number | null;
  baseRev: number | null;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  /** ADR-044 — the sentence the quote resolved to and the selection in it; omitted = none. */
  sentenceId?: string | null;
  selStart?: number | null;
  selEnd?: number | null;
  author: string;
  body: string;
  proposedText: string | null;
  /** BOOK-16 — the kind of the intervention; required with `proposedText`, null for a note. */
  interventionKind: InterventionKind | null;
  bodySha: string;
  flags: string[];
  ipHash: string;
  status: CommentStatus;
  /**
   * BOOK-137 — how the filing sits against the frozen frame (see `shared/src/frame.ts`). The
   * posting service always takes it; an older writer (a backfill, a test seed of a pre-v16 row)
   * omits it, and the decision re-derives the mark from the anchor.
   */
  frame?: FrameMark | null;
  guard: CommentGuard | null;
  reason: string | null;
  createdAt: string;
  idemKey: string | null;
  /**
   * BOOK-58 — the terms the submission accepted. The posting service always names both; a test
   * seed or a backfill that predates the record omits them and the row keeps `null`, which
   * reads as «no terms were recorded», never as a default.
   */
  termsVersion?: string | null;
  termsSha?: string | null;
};

export function insertComment(db: Db, comment: NewCommentRow): void {
  db.prepare(
    `INSERT INTO comments
       (id, identity_id, chapter, block_id, block_idx, base_rev, quote, prefix, suffix, sentence_id,
        sel_start, sel_end, author, body, proposed_text, intervention_kind, body_sha, flags, ip_hash, status,
        frame, guard, created_at, reason, idem_key, terms_version, terms_sha)
     VALUES
       (@id, @identityId, @chapter, @blockId, @blockIndex, @baseRev, @quote, @prefix, @suffix,
        @sentenceId, @selStart, @selEnd, @author, @body, @proposedText, @interventionKind, @bodySha,
        @flags, @ipHash, @status, @frame, @guard, @createdAt, @reason, @idemKey, @termsVersion, @termsSha)`,
  ).run({
    ...comment,
    frame: comment.frame ?? null,
    // BOOK-58: a caller that does not know the terms (a seed, a backfill) stores none, rather
    // than a default that would read as an accepted version.
    termsVersion: comment.termsVersion ?? null,
    termsSha: comment.termsSha ?? null,
    // ADR-044: no resolved sentence is an honest null (the block anchor), never a guessed id.
    sentenceId: comment.sentenceId ?? null, selStart: comment.selStart ?? null, selEnd: comment.selEnd ?? null,
    flags: JSON.stringify(comment.flags),
  });
}

export function readCommentRow(db: Db, id: string): CommentRow | undefined {
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow | undefined;
}

export function readCommentRowByIdemKey(db: Db, key: string): CommentRow | undefined {
  return db.prepare('SELECT * FROM comments WHERE idem_key = ?').get(key) as CommentRow | undefined;
}

export function findDuplicate(
  db: Db,
  identityId: string,
  bodySha: string,
  sinceIso: string,
): CommentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM comments
        WHERE identity_id = ? AND body_sha = ? AND created_at >= ? AND status <> 'hidden'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(identityId, bodySha, sinceIso) as CommentRow | undefined;
}

export type ListCommentsOptions = {
  chapter?: number;
  limit: number;
  /** Cursor: only comments older (by id) than this one. */
  before?: string;
};

/**
 * Newest first in SQL, then reversed: the API promises an ascending thread (§9).
 *
 * BOOK-155 — a filing aimed at a number the book no longer has (chapter 65, storage kept by
 * the `chapters` CHECK) is not a statement about this book, so it never enters a public page.
 * The range is the rule `isChapterNumber` states, applied in SQL: a post-filter would leave a
 * page one row short and the cursor would then claim the thread had ended.
 */
export function listCommentRows(db: Db, options: ListCommentsOptions): CommentRow[] {
  const placeholders = PUBLIC_COMMENT_STATUSES.map(() => '?').join(', ');
  const filters: string[] = [`status IN (${placeholders})`, 'chapter BETWEEN 1 AND ?'];
  const args: Array<string | number> = [...PUBLIC_COMMENT_STATUSES, TOTAL_CHAPTERS];
  if (options.chapter !== undefined) {
    filters.push('chapter = ?');
    args.push(options.chapter);
  }
  if (options.before !== undefined) {
    filters.push('id < ?');
    args.push(options.before);
  }
  args.push(options.limit);
  const rows = db
    .prepare(`SELECT * FROM comments WHERE ${filters.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...args) as CommentRow[];
  return rows.reverse();
}

/**
 * BOOK-207 — the reader's own filings (`GET /api/me/filings`), newest first, bounded.
 *
 * Own only: the identity is the session's, never a parameter. A hidden row is stored for the
 * operator and never republished, so it is not on the reader's own page either; a filing aimed
 * at a number this book no longer has is not a statement about it (BOOK-155), and the same
 * range rule is applied in SQL so the bound is a real bound.
 */
export function listOwnCommentRows(db: Db, identityId: string, limit: number = MY_FILINGS_LIMIT): CommentRow[] {
  const bound = Math.max(1, Math.min(MY_FILINGS_LIMIT, Math.trunc(limit)));
  return db
    .prepare(
      `SELECT * FROM comments
        WHERE identity_id = ? AND status <> 'hidden' AND chapter BETWEEN 1 AND ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(identityId, TOTAL_CHAPTERS, bound) as CommentRow[];
}

export type BlockRow = { id: string; chapter: number; idx: number; text: string; hash: string };

export function readBlock(db: Db, blockId: string): BlockRow | undefined {
  return db.prepare('SELECT id, chapter, idx, text, hash FROM blocks WHERE id = ?').get(blockId) as
    | BlockRow
    | undefined;
}

export function readChapterBase(
  db: Db,
  chapter: number,
): { rev: number; sha256: string; basis: number; blockCount: number } | undefined {
  const row = db
    .prepare('SELECT rev, sha256, basis, block_count FROM chapters WHERE n = ?')
    .get(chapter) as { rev: number; sha256: string; basis: number; block_count: number } | undefined;
  return row === undefined
    ? undefined
    : { rev: row.rev, sha256: row.sha256, basis: row.basis, blockCount: row.block_count };
}

/**
 * Does this chapter row hold text? One fact, read the way `accept.ts` decides premise vs
 * ordinary change: a basis row is a row, not prose, and a chapter with no blocks is
 * empty. It is the one fact a reader-facing state may take from the book rather than from the
 * change rows: a premise whose chapter has an edition has been applied, whatever became of the
 * attempt behind it.
 */
export function baseWritten(
  base: { basis: number; blockCount: number } | undefined,
): boolean {
  return base !== undefined && base.basis === 0 && base.blockCount > 0;
}

/** The same fact by chapter number, for the readers that do not need the revision. */
export function chapterWritten(db: Db, chapter: number): boolean {
  return baseWritten(readChapterBase(db, chapter));
}

/** §9: a comment whose quote no longer exists is `resolved:false`; it is never re-anchored. */
export function resolveAnchor(db: Db, row: CommentRow): CommentAnchor {
  const quote = row.quote;
  if (row.block_id === null) {
    return {
      blockId: null,
      blockIndex: row.block_idx,
      quote,
      prefix: row.prefix,
      suffix: row.suffix,
      resolved: true,
    };
  }
  // ADR-044: a live sentence is the anchor, and it outlives the block id it was filed under — a
  // block id is content-derived, so an edit renames the paragraph and every stored `block_id`
  // becomes history. The guard therefore only speaks while the filed block still exists: a
  // sentence that lives in a different *current* block is not this filing's sentence.
  const block = readBlock(db, row.block_id);
  const sentence = row.sentence_id === null ? null : findLiveSentence(db, row.sentence_id);
  const live = sentence !== null && (sentence.block_id === row.block_id || block === undefined) ? sentence : null;
  const owner = live === null ? undefined : readBlock(db, live.block_id);
  const resolved = block !== undefined && (quote === null || block.text.includes(quote));
  return {
    blockId: owner?.id ?? row.block_id,
    blockIndex: owner?.idx ?? block?.idx ?? row.block_idx,
    quote,
    prefix: row.prefix,
    suffix: row.suffix,
    ...(live === null ? {} : { sentenceId: live.id, selStart: row.sel_start, selEnd: row.sel_end }),
    resolved: live !== null || resolved,
  };
}

export function toCommentDto(db: Db, row: CommentRow, nowMs: number = Date.now()): CommentDto {
  const flags = safeJson<string[]>(row.flags) ?? [];
  // Illegal content is stored for the operator and never republished: the thread shows a
  // placeholder and the public reason, because «quarantined» is not a licence to publish it.
  const redacted = flags.includes('illegal-content');
  // BOOK-7: a premise's state is the change's state — one source, so the thread cannot say
  // «в очереди» about an intervention that waits for the chapter's first pass instead.
  // BOOK-136: a filing can have several changes, and `change_id` is only one of them (the live
  // rows point at an escalated attempt while a `done applied` change landed the same text), so
  // the state reads the whole set and the landing is the last word.
  const { landed, attempt: latest } = filingChanges(db, row.id, row.change_id);
  // BOOK-136/BOOK-206 B2 — the newest fact wins: a stop on the current attempt outranks an older
  // landing, and a landing newer than the stop is still the filing's answer.
  const change = decisiveChange({ landed, attempt: latest });
  // BOOK-111: a chapter-level filing with no change yet IS the chapter's premise — the schema's
  // own definition (`base_rev 0`, no anchor). Without this an unwritten chapter kept reading
  // as an empty slot and refused the reader's next tap as a duplicate.
  const premise =
    change?.premise === 1 || (change === undefined && row.block_id === null && row.base_rev === 0);
  // The one fact a state may take from the book — the chapter's own text. Read
  // once, here, so the status, the receipt and the failed-attempt flag cannot disagree.
  const base = readChapterBase(db, row.chapter);
  const written = baseWritten(base);
  const rowStatus = row.status as CommentStatus;
  // BOOK-136: a filing's state is the change's state — one source for every surface. A premise
  // reads the chapter's first pass; an ordinary filing reads the change it became, because the
  // row's own word stops at triage and never follows the text it caused.
  const status = premise ? premiseStatus(change, rowStatus, written) : filingStatus(change, rowStatus);
  // BOOK-206: a `new` filing whose open attempt ran out of triage calls is a visible defect —
  // the page says the attempt came back empty instead of «ждёт» forever. The row stays `new`.
  const attempt: CommentDto['attempt'] =
    failedAttempt(change, status) ?? (rowStatus === 'new' && triageAttemptFailed(db, row.id) ? 'failed' : null);
  // BOOK-136 — the writer's own fact, and only while it is one: the filing is in hand
  // (`processing`) or the lane holds it (`pending`). A landed, refused or failed filing has no
  // queue status, so no page can print «в очереди» over text that already exists.
  const changeStatus: CommentDto['changeStatus'] =
    !premise && !OWN_STATES.has(rowStatus) ? linkedChangeStatus(change) : null;
  // The reason is a sentence, and which sentence depends on who spoke last:
  //  - a stopped change (escalated/failed) speaks with its own stop sentence, sanitized once —
  //    the same derivation every surface reads (BOOK-206 B2), never «остаётся в очереди»;
  //  - a change that carries an internal code did not speak — it tried. Its code never reaches
  //    the reader, and the row's own line (the acceptance sentence) is the answer;
  //  - a premise speaks with its change: the writer's refusal, the landing line, the
  //    supersede — the row's acceptance sentence is the fallback, not the record;
  //  - an ordinary filing whose change decided (a landing, a refusal, a supersede) says the
  //    change's public line: the row still holds the acceptance sentence («входит в книгу»),
  //    and that is not a fact about text which already landed;
  //  - a row that decided itself keeps its own sentence — the gate's refusal is the row's, and
  //    a paperwork filing's line carries the mode it was filed as.
  const rowLine = readerReason(row.reason);
  // BOOK-206 B2 — a stopped change speaks with its own stop sentence, sanitized once: an engine
  // code becomes the fixed stop line, never «заявка остаётся в очереди» (nothing will read it).
  const stopped = change !== undefined && isStopped(change.status);
  const changeLine = change === undefined ? null : stopped ? stoppedLine(change.reason) : readerReason(change.reason);
  const codeInChange = change !== undefined && holdsInternalCode(change.reason);
  const changeSpoke =
    !OWN_STATES.has(rowStatus) &&
    change !== undefined &&
    (status === 'applied' || status === 'rejected' || status === 'superseded');
  const reason = premise
    ? stopped
      ? changeLine
      : codeInChange
        ? rowLine
        : (changeLine ?? rowLine)
    : changeSpoke
      ? changeLine
      : rowLine;
  // The receipt of a premise is the **derived** landing, never `written` alone: a rejected or
  // superseded premise on a written chapter decided against that text and carries no receipt.
  // A landing has no receipt columns of its own — the chapter it entered and that chapter's
  // revision are the receipt. Never invented: no chapter row, no `applied`.
  const landedReceipt =
    premise && status === 'applied' && base !== undefined ? { chapter: row.chapter, rev: base.rev } : null;
  // BOOK-136 — an ordinary filing lands the same way: the change names the chapter it entered,
  // and that chapter's own revision is the receipt. The stored `applied_*` columns are the
  // second source, never a guess; with neither, `applied` stays null and the page prints the
  // rights sentence without a number.
  const changeBase =
    !premise && status === 'applied' && change !== undefined
      ? readChapterBase(db, change.chapter)
      : undefined;
  const changeReceipt =
    change !== undefined && changeBase !== undefined && !premise && status === 'applied'
      ? { chapter: change.chapter, rev: changeBase.rev }
      : null;
  const rowReceipt =
    row.applied_chapter !== null && row.applied_rev !== null
      ? { chapter: row.applied_chapter, rev: row.applied_rev }
      : null;
  // BOOK-158: the gate's word, the actionable line and the way back. All three are derived
  // once, here, from the stored verdicts and the attempt ledger, so no surface can disagree.
  const refusal = refusalOf(row);
  // The attempt counts are read only for a row a revision could reopen: a settling row on a
  // public list owes no ledger question (three COUNTs per row otherwise). A stopped change
  // (BOOK-206 B2) is not a gate's refusal either — its row was never refused, so the door was
  // never open and there is nothing to count.
  const revise =
    status === 'rejected' && !stopped ? reviseState(db, row, nowMs) : unrevisedState();
  // BOOK-174: how the filing was read, from the five stored columns — the report is derived
  // here, once, so every surface prints the same three lines.
  const { disposition, report } = dispositionFieldsOf(db, row);
  return {
    id: row.id,
    chapter: row.chapter,
    anchor: resolveAnchor(db, row),
    author: row.author,
    authorColor: authorColor(row.author),
    body: redacted ? '‹текст скрыт до проверки›' : row.body,
    proposedText: redacted ? null : row.proposed_text,
    // BOOK-16: a stored value the build does not know is dropped, never printed; `null`
    // covers a note and every row written before BOOK-16.
    interventionKind: normalizeInterventionKind(row.intervention_kind),
    status,
    // BOOK-61: the gate that refused, derived here from the stored verdicts — one place, so no
    // surface can guess it from the reason text.
    refusal,
    // BOOK-137: a stored word this build does not know is dropped, never printed; `null` is an
    // old row (before v16), whose mark the decision re-derives when it is accepted.
    frame: normalizeFrameMark(row.frame),
    premise,
    // BOOK-136 — the linked change's own place in the writer's work, when it has one.
    changeStatus,
    // BOOK-221 — the same change's public number, so the trail prints «правка 014» from a real
    // ordinal. `null` when no change holds the filing: the row is then named by its chapter.
    changeSeq: change?.seq ?? null,
    // Audit m5: the public DTO carries the verdict the reader is told (`status`, `reason`)
    // and nothing else. `guard`/`flags` stay in the row for the operator — a rendered
    // taxonomy is a map of the detector. BOOK-9: `audit_*` never leaves the row either;
    // an `OFF` reaches the reader only as this `reason`.
    reason,
    attempt,
    // BOOK-158: the actionable line beside a refusal, and the way back to another try. A stopped
    // change (BOOK-206 B2) is not a refusal of the reader's wording, so it owes no advice — the
    // door is not open on it either (`revise.allowed` is false for a row triage did not refuse).
    hint: stopped ? null : refusalHint({ status, refusal, rights_rule: row.rights_rule }),
    revise,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    // BOOK-136 — the door opens the change that decided: the landing when one exists, else the
    // filing's current attempt. Never a stale id the state does not come from.
    changeId: landed?.id ?? latest?.id ?? row.change_id,
    // A landed filing has no receipt columns of its own — the chapter it entered and that
    // chapter's revision are the receipt. Never invented: no chapter row, no `applied`.
    applied: landedReceipt ?? changeReceipt ?? rowReceipt,
    // BOOK-174: `null` for every row written before v27 — no reading was ever recorded, and
    // the report is derived from the chain rather than from a second flag.
    disposition,
    report,
  };
}

export function appendCommentEvent(
  db: Db,
  commentId: string,
  type: string,
  at: string,
  meta: Record<string, unknown> | null = null,
): void {
  db.prepare('INSERT INTO comment_events (comment_id, at, type, meta) VALUES (?, ?, ?, ?)').run(
    commentId,
    at,
    type,
    meta === null ? null : JSON.stringify(meta),
  );
}
