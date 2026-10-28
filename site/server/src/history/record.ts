/**
 * Reading the public record (ARCHITECTURE.md §6F.1, §6F.2, BOOK-65).
 *
 * The chronicle used to be a projection of `events`: every front revision, gate dispatch,
 * wave, lease, join and hide became a public line. The owner's rule is the opposite — the
 * record is **a change to the book**, once — but the change's cause is not the gate: a pass
 * that wrote a chapter is as much a change as a reader's accepted filing. So this module reads
 * `changes` (a filing or a machine pass) and the landed `pass_stages` rows that carry no change
 * row, as one list; the log only supplies the moment, because the scrubber already speaks in
 * `hseq`.
 *
 * A path that inserts a change appends `change.queued` in the same transaction
 * (`engine/queue.ts` for an enqueued change, `admitPremise` for a premise, `feedback/accept.ts`
 * for a comment accepted through the interface), so every change row has a place on the clock.
 * This reader still guards the join: a row with no event row has no moment and is not listed.
 *
 * **One entry per change.** The two arms cannot overlap: a landed stage is listed only when its
 * pass has no change row — neither the stage's own `change_id` nor any event that ties a change
 * to the pass id — so a change that a pass carried appears once, as the change. A stage the lane
 * emitted twice (the live book holds two `landed` rows for one pass) is one entry as well: the
 * pass, not the emission, is the row of the book.
 */

import {
  CHANGE_RECORD_PREFIX,
  PASS_RECORD_PREFIX,
  TOTAL_CHAPTERS,
  passEntryId,
  readerReason,
  type ChangeOutcome,
  type ChangeStatus,
  type HistoryRecordCause,
  type HistoryRecordDto,
  type HistoryRecordSpan,
} from '@book/shared';

import { chapterWritten, premiseLanded } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';
import { lastHseq, pageLimit } from './events.ts';
import { firstEventAt } from './live.ts';

export type RecordRow = {
  /** The change's id; null on the pass arm. */
  id: string | null;
  /** The pass's id; null on the change arm. */
  pass_id: string | null;
  seq: number | null;
  chapter: number;
  chapter_title: string | null;
  premise: number;
  status: ChangeStatus | null;
  outcome: ChangeOutcome | null;
  reason: string | null;
  /** The filing's author on the change arm; `null` on the pass arm and for a machine change. */
  alias: string | null;
  cause: HistoryRecordCause;
  /** `changes.source_comment` — BOOK-168's place door reads the filing by this id. */
  source_comment: string | null;
  hseq: number;
  at: string;
  /** The landed stage's `span` JSON on the pass arm; resolved per row on the change arm. */
  span: string | null;
  /** `changes.anchor` JSON — a reader's `quote` and the paragraph it pointed at. */
  anchor: string | null;
};

export type RecordFilter = {
  before?: number;
  limit?: number;
};

/**
 * The union of the book's changes, newest first by the entry's moment.
 *
 * Arm 1 — a `changes` row. A visible filing is a reader's change; a row with no filing is a
 * machine pass (BOOK-65 dropped no rows on that ground, it dropped them from the record: they
 * are changes now). BOOK-101 — a hidden comment is a filing the operator withdrew from the page,
 * so its change has no public line and the author's alias never reaches this DTO through it.
 *
 * Arm 2 — a landed pass with no change row. `pass_events` reads the log once for both facts a
 * pass needs: the moment the scrubber names (`MAX(hseq)` of the pass's own `step_id` rows) and
 * whether any of those rows carries a change — a change tied to the pass is the entry, the pass
 * is not. `landed` picks one row per pass, preferring the emission that carries a span and, of
 * those, the latest: the lane may report the same landing twice.
 *
 * BOOK-155 — the chapter range is part of the public record: a change or a landing against a
 * number the book no longer has (chapter 65, storage kept by the `chapters` CHECK) is not a line
 * of this book's chronicle. The rule is the one `isChapterNumber` states, applied in SQL, so a
 * full page stays full and `nextBefore` keeps meaning "the oldest row served".
 */
