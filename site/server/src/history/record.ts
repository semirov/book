/**
 * Reading the public record (ARCHITECTURE.md §6F.1, §6F.2, BOOK-65).
 *
 * The chronicle used to be a projection of `events`: every front revision, gate dispatch,
 * wave, lease, join and hide became a public line. The owner's rule is the opposite — the
 * public record is **a change a person made through the interface**, once, and nothing else.
 * So this module reads `changes` joined to the comment that caused it, and the log only
 * supplies the moment: a change's last `hseq` is its place on the book's clock, and the
 * scrubber already speaks in `hseq`.
 *
 * A path that inserts a change appends `change.queued` in the same transaction
 * (`engine/queue.ts` for an enqueued change, `admitPremise` for a premise, `feedback/accept.ts`
 * for a comment accepted through the interface), so every reader change has a place on the
 * clock. This reader still guards the join: a row with no event row has no moment and is not
 * listed — `record.test.ts` proves the interface path satisfies the invariant.
 */

import type { ChangeOutcome, ChangeStatus, HistoryRecordDto } from '@book/shared';
import { seamReason } from '@book/shared';

import type { Db } from '../db/db.ts';
import { lastHseq, pageLimit } from './events.ts';

export type RecordRow = {
  change_id: string;
  seq: number;
  chapter: number;
  premise: number;
  status: ChangeStatus;
  outcome: ChangeOutcome | null;
  reason: string | null;
  alias: string;
  hseq: number;
  at: string;
};

export type RecordFilter = {
  before?: number;
  limit?: number;
};

/**
 * One row per reader change: `source_comment IS NOT NULL` is the whole reader test (BOOK-56),
 * the join to `comments` gives the alias, and the correlated `MAX(hseq)` picks the change's
 * last log entry — the one the scrubber names. An event `hseq` is unique, so the join cannot
 * multiply a change into a chain.
 */
const SELECT_RECORD = `SELECT c.id AS change_id, c.seq, c.chapter, c.premise, c.status, c.outcome, c.reason,
       co.author AS alias, e.hseq, e.at
  FROM changes c
  JOIN comments co ON co.id = c.source_comment
  JOIN events e ON e.hseq = (SELECT MAX(inner_e.hseq) FROM events inner_e WHERE inner_e.change_id = c.id)
  WHERE c.source_comment IS NOT NULL`;

/** The public reason, bounded and normalised once; an empty string is no reason at all. */
function publicReason(raw: string | null): string | null {
  if (raw === null) return null;
  const reason = seamReason(raw);
  return reason.length === 0 ? null : reason;
}

function toHistoryRecord(row: RecordRow): HistoryRecordDto {
  return {
    hseq: row.hseq,
    at: row.at,
    seq: row.seq,
    chapter: row.chapter,
    premise: row.premise === 1,
    alias: row.alias,
    status: row.status,
    outcome: row.outcome,
    reason: publicReason(row.reason),
    changeId: row.change_id,
  };
}

/** The book's clock's own last moment: the `at` of the event at `lastHseq`, or `null`. */
function clockAt(db: Db, hseq: number): string | null {
  const row = db.prepare('SELECT at FROM events WHERE hseq = ?').get(hseq) as { at: string } | undefined;
  return row?.at ?? null;
}

/**
 * The public record page, newest first, with a cursor (§6F.2).
 *
 * The cursor is the last row's `hseq` **only when the page is full**: a page shorter than its
 * limit is the oldest one, so nothing lies before it and `nextBefore` is `null` — the client
 * must not offer «до …» for a record it has already shown completely. `lastHseq`/`lastAt` are
 * the book's clock, not the newest record's: a machine pass still moves time without adding an
 * entry, so the scrubber's rest position must show the log's own last moment.
 */
export function readRecord(
  db: Db,
  filter: RecordFilter = {},
): { lastHseq: number; lastAt: string | null; items: HistoryRecordDto[]; nextBefore: number | null } {
  const params: number[] = [];
  let clause = '';
  if (filter.before !== undefined) {
    clause = ' AND e.hseq < ?';
    params.push(filter.before);
  }
  const sql = `${SELECT_RECORD}${clause} ORDER BY e.hseq DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, pageLimit(filter.limit)) as RecordRow[];
  const items = rows.map((row) => toHistoryRecord(row));
  const nextBefore = rows.length === pageLimit(filter.limit) ? (rows.at(-1)?.hseq ?? null) : null;
  const bookClock = lastHseq(db);
  return { lastHseq: bookClock, lastAt: clockAt(db, bookClock), items, nextBefore };
}
