/**
 * Reading the log as a public projection (§6F.1, §6F.7).
 *
 * `log.ts` is the only writer of `events`; this module is the only reader that turns a row
 * into the shape the chronicle shows. The event's `payload` is bounded and public by
 * construction (§6F.1 rule 6), and nothing here selects `gate_verdicts`.
 */

import type { HistoryAuthorKind, HistoryEventDto, HistoryKind } from '@book/shared';

import type { Db } from '../db/db.ts';
import { publicAlias } from '../util/alias.ts';
import type { AuthorKind } from './log.ts';
import { safeJson } from './payload.ts';
import { summarize } from './summary.ts';

export type EventRow = {
  /** `changes.seq` of this event's change — «правка 7» — resolved in the same query. */
  change_seq: number | null;
  hseq: number;
  at: string;
  kind: HistoryKind;
  chapter: number | null;
  is_front: number;
  rev: number | null;
  change_id: string | null;
  cascade_id: string | null;
  step_id: string | null;
  author_kind: AuthorKind;
  identity_id: string | null;
  author_label: string;
  payload: string;
  prev_hseq: number | null;
};

export type EventListFilter = {
  before?: number;
  limit?: number;
  kind?: string;
  chapter?: number;
};

/**
 * The public iteration number of a change («правка 7») is `changes.seq`, never the row id.
 * It is joined in the same statement: the chronicle must not cost one query per event.
 */
const SELECT_EVENT = `SELECT e.*, (SELECT c.seq FROM changes c WHERE c.id = e.change_id) AS change_seq FROM events e`;

/** The page's default size and its ceiling: one clamp, read by the query and the cursor. */
const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

/** The number of rows a page actually asks for (`limit` is optional and bounded). */
function pageLimit(limit: number | undefined): number {
  return Math.min(PAGE_LIMIT_MAX, Math.max(1, limit ?? PAGE_LIMIT_DEFAULT));
}

export function readEventRow(db: Db, hseq: number): EventRow | undefined {
  return db.prepare(`${SELECT_EVENT} WHERE e.hseq = ?`).get(hseq) as EventRow | undefined;
}

export function lastHseq(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(hseq), 0) AS hseq FROM events').get() as { hseq: number };
  return row.hseq;
}

/** Resolve a human moment to the clock: the last event at or before it (§6F.2). */
export function hseqAtOrBefore(db: Db, at: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(hseq), 0) AS hseq FROM events WHERE at <= ?').get(at) as {
    hseq: number;
  };
  return row.hseq;
}

export function listEventRows(db: Db, filter: EventListFilter = {}): EventRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.before !== undefined) {
    where.push('hseq < ?');
    params.push(filter.before);
  }
  if (filter.kind !== undefined) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.chapter !== undefined) {
    where.push('chapter = ?');
    params.push(filter.chapter);
  }
  const clause = where.length > 0 ? ` WHERE ${where.map((part) => `e.${part}`).join(' AND ')}` : '';
  const sql = `${SELECT_EVENT}${clause} ORDER BY e.hseq DESC LIMIT ?`;
  return db.prepare(sql).all(...params, pageLimit(filter.limit)) as EventRow[];
}

export function toHistoryEvent(row: EventRow): HistoryEventDto {
  const payload = safeJson<Record<string, unknown>>(row.payload) ?? {};
  const author = {
    kind: row.author_kind as HistoryAuthorKind,
    // Audit m3: the public handle, not the identity key — the same alias as the authors list.
    identityId: row.identity_id === null ? null : publicAlias(row.identity_id),
    label: row.author_label,
  };
  return {
    hseq: row.hseq,
    at: row.at,
    kind: row.kind,
    chapter: row.chapter,
    isFront: row.is_front === 1,
    rev: row.rev,
    changeId: row.change_id,
    cascadeId: row.cascade_id,
    stepId: row.step_id,
    author,
    summary: summarize({
      kind: row.kind,
      chapter: row.chapter,
      isFront: row.is_front === 1,
      rev: row.rev,
      changeSeq: row.change_seq ?? null,
      authorKind: row.author_kind,
      authorLabel: row.author_label,
      payload,
    }),
  };
}

/** The frame of one event: the row already carries its change number and its summary. */
export function toHistoryFrame(row: EventRow): HistoryEventDto {
  return toHistoryEvent(row);
}

/**
 * The public timeline page, newest first, with a cursor (§6F.2).
 *
 * The cursor is the last row's `hseq` **only when the page is full**: a page shorter than its
 * limit is the oldest one, so nothing lies before it and `nextBefore` is `null` — the client
 * must not offer «до …» for a history it has already shown completely.
 */
export function readTimeline(
  db: Db,
  filter: EventListFilter = {},
): { lastHseq: number; items: HistoryEventDto[]; nextBefore: number | null } {
  const rows = listEventRows(db, filter);
  const items = rows.map((row) => toHistoryEvent(row));
  const nextBefore = rows.length === pageLimit(filter.limit) ? (rows.at(-1)?.hseq ?? null) : null;
  return { lastHseq: lastHseq(db), items, nextBefore };
}
