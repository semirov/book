/**
 * The title page's byline count (BOOK-DOC-4): «Филипп Семиров + N», where N is the number
 * of readers with **at least one surviving character** in the current text.
 *
 * It is the same measurement as the authors list — the last version of every paragraph, the
 * characters whose last cause is a reader — but as one grouped `COUNT`, because page 1 must
 * not pay for a full `readAuthors` (which also reads every erosion series). Hidden readers and
 * the author's own identity are excluded here exactly as `readAuthors` excludes them, so the
 * byline and the list cannot disagree about how many readers are named.
 */

import type { AuthorsCountDto } from '@book/shared';

import type { Db } from '../db/db.ts';

/**
 * One row per reader who still owns characters in the final text.
 *
 * `erased` versions are not text; `identity_id IS NULL` is the author, the operator or a
 * write that matched no lease — never a contributor; `hide_from_authors = 1` is an opt-out,
 * and `is_author = 1` is the imprint's own reader identity (owner, 2026-10-28): the byline
 * already names him, so he is not one of the «+N».
 * A reader whose every paragraph has been rewritten keeps their history and their edits,
 * but owns zero surviving characters and is not counted.
 */
const COUNT_SQL = `
  SELECT COUNT(*) AS n FROM (
    SELECT v.identity_id
      FROM block_versions v
      JOIN (SELECT block_uid, MAX(ver) AS ver FROM block_versions GROUP BY block_uid) last
        ON last.block_uid = v.block_uid AND last.ver = v.ver
      JOIN identities i ON i.id = v.identity_id AND i.hide_from_authors = 0 AND i.is_author = 0
     WHERE v.op != 'erased' AND v.identity_id IS NOT NULL
     GROUP BY v.identity_id
    HAVING SUM(v.chars) > 0
  ) counted`;

export function countContributors(db: Db): number {
  // `COUNT(*)` always yields one row; the cast is the shape, not a guess.
  return (db.prepare(COUNT_SQL).get() as { n: number }).n;
}

/**
 * A reader of the byline count with one monotonic marker per process. `measuredAt` never
 * goes backwards or repeats, so the client can ignore an older frame without a clock of its
 * own — and page 1 and the socket share this reader, so their markers are comparable.
 */
export function createAuthorsCount(db: Db, now: () => Date): () => AuthorsCountDto {
  let lastMs = 0;
  return () => {
    const ms = Math.max(now().getTime(), lastMs + 1);
    lastMs = ms;
    return { count: countContributors(db), measuredAt: new Date(ms).toISOString() };
  };
}