const SELECT_RECORD = `WITH landed AS MATERIALIZED (
         SELECT s.pass_id, s.chapter, s.change_id, s.at, s.span,
                ROW_NUMBER() OVER (
                  PARTITION BY s.pass_id
                  ORDER BY (s.span IS NOT NULL) DESC, s.seq DESC
                ) AS pick
           FROM pass_stages s
          WHERE s.stage = 'landed'
       ),
       pass_events AS MATERIALIZED (
         SELECT e.step_id AS pass_id,
                MAX(e.hseq) AS hseq,
                MAX(CASE WHEN e.change_id IS NOT NULL THEN 1 ELSE 0 END) AS has_change
           FROM events e
          WHERE e.step_id IN (SELECT pass_id FROM landed)
          GROUP BY e.step_id
       )
  SELECT c.id AS id, NULL AS pass_id, c.seq, c.chapter, ch.title AS chapter_title,
         c.premise, c.status, c.outcome, c.reason,
         CASE WHEN c.source_comment IS NULL THEN NULL ELSE co.author END AS alias,
         CASE WHEN c.source_comment IS NULL THEN 'pass' ELSE 'reader' END AS cause,
         c.source_comment AS source_comment,
         e.hseq, e.at, NULL AS span, c.anchor
    FROM changes c
    LEFT JOIN comments co ON co.id = c.source_comment
    LEFT JOIN chapters ch ON ch.n = c.chapter
    JOIN events e ON e.hseq = (SELECT MAX(inner_e.hseq) FROM events inner_e WHERE inner_e.change_id = c.id)
   WHERE (co.status IS NULL OR co.status <> 'hidden') AND c.chapter BETWEEN 1 AND ?
  UNION ALL
  SELECT NULL, l.pass_id, NULL, l.chapter, ch.title,
         0, NULL, NULL, NULL, NULL, 'pass', NULL,
         COALESCE(pe.hseq, 0), l.at, l.span, NULL
    FROM landed l
    LEFT JOIN pass_events pe ON pe.pass_id = l.pass_id
    LEFT JOIN chapters ch ON ch.n = l.chapter
   WHERE l.pick = 1
     AND l.chapter BETWEEN 1 AND ?
     AND COALESCE(pe.has_change, 0) = 0
     AND NOT EXISTS (SELECT 1 FROM changes c WHERE c.id = l.change_id)`;

/** The public reason, bounded and normalised once; an empty string is no reason at all. */
function publicReason(raw: string | null): string | null {
  return readerReason(raw);
}

/**
 * The first changed pair of a landed stage's `span`: the paragraph the pass replaced and its
 * new text. A stage that created a chapter from an empty slot has an empty `before` — there was
 * no «было», so the entry carries no span rather than printing an empty quote. Anything else
 * (malformed JSON, a stale shape) is no span: the record never guesses.
 */
function spanOf(raw: string | null): HistoryRecordSpan | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const before = typeof (entry as { before?: unknown }).before === 'string' ? (entry as { before: string }).before.trim() : '';
    const after = typeof (entry as { after?: unknown }).after === 'string' ? (entry as { after: string }).after.trim() : '';
    if (before.length === 0 || after.length === 0 || before === after) continue;
    return { before, after };
  }
  return null;
}

/**
 * A reader's own pair, and only while it is still the book's text.
 *
 * `before` is the words the reader pointed at (`changes.anchor.quote`). `after` is the paragraph
 * the change wrote, read from the live projection of that paragraph's content-derived id: the
 * block id is a hash of the text, so a live block with that id is exactly the text this change
 * put there. The version row must credit this change with it — otherwise the paragraph was
 * rewritten since, the applied text is gone, and an honest record says nothing.
 */
