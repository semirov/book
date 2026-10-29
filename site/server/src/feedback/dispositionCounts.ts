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
 *
 * **Who enforces what** (the split is the design, and it is not silent): the 3-in-a-row limit is
 * enforced *before* it is reached, by the chooser — a third `refused_in_world` in one chapter is
 * read as paper instead. The >1-in-4 and >1-in-6 checks, and the zero-in-a-part one, are the
 * editor's **detection only**: they never convert a filing, never rewrite a row and never touch
 * a reader's page; they exist so the author sees a chapter or a part drifting and decides.
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

/** Statuses that mean "a decision was made" — a legacy `escalated` row is not one of them. */
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

/** One breach, as the check found it: the rule, the scope it broke on, and the line it prints. */
export type DispositionBreach = {
  rule: keyof DispositionLimits;
  key: string;
  line: string;
};

/**
 * The breaches, in one pass — **the single source of every threshold**. `dispositionLimits` folds
 * them into the verdict and `dispositionLimitLines` prints them; no number is written twice.
 *
 * BOOK-174 §7 splits the four checks by who enforces them, and that split is the design, not an
 * oversight:
 *
 *   · **three in a row** is enforced *before* it happens — the chooser refuses to store a third
 *     `refused_in_world` and reads that filing as paper instead. Finding one here means a decision
 *     got past the chooser (a replay, an older row), and the line says so;
 *   · **more than one in four** (a chapter, at ≥6 accepted) and **more than one in six** (a part)
 *     are the editor's **detection only**: they never convert a filing and never touch a row. They
 *     exist so the author sees a chapter or a part drifting towards «a court», and decides;
 *   · **zero in a part** is the same kind of signal in the other direction: a world that never
 *     refuses has no weight, and the finale costs nothing.
 */
export function dispositionBreaches(rows: readonly DispositionCountsRow[]): DispositionBreach[] {
  const breaches: DispositionBreach[] = [];
  for (const row of rows) {
    if (row.scope === 'chapter') {
      if (row.run >= 3) {
        breaches.push({
          rule: 'run',
          key: row.key,
          line: `${row.key}: ${String(row.run)} подряд — стоп, следующий отказ в мире читается бумагой`,
        });
      }
      if (row.accepted >= CHAPTER_SHARE_MIN && row.in_world * 4 > row.accepted) {
        breaches.push({
          rule: 'chapterShare',
          key: row.key,
          line: `${row.key}: отказов в мире ${String(row.in_world)} из ${String(row.accepted)} — больше 1 в 4`,
        });
      }
    }
    if (row.scope === 'part') {
      if (row.in_world * 6 > row.accepted) {
        breaches.push({
          rule: 'partShare',
          key: row.key,
          line: `${row.key}: отказов в мире ${String(row.in_world)} из ${String(row.accepted)} — больше 1 в 6`,
        });
      }
      if (row.accepted > 0 && row.in_world === 0) {
        breaches.push({
          rule: 'partZero',
          key: row.key,
          line: `${row.key}: отказов в мире 0 из ${String(row.accepted)} — часть без отказа`,
        });
      }
    }
  }
  return breaches;
}

/** The editor's verdict, over the stored rows: the same breaches, folded into four words. */
export function dispositionLimits(rows: readonly DispositionCountsRow[]): DispositionLimits {
  const found = new Set(dispositionBreaches(rows).map((breach) => breach.rule));
  return {
    run: found.has('run') ? 'stop' : 'ok',
    chapterShare: found.has('chapterShare') ? 'over' : 'ok',
    partShare: found.has('partShare') ? 'over' : 'ok',
    partZero: found.has('partZero') ? 'defect' : 'ok',
  };
}

/** The same verdict as the operator's lines: one per breach, `ok` when there is none. */
export function dispositionLimitLines(rows: readonly DispositionCountsRow[]): string[] {
  const lines = dispositionBreaches(rows).map((breach) => breach.line);
  return lines.length === 0 ? ['ok'] : lines;
}
