/**
 * The bridge's `change:*` payloads, built from the change's own row and the event that spoke.
 *
 * They live apart from `bridge.ts` because that file is at its arch bound; every value here is
 * read from the public projection (`changes`, `cascades`, `steps`), never from a private table,
 * and the caller emits the result unchanged.
 */

import { readerReason } from '@book/shared';

import type { Db } from '../db/db.ts';
import { chaptersOfChange, decisionOutcome, publicIntent, readAuthor, readChange } from './changes.ts';
import { readQueue } from './reader.ts';
import { countRows } from './rows.ts';
import type { ChangeRow } from './rows.ts';

/** One row of the change's audit log — the fact a frame is built from. */
export type ChangeEventRow = {
  id: number;
  change_id: string;
  at: string;
  type: string;
  meta: string | null;
};

/** Pending filings older than this change: its place in the lane's line. */
export function aheadOf(db: Db, change: ChangeRow): number {
  if (change.premise === 1) return 0;
  return countRows(
    db,
    `SELECT COUNT(*) AS n FROM changes WHERE status = 'pending' AND premise = 0 AND seq < ?`,
    change.seq,
  );
}

export function queuedPayload(db: Db, change: ChangeRow, row: ChangeEventRow, nowMs: number) {
  const ahead = aheadOf(db, change);
  return {
    id: change.id,
    seq: change.seq,
    kind: change.kind,
    chapter: change.chapter,
    intent: publicIntent(change.intent),
    source: { commentId: change.source_comment, author: readAuthor(db, change.source_comment) },
    queue: { depth: readQueue(db, nowMs).depth, ahead },
    base: { rev: change.base_rev },
    scopeHint: change.scope_hint,
    at: Date.parse(row.at),
    eventSeq: row.id,
  };
}

export function decidedPayload(db: Db, change: ChangeRow, row: ChangeEventRow, nowMs: number) {
  const dto = readChange(db, change.id, nowMs);
  const cascade = dto?.cascade ?? null;
  return {
    id: change.id,
    commentId: change.source_comment,
    outcome: decisionOutcome(change),
    // The frame is a public surface — a reason is a sentence, never a code.
    reason: readerReason(change.reason),
    chapters: chaptersOfChange(db, change),
    cascade:
      cascade === null
        ? null
        : {
            id: cascade.id,
            outcome: cascade.outcome,
            waves: cascade.wave,
            touched: [...new Set([...cascade.chaptersRewritten, ...cascade.chaptersChecked])].sort(
              (left, right) => left - right,
            ),
            rewritten: cascade.chaptersRewritten,
            wings: cascade.wings,
            seams: cascade.seams.map((seam) => ({ boundary: seam.boundary, resolved: seam.resolved })),
            finding: cascade.gates.findingSurvived,
          },
    relevance: dto?.relevance === null || dto?.relevance === undefined ? null : { grade: dto.relevance.grade },
    tokens: { total: change.tokens_in + change.tokens_out },
    decidedAt: change.finished_at ?? row.at,
    at: Date.parse(row.at),
    eventSeq: row.id,
  };
}