function readerSpan(db: Db, changeId: string, anchor: string | null): HistoryRecordSpan | null {
  if (anchor === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(anchor);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const quote = (parsed as { quote?: unknown }).quote;
  const blockIds = (parsed as { blockIds?: unknown }).blockIds;
  const before = typeof quote === 'string' ? quote.trim() : '';
  if (before.length === 0 || !Array.isArray(blockIds)) return null;
  const blockId = blockIds.find((id): id is string => typeof id === 'string' && id.length > 0);
  if (blockId === undefined) return null;
  const row = db
    .prepare(
      `SELECT b.text AS text, bv.change_id AS change_id
         FROM block_versions bv
         JOIN blocks b ON b.id = bv.block_id
        WHERE bv.block_id = ?
        ORDER BY bv.hseq DESC, bv.ver DESC
        LIMIT 1`,
    )
    .get(blockId) as { text: string; change_id: string | null } | undefined;
  if (row === undefined || row.change_id !== changeId) return null;
  const after = row.text.trim();
  if (after.length === 0 || after === before) return null;
  return { before, after };
}

/** A pass's span: its landed stage's own, or the stage that names the change (one lookup). */
function passSpan(db: Db, changeId: string | null, own: string | null): HistoryRecordSpan | null {
  const ownSpan = spanOf(own);
  if (ownSpan !== null || changeId === null) return ownSpan;
  const row = db
    .prepare(
      "SELECT span FROM pass_stages WHERE change_id = ? AND stage = 'landed' AND span IS NOT NULL ORDER BY seq DESC LIMIT 1",
    )
    .get(changeId) as { span: string } | undefined;
  return spanOf(row?.span ?? null);
}

/**
 * The entry's one id and its one door: the change's, or the bare pass's.
 *
 * A change knows its chapter through its own row, so the door is `#проход-<changeId>` and the
 * page reads the chapter with `GET /api/changes/:id`. A landed pass with no change row has no
 * such row: the chapter is part of its key (`#проход-<chapter>-<passId>`), because the pass id
 * alone cannot be looked up by a reader's page.
 */
function identityOf(row: RecordRow): { id: string; recordHref: string } {
  if (row.id !== null) {
    const prefix = row.cause === 'reader' ? CHANGE_RECORD_PREFIX : PASS_RECORD_PREFIX;
    return { id: row.id, recordHref: `#${prefix}${row.id}` };
  }
  const passId = row.pass_id ?? '';
  return {
    id: passEntryId(passId),
    recordHref: `#${PASS_RECORD_PREFIX}${row.chapter}-${passId}`,
  };
}

function toHistoryRecord(row: RecordRow, landed: boolean, span: HistoryRecordSpan | null): HistoryRecordDto {
  return {
    ...identityOf(row),
    hseq: row.hseq,
    at: row.at,
    seq: row.seq,
    chapter: row.chapter,
    chapterTitle: row.chapter_title,
    premise: row.premise === 1,
    premiseLanded: landed,
    alias: row.alias,
    cause: row.cause,
    status: row.status,
    outcome: row.outcome,
    reason: publicReason(row.reason),
    sourceCommentId: row.source_comment,
    changeId: row.id,
    span,
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
 * the book's clock, not the newest record's: the scrubber's rest position shows the log's own
 * last moment.
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
    clause = ' WHERE hseq < ?';
    params.push(filter.before);
  }
  const sql = `SELECT * FROM (${SELECT_RECORD})${clause} ORDER BY hseq DESC, at DESC LIMIT ?`;
  const rows = db
    .prepare(sql)
    .all(TOTAL_CHAPTERS, TOTAL_CHAPTERS, ...params, pageLimit(filter.limit)) as RecordRow[];
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
  // One small lookup per row at most: a pass's span from its landed stage, a reader's from the
  // words they pointed at and the paragraph the change wrote.
  const spanAt = (row: RecordRow): HistoryRecordSpan | null => {
    if (row.cause === 'pass') return passSpan(db, row.id, row.span);
    return row.id === null ? null : readerSpan(db, row.id, row.anchor);
  };
  const items = rows.map((row) =>
    toHistoryRecord(
      row,
      row.premise === 1 &&
        premiseLanded({
          premise: row.premise,
          status: row.status ?? 'pending',
          reason: row.reason,
          written: writtenAt(row.chapter),
        }),
      spanAt(row),
    ),
  );
  const nextBefore = rows.length === pageLimit(filter.limit) ? (rows.at(-1)?.hseq ?? null) : null;
  const bookClock = lastHseq(db);
  // The other end of the same clock: the starting record a begun book always has. It is not a
  // change and is not in `items` — `items` stays one entry per change.
  return { lastHseq: bookClock, lastAt: clockAt(db, bookClock), firstAt: firstEventAt(db), items, nextBefore };
}
