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

import {
  TOTAL_CHAPTERS,
  readerReason,
  type ChangeOutcome,
  type ChangeStatus,
  type HistoryRecordDto,
} from '@book/shared';

import { chapterWritten, premiseLanded } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';
import { lastHseq, pageLimit } from './events.ts';
import { firstEventAt } from './live.ts';

export type RecordRow = {
  change_id: string;
  seq: number;
  chapter: number;
  premise: number;
  status: ChangeStatus;
  outcome: ChangeOutcome | null;
  reason: string | null;
  alias: string;
  source_comment: string;
  hseq: number;
  at: string;
};

export type RecordFilter = {
  before?: number;
  limit?: number;
};

/**
 * One row per reader change: a change whose source comment exists and is not `hidden` is the
 * whole reader test (BOOK-56, BOOK-101). The join to `comments` gives the alias, and the
 * correlated `MAX(hseq)` picks the change's last log entry — the one the scrubber names. An
 * event `hseq` is unique, so the join cannot multiply a change into a chain.
 *
 * BOOK-101 — a hidden comment is a filing the operator withdrew from the page, so its change
 * has no public line, and the author's alias never reaches this DTO through it. The record
 * prints a person's act only while that person's words are still on the page.
 *
 * BOOK-155 — the chapter range is part of the public record: a change filed against a number
 * the book no longer has (chapter 65, storage kept by the `chapters` CHECK) is not a line of
 * this book's chronicle. The rule is the one `isChapterNumber` states, applied in SQL, so a
 * full page stays full and `nextBefore` keeps meaning "the oldest row served".
 */
const SELECT_RECORD = `SELECT c.id AS change_id, c.seq, c.chapter, c.premise, c.status, c.outcome, c.reason,
       co.author AS alias, c.source_comment, e.hseq, e.at
  FROM changes c
  JOIN comments co ON co.id = c.source_comment
  JOIN events e ON e.hseq = (SELECT MAX(inner_e.hseq) FROM events inner_e WHERE inner_e.change_id = c.id)
  WHERE c.source_comment IS NOT NULL AND co.status <> 'hidden' AND c.chapter BETWEEN 1 AND ?`;

/**
 * The public reason, bounded and normalised once; an empty string is no reason at all.
 * An internal code is not a reason — `readerReason` answers the sentence instead.
 */
function publicReason(raw: string | null): string | null {
  return readerReason(raw);
}

function toHistoryRecord(row: RecordRow, landed: boolean): HistoryRecordDto {
  return {
    hseq: row.hseq,
    at: row.at,
    seq: row.seq,
    chapter: row.chapter,
    premise: row.premise === 1,
    premiseLanded: landed,
    alias: row.alias,
    status: row.status,
    outcome: row.outcome,
    reason: publicReason(row.reason),
    sourceCommentId: row.source_comment,
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
): {
  lastHseq: number;
  lastAt: string | null;
  firstAt: string | null;
  items: HistoryRecordDto[];
  nextBefore: number | null;
} {
  const params: number[] = [];
  let clause = '';
  if (filter.before !== undefined) {
    clause = ' AND e.hseq < ?';
    params.push(filter.before);
  }
  const sql = `${SELECT_RECORD}${clause} ORDER BY e.hseq DESC LIMIT ?`;
  const rows = db.prepare(sql).all(TOTAL_CHAPTERS, ...params, pageLimit(filter.limit)) as RecordRow[];
  // A premise's landing is the chapter's text, read the way the thread and the card read it
  // (`comments/repo.ts`): the change row alone cannot tell a refusal from an attempt, so the
  // record asks the book. One read per chapter on the page, and only a premise asks.
  const chapterText = new Map<number, boolean>();
  const writtenAt = (chapter: number): boolean => {
    const known = chapterText.get(chapter);
    if (known !== undefined) return known;
    const fact = chapterWritten(db, chapter);
    chapterText.set(chapter, fact);
    return fact;
  };
  const items = rows.map((row) =>
    toHistoryRecord(
      row,
      row.premise === 1 &&
        premiseLanded({
          premise: row.premise,
          status: row.status,
          reason: row.reason,
          written: writtenAt(row.chapter),
        }),
    ),
  );
  const nextBefore = rows.length === pageLimit(filter.limit) ? (rows.at(-1)?.hseq ?? null) : null;
  const bookClock = lastHseq(db);
  // The other end of the same clock: the starting record a begun book always has. It is not a
  // change and is not in `items` — `items` stays one row per reader change (BOOK-65).
  return { lastHseq: bookClock, lastAt: clockAt(db, bookClock), firstAt: firstEventAt(db), items, nextBefore };
}
