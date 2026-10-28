/**
 * «Восстановить главу 12 на момент чтения главы 10» (ADR-043 §4, ADR-041 §1, BOOK-187 AC 10).
 *
 * The question git answered with `git checkout <sha> -- manuscript/ch12.md` has one difference
 * here: there is no commit to name, but there is a better anchor — **the event that created the
 * other chapter**. «As of the reading of chapter 10» means the book as it stood when chapter 10
 * first existed, which is one `events` row (`kind = 'chapter.created'`, the vocabulary of
 * `db/tables.ts`), and the answer is the last revision of chapter 12 at or before it:
 *
 * ```
 * rev(12 as of the creation of 10) = max(rev) FROM revisions
 *                                    WHERE chapter = 12 AND hseq <= hseq(created 10)
 * ```
 *
 * A chapter with no `chapter.created` row (an import that predates the log, a fixture that seeded
 * rows directly) falls back to the reading chapter's own first revision — the earliest moment the
 * book can prove it had chapter 10 at all. No event and no revision means the question has no
 * answer, and `null` says so instead of guessing.
 *
 * **The query writes nothing.** Turning the answer into text is the restore path's job, and it
 * publishes a *new* revision (`cause_kind = 'restore'`) rather than moving the old one — which is
 * why this function is a read and stays one.
 */

import type { Db } from '../db/db.ts';
import type { HistoryKind } from '@book/shared';

/** The exact `events.kind` of a chapter's birth (`db/tables.ts`; written by `ingest/applyChapter.ts`). */
const CHAPTER_CREATED: HistoryKind = 'chapter.created';

export type AsOf = { rev: number; at: string };

/** The moment «chapter `readingChapter` first existed» in the book's clock, or null. */
export function readingHseq(db: Db, readingChapter: number): number | null {
  const created = db
    .prepare('SELECT MIN(hseq) AS hseq FROM events WHERE kind = ? AND chapter = ?')
    .get(CHAPTER_CREATED, readingChapter) as { hseq: number | null };
  if (created.hseq !== null) return created.hseq;
  // A book whose chapter was seeded without a log entry still has a first revision, and that is
  // the earliest moment it can name for the chapter — never a later one.
  const first = db
    .prepare('SELECT MIN(hseq) AS hseq FROM revisions WHERE chapter = ? AND hseq IS NOT NULL')
    .get(readingChapter) as { hseq: number | null };
  return first.hseq;
}

/** The last revision of `chapter` at or before the creation of `readingChapter`. */
export function asOfReading(db: Db, chapter: number, readingChapter: number): AsOf | null {
  const moment = readingHseq(db, readingChapter);
  if (moment === null) return null;
  const row = db
    .prepare(
      `SELECT rev, at FROM revisions
        WHERE chapter = ? AND hseq IS NOT NULL AND hseq <= ?
        ORDER BY rev DESC LIMIT 1`,
    )
    .get(chapter, moment) as AsOf | undefined;
  return row ?? null;
}
