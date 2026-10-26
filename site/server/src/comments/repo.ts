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
  type CommentAnchor,
  type CommentDto,
  type CommentGuard,
  type CommentStatus,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { safeJson } from '../engineState/rows.ts';

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
  body_sha: string;
  flags: string;
  ip_hash: string;
  status: string;
  guard: string | null;
  created_at: string;
  delivered_at: string | null;
  decided_at: string | null;
  reason: string | null;
  batch_id: string | null;
  change_id: string | null;
  applied_chapter: number | null;
  applied_rev: number | null;
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
  bodySha: string;
  flags: string[];
  ipHash: string;
  status: CommentStatus;
  guard: CommentGuard | null;
  reason: string | null;
  createdAt: string;
  idemKey: string | null;
};

export function insertComment(db: Db, comment: NewCommentRow): void {
  db.prepare(
    `INSERT INTO comments
       (id, identity_id, chapter, block_id, block_idx, base_rev, quote, prefix, suffix, author,
        body, proposed_text, body_sha, flags, ip_hash, status, guard, created_at, reason, idem_key)
     VALUES
       (@id, @identityId, @chapter, @blockId, @blockIndex, @baseRev, @quote, @prefix, @suffix, @author,
        @body, @proposedText, @bodySha, @flags, @ipHash, @status, @guard, @createdAt, @reason, @idemKey)`,
  ).run({ ...comment, flags: JSON.stringify(comment.flags) });
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

export function readChapterBase(db: Db, chapter: number): { rev: number; sha256: string } | undefined {
  return db.prepare('SELECT rev, sha256 FROM chapters WHERE n = ?').get(chapter) as
    | { rev: number; sha256: string }
    | undefined;
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

export function toCommentDto(db: Db, row: CommentRow): CommentDto {
  const flags = safeJson<string[]>(row.flags) ?? [];
  // Illegal content is stored for the operator and never republished: the thread shows a
  // placeholder and the public reason, because «quarantined» is not a licence to publish it.
  const redacted = flags.includes('illegal-content');
  return {
    id: row.id,
    chapter: row.chapter,
    anchor: resolveAnchor(db, row),
    author: row.author,
    authorColor: authorColor(row.author),
    body: redacted ? '‹текст скрыт до проверки›' : row.body,
    proposedText: redacted ? null : row.proposed_text,
    status: row.status as CommentStatus,
    // Audit m5: the public DTO carries the verdict the reader is told (`status`, `reason`)
    // and nothing else. `guard`/`flags` stay in the row for the operator — a rendered
    // taxonomy is a map of the detector.
    reason: row.reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    changeId: row.change_id,
    applied:
      row.applied_chapter !== null && row.applied_rev !== null
        ? { chapter: row.applied_chapter, rev: row.applied_rev }
        : null,
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
