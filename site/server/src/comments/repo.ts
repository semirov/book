/**
 * Comment storage (ARCHITECTURE.md §8, §12.2, §9).
 *
 * Rows only; the decisions about what may be stored live in `service.ts`. Every read that
 * leaves this module is a DTO with bounded strings, an anchor and a decision — never a raw
 * row, never an identity id, never an IP hash.
 */

import {
  PUBLIC_COMMENT_STATUSES,
  authorColor,
  holdsInternalCode,
  normalizeFrameMark,
  normalizeInterventionKind,
  readerReason,
  type CommentAnchor,
  type CommentDto,
  type CommentGuard,
  type CommentRefusal,
  type CommentStatus,
  type FrameMark,
  type InterventionKind,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { safeJson } from '../engineState/rows.ts';
import { refusalHint, reviseState } from './attempts.ts';

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
       (id, identity_id, chapter, block_id, block_idx, base_rev, quote, prefix, suffix, author,
        body, proposed_text, intervention_kind, body_sha, flags, ip_hash, status, frame, guard, created_at, reason,
        idem_key, terms_version, terms_sha)
     VALUES
       (@id, @identityId, @chapter, @blockId, @blockIndex, @baseRev, @quote, @prefix, @suffix, @author,
        @body, @proposedText, @interventionKind, @bodySha, @flags, @ipHash, @status, @frame, @guard, @createdAt,
        @reason, @idemKey, @termsVersion, @termsSha)`,
  ).run({
    ...comment,
    frame: comment.frame ?? null,
    // BOOK-58: a caller that does not know the terms (a seed, a backfill) stores none, rather
    // than a default that would read as an accepted version.
    termsVersion: comment.termsVersion ?? null,
    termsSha: comment.termsSha ?? null,
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

/** Newest first in SQL, then reversed: the API promises an ascending thread (§9). */
export function listCommentRows(db: Db, options: ListCommentsOptions): CommentRow[] {
  const placeholders = PUBLIC_COMMENT_STATUSES.map(() => '?').join(', ');
  const filters: string[] = [`status IN (${placeholders})`];
  const args: Array<string | number> = [...PUBLIC_COMMENT_STATUSES];
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
  const block = readBlock(db, row.block_id);
  const resolved = block !== undefined && (quote === null || block.text.includes(quote));
  return {
    blockId: row.block_id,
    blockIndex: block?.idx ?? row.block_idx,
    quote,
    prefix: row.prefix,
    suffix: row.suffix,
    resolved,
  };
}

export function toCommentDto(db: Db, row: CommentRow, nowMs: number = Date.now()): CommentDto {
  const flags = safeJson<string[]>(row.flags) ?? [];
  // Illegal content is stored for the operator and never republished: the thread shows a
  // placeholder and the public reason, because «quarantined» is not a licence to publish it.
  const redacted = flags.includes('illegal-content');
  // BOOK-7: a premise's state is the change's state — one source, so the thread cannot say
  // «в очереди» about an intervention that waits for the chapter's first pass instead.
  const change = linkedChange(db, row.change_id);
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
  const status = premise ? premiseStatus(change, rowStatus, written) : rowStatus;
  const attempt: CommentDto['attempt'] = failedAttempt(change, status);
  // The reason is a sentence, and which sentence depends on who spoke last:
  //  - a change that carries an internal code did not speak — it tried. Its code never reaches
  //    the reader, and the row's own line (the acceptance sentence) is the answer;
  //  - otherwise a premise speaks with its change: the writer's refusal, the landing line, the
  //    supersede — the row's acceptance sentence is the fallback, not the record.
  const rowLine = readerReason(row.reason);
  const changeLine = change === undefined ? null : readerReason(change.reason);
  const codeInChange = change !== undefined && holdsInternalCode(change.reason);
  const reason = premise && !codeInChange ? (changeLine ?? rowLine) : rowLine;
  // The receipt of a premise is the **derived** landing, never `written` alone: a rejected or
  // superseded premise on a written chapter decided against that text and carries no receipt.
  // A landing has no receipt columns of its own — the chapter it entered and that chapter's
  // revision are the receipt. Never invented: no chapter row, no `applied`.
  const landedReceipt =
    premise && status === 'applied' && base !== undefined ? { chapter: row.chapter, rev: base.rev } : null;
  // BOOK-158: the gate's word, the actionable line and the way back. All three are derived
  // once, here, from the stored verdicts and the attempt ledger, so no surface can disagree.
  const refusal = refusalOf(row);
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
    // Audit m5: the public DTO carries the verdict the reader is told (`status`, `reason`)
    // and nothing else. `guard`/`flags` stay in the row for the operator — a rendered
    // taxonomy is a map of the detector. BOOK-9: `audit_*` never leaves the row either;
    // an `OFF` reaches the reader only as this `reason`.
    reason,
    attempt,
    // BOOK-158: the actionable line beside a refusal, and the way back to another try.
    hint: refusalHint({ status, refusal, rights_rule: row.rights_rule }),
    revise: reviseState(db, row, nowMs),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    changeId: row.change_id,
    // A premise that landed has no receipt columns of its own — the chapter it
    // entered and that chapter's revision are the receipt. Never invented: no chapter row,
    // no `applied`.
    applied:
      landedReceipt ??
      (row.applied_chapter !== null && row.applied_rev !== null
        ? { chapter: row.applied_chapter, rev: row.applied_rev }
        : null),
  };
}

/**
 * The gate that refused a filing (BOOK-61): derived once, from the verdict columns only.
 *
 * A **rejected** row belongs to the gate that wrote the rejection (B1): only B sets
 * `decided_at` together with its sentence, so a row A rejected on scope keeps A's state even
 * when B later records its own verdict column, and the page never heads A's reason with B's
 * word. A held row is A's whatever B answered.
 */
function refusalOf(row: CommentRow): CommentRefusal | null {
  if (row.status === 'quarantined') return 'held';
  if (row.status === 'rejected') {
    if (row.rights_verdict === 'REFUSED' && row.decided_at !== null) return 'rights';
    return row.audit_verdict === 'OFF' ? 'auditor' : null;
  }
  if (row.rights_verdict === 'REFUSED') return 'rights';
  if (row.audit_verdict === 'OFF') return 'auditor';
  return null;
}

type LinkedChange = { premise: number; status: string; outcome: string | null; reason: string | null };

/** The change a comment became, for the premise's state (BOOK-7). One indexed read. */
function linkedChange(db: Db, changeId: string | null): LinkedChange | undefined {
  if (changeId === null) return undefined;
  return db.prepare('SELECT premise, status, outcome, reason FROM changes WHERE id = ?').get(changeId) as
    | LinkedChange
    | undefined;
}

/** Filing states the linked change may never upgrade: the row's own word is the last one. */
const OWN_STATES = new Set<CommentStatus>(['rejected', 'quarantined', 'superseded', 'hidden']);

/** Change states that are an attempt, not a landing — a `void` here is a failed try. */
const ATTEMPT_STATES = new Set<string>(['void', 'failed', 'escalated']);

/**
 * Did this change decide in **human words**? A `void` whose reason is a sentence is the
 * writer's refusal or a supersede; a `void` whose reason is an internal code is an attempt
 * that came back empty, and one with **no** reason at all decides nothing — the chapter's
 * text is the answer in both of those cases.
 */
function decided(reason: string | null): boolean {
  return !holdsInternalCode(reason) && readerReason(reason) !== null;
}

/**
 * Did this premise land? The one derived fact every surface reads: the change's own answer plus
 * the book's, never a second vocabulary
 * (`ChangeDto.premiseLanded`, a filing's `applied`, a reader's own outcome).
 *
 *   1. `done` is the engine's own settlement: the first edition took it;
 *   2. a `void` whose reason is a **human sentence** is a decision — the writer refused it, it
 *      was superseded, or the chapter was written without it. A refusal always beats a landing;
 *   3. a `void`/`failed`/`escalated` whose reason is an **internal code** is a failed attempt:
 *      it decides nothing, and the chapter's text is the answer;
 *   4. otherwise the chapter's text is the answer — a premise whose chapter has an edition has
 *      entered it.
 */
export function premiseLanded(facts: {
  premise: number | boolean;
  status: string;
  reason: string | null;
  written: boolean;
}): boolean {
  if (facts.premise !== 1 && facts.premise !== true) return false;
  if (facts.status === 'done') return true;
  if (facts.status === 'void' && decided(facts.reason)) return false;
  return facts.written;
}

/**
 * A premise's public states, derived from the two facts that are actually stored: its own row
 * and whether its chapter has text.
 *
 * Order matters, and each step is one fact:
 *   1. a row that decided itself (`rejected`, `quarantined`, `superseded`, `hidden`) keeps its
 *      own word — a linked change may only leave it alone, never upgrade it;
 *   2. a premise that landed is `applied` (`premiseLanded` — a refusal beats a landing);
 *   3. a change that decided in human words is the premise's answer, even over a written
 *      chapter: the writer refused it, or it was superseded;
 *   4. what is left waits: a queued change reads as `accepted`, anything else keeps its row.
 */
function premiseStatus(
  change: LinkedChange | undefined,
  fallback: CommentStatus,
  written: boolean,
): CommentStatus {
  if (OWN_STATES.has(fallback)) return fallback;
  if (
    change !== undefined &&
    premiseLanded({ premise: change.premise, status: change.status, reason: change.reason, written })
  ) {
    return 'applied';
  }
  if (change !== undefined && change.status === 'void' && decided(change.reason)) {
    return change.outcome === 'superseded' ? 'superseded' : 'rejected';
  }
  if (change !== undefined && change.status === 'pending') return 'accepted';
  return fallback;
}

/**
 * Is the linked change a failed attempt? The engine's `void`/`failed`/`escalated` with an
 * internal-code reason is one: the filing keeps its state and the page says the attempt
 * came back empty. A filing that landed never carries one, a human refusal is not an attempt —
 * it reaches the reader as its own sentence — and neither is a **silent** change, whose reason
 * is `null` and whose answer is the chapter's text. A filing that decided itself (`rejected`,
 * `quarantined`, `superseded`, `hidden`) said the last word: its own refusal is not an echo of
 * an attempt behind it.
 */
function failedAttempt(change: LinkedChange | undefined, status: CommentStatus): CommentDto['attempt'] {
  if (change === undefined || status === 'applied') return null;
  if (OWN_STATES.has(status)) return null;
  if (!ATTEMPT_STATES.has(change.status)) return null;
  return holdsInternalCode(change.reason) ? 'failed' : null;
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
