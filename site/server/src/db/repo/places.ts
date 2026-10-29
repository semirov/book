/**
 * `reader_places` — where each reader stopped reading (BOOK-209).
 *
 * One row per identity, and the row is an **anchor**, not a scroll offset: `chapter` plus
 * `sentence_id` name the sentence the reader left at, `delta_px` how far below the reading line
 * that sentence sat. The prose is rewritten between two visits, so a stored pixel height would
 * point at a paragraph that moved; an anchor is resolved against the text the reader is served
 * now, which is what makes «a second device resumes» true rather than approximate.
 *
 * Two rules this module keeps, and nowhere else types SQL for the table:
 *
 *   · **a write replaces the row only when it is newer.** `identity_id` is the primary key, so a
 *     second `PUT` from the same reader updates the one row instead of stacking positions up; but
 *     a place is a fact about a moment, so the update is conditional on the incoming `at` being
 *     strictly newer than the stored one. A tab whose clock (or whose queue) is behind can
 *     therefore never carry a reader back to where they were an hour ago: the newer row stands and
 *     the write is a no-op. Equal instants do not overwrite either — «newer» is strict, so a
 *     device that re-sends the visit it already stored changes nothing;
 *   · **a read is own only.** There is no query here that lists another identity's place; the
 *     identity is always the caller's session, and the route never hands in an id from the wire.
 *
 * `at` is compared **chronologically** (`julianday`), not lexically: the route accepts every ISO
 * instant, so a stored `…T10:00:00+03:00` and an incoming `…T09:00:00Z` are the *same kind* of
 * value in different offsets, and `'09…' < '10…'` would read a newer visit as the older one. A
 * stored `at` that no date function can read (a row written outside this route) is **not** allowed
 * to freeze the row: it answers `NULL`, so the clause lets any valid new place through rather than
 * leaving the reader stuck at a place nobody can interpret.
 *
 * The types are validated at the route (`http/routes/place.ts`), so the store is dumb on purpose:
 * a value that reached here has already been bounded.
 */

import type { ReaderPlaceDto } from '@book/shared';

import type { Db } from '../db.ts';

/** One row as the table spells it: snake_case, and no field the wire could see twice. */
type PlaceRow = {
  chapter: number;
  sentence_id: string;
  delta_px: number;
  at: string;
};

/** The reader's stored place, or `null` when they have never left one — no invented default. */
export function readPlace(db: Db, identityId: string): ReaderPlaceDto | null {
  const row = db
    .prepare('SELECT chapter, sentence_id, delta_px, at FROM reader_places WHERE identity_id = ?')
    .get(identityId) as PlaceRow | undefined;
  if (row === undefined) return null;
  return { chapter: row.chapter, sentenceId: row.sentence_id, deltaPx: row.delta_px, at: row.at };
}

/**
 * Stores the reader's place if it is newer than the one on record, replacing the row they already
 * had (`ON CONFLICT` on the primary key). A fresh identity has no row, so the insert path is
 * unconditional — the condition guards only the update. `at` is the visiting device's own clock,
 * stored as it was sent: the site's clock says when the row was written, the field says when the
 * reader was there, and the newer visit is the one that stands.
 *
 * A stale write is not an error: the row simply keeps the newer place, and the route answers `204`
 * because «the stored place is at least as new as yours» is what the caller asked to be true.
 */
export function writePlace(db: Db, identityId: string, place: ReaderPlaceDto): void {
  db.prepare(
    `INSERT INTO reader_places (identity_id, chapter, sentence_id, delta_px, at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(identity_id) DO UPDATE SET
       chapter     = excluded.chapter,
       sentence_id = excluded.sentence_id,
       delta_px    = excluded.delta_px,
       at          = excluded.at
     WHERE julianday(reader_places.at) IS NULL
        OR julianday(excluded.at) > julianday(reader_places.at)`,
  ).run(identityId, place.chapter, place.sentenceId, place.deltaPx, place.at);
}
