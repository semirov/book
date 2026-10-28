/**
 * The editor's check on how often the world refuses (BOOK-174 comment #3888 §7).
 *
 * Three limits and one defect, all of them about the *book*, not about a filing:
 *
 *   • **run** — three `refused_in_world` in a row in one chapter is mockery (the chooser stops
 *     the third, so a run of three here is a finding, not a policy);
 *   • **share** — more than one in four accepted filings in a chapter (at ≥6), and more than
 *     one in six across a part: the chapter then reads as a court, not as a world;
 *   • **zero** — a part that never refuses is also a defect: a world that never says no has no
 *     weight, and the finale costs nothing.
 *
 * `disposition_counts` is the materialised view — one row per scope, recomputed from `comments`
 * and read by the operator's `feedback.mjs limits` only. No counter reaches a reader surface,
 * and none of these numbers ever becomes a `CommentDto` field.
 */

import { partOf } from '@book/shared';

import type { Db } from '../db/db.ts';

export type DispositionScope = 'reader_chapter' | 'chapter' | 'part';

export type DispositionCountsRow = {
  scope: DispositionScope;
  /** `reader:<identity>|ch:<n>`, `ch:<n>` or `part:<n>` — a key the operator can read. */
  key: string;
  accepted: number;
  in_world: number;
  /** The longest run of in-world refusals in this scope's own decision order. */
  run: number;
  at: string;
};

export type DispositionLimits = {
  run: 'ok' | 'stop';
  chapterShare: 'ok' | 'over';
  partShare: 'ok' | 'over';
  partZero: 'ok' | 'defect';
};

/** Statuses that mean "a decision was made" — an escalated filing is not one of them. */
const ACCEPTED_STATUSES = new Set(['accepted', 'applied', 'registered']);

/** A chapter's share is judged only once the chapter has enough filings to have a shape. */
export const CHAPTER_SHARE_MIN = 6;

type Decided = { identity_id: string; chapter: number; disposition: string | null; status: string };

/** One scope's running total, plus the run it is currently inside. */
type Bucket = { row: DispositionCountsRow; run: number };

function bucketOf(
  bucket: Map<string, Bucket>,
  scope: DispositionScope,
  key: string,
  at: string,
): Bucket {
  const current = bucket.get(key);
  if (current !== undefined) return current;
  const row: DispositionCountsRow = { scope, key, accepted: 0, in_world: 0, run: 0, at };
  const created: Bucket = { row, run: 0 };
  bucket.set(key, created);
  return created;
}

/** Recompute every scope from `comments` and replace the table's contents. */
export function refreshDispositionCounts(db: Db, at: string): DispositionCountsRow[] {
  const decided = db
    .prepare(
      `SELECT identity_id, chapter, disposition, status FROM comments
        WHERE disposition IS NOT NULL AND status <> 'escalated'
        ORDER BY chapter, decided_at, id`,
    )
    .all() as Decided[];

  const chapters = new Map<string, Bucket>();
  const readers = new Map<string, Bucket>();
  const parts = new Map<string, Bucket>();

  for (const comment of decided) {
    if (!ACCEPTED_STATUSES.has(comment.status)) continue;
    const chapterKey = `ch:${String(comment.chapter)}`;
    const readerKey = `reader:${comment.identity_id}|${chapterKey}`;
    const refused = comment.disposition === 'refused_in_world';
    for (const [scope, key, bucket] of [
      ['chapter', chapterKey, chapters] as const,
      ['reader_chapter', readerKey, readers] as const,
    ]) {
      const current = bucketOf(bucket, scope, key, at);
      current.row.accepted += 1;
      if (refused) current.row.in_world += 1;
      // The run belongs to the scope's own sequence: any other reading ends it.
      current.run = refused ? current.run + 1 : 0;
      current.row.run = Math.max(current.row.run, current.run);
    }
    const part = partOf(comment.chapter);
    if (part !== null) {
      const current = bucketOf(parts, 'part', `part:${String(part)}`, at);
      current.row.accepted += 1;
      if (refused) current.row.in_world += 1;
    }
  }
  // A part's run is its worst chapter's: a part is as mockable as the chapter inside it.
  for (const part of parts.values()) {
    const number = Number.parseInt(part.row.key.slice('part:'.length), 10);
    for (const chapter of chapters.values()) {
      const n = Number.parseInt(chapter.row.key.slice('ch:'.length), 10);
      if (partOf(n) === number) part.row.run = Math.max(part.row.run, chapter.row.run);
    }
  }

  const all = [...parts.values(), ...chapters.values(), ...readers.values()].map((bucket) => bucket.row);
  db.transaction(() => {
    db.prepare('DELETE FROM disposition_counts').run();
    const insert = db.prepare(
      `INSERT INTO disposition_counts (scope, key, accepted, in_world, run, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of all) insert.run(row.scope, row.key, row.accepted, row.in_world, row.run, row.at);
  })();
  return all;
}

/** The stored rows, ordered so the operator reads parts first and chapters inside them. */
export function readDispositionCounts(db: Db): DispositionCountsRow[] {
  return db
    .prepare('SELECT scope, key, accepted, in_world, run, at FROM disposition_counts ORDER BY scope, key')
    .all() as DispositionCountsRow[];
}

/**
 * The editor's verdict, over the stored rows. Pure: one pass over the table, four thresholds,
 * and no reader ever sees it.
 */
export function dispositionLimits(rows: readonly DispositionCountsRow[]): DispositionLimits {
  let run: DispositionLimits['run'] = 'ok';
  let chapterShare: DispositionLimits['chapterShare'] = 'ok';
  let partShare: DispositionLimits['partShare'] = 'ok';
  let partZero: DispositionLimits['partZero'] = 'ok';
  for (const row of rows) {
    if (row.scope === 'chapter') {
      // Three in a row in one chapter is the hard stop, however they were accepted.
      if (row.run >= 3) run = 'stop';
      if (row.accepted >= CHAPTER_SHARE_MIN && row.in_world * 4 > row.accepted) chapterShare = 'over';
    }
    if (row.scope === 'part') {
      if (row.in_world * 6 > row.accepted) partShare = 'over';
      if (row.accepted > 0 && row.in_world === 0) partZero = 'defect';
    }
  }
  return { run, chapterShare, partShare, partZero };
}

/** The same verdict as the operator's lines: one per breach, `ok` when there is none. */
export function dispositionLimitLines(rows: readonly DispositionCountsRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.scope === 'chapter' && row.run >= 3) {
      lines.push(`${row.key}: ${String(row.run)} подряд — стоп, следующий отказ в мире читается бумагой`);
    }
    if (row.scope === 'chapter' && row.accepted >= CHAPTER_SHARE_MIN && row.in_world * 4 > row.accepted) {
      lines.push(`${row.key}: отказов в мире ${String(row.in_world)} из ${String(row.accepted)} — больше 1 в 4`);
    }
    if (row.scope === 'part' && row.in_world * 6 > row.accepted) {
      lines.push(`${row.key}: отказов в мире ${String(row.in_world)} из ${String(row.accepted)} — больше 1 в 6`);
    }
    if (row.scope === 'part' && row.accepted > 0 && row.in_world === 0) {
      lines.push(`${row.key}: отказов в мире 0 из ${String(row.accepted)} — часть без отказа`);
    }
  }
  return lines.length === 0 ? ['ok'] : lines;
}
