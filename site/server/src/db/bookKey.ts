/**
 * What a whole-book aggregate depends on, cheaply: the front revision, every chapter `rev`, the
 * last paragraph version written, and **which** readers are hidden (`POST /api/authors/hide`
 * moves the count without touching the text).
 *
 * The byline count (`authors/count.ts`) and the book's outlay (`cost/book.ts`) are both
 * whole-book aggregates: the count is the last version of every paragraph joined to
 * `identities`, the outlay is every step's tokens priced by the rate table. A repeated request
 * must not pay for either, so each answer is remembered under this key and invalidated by it.
 * Every part is a small indexed read — a `chapters` sum, the `block_versions_hseq` index
 * and the reader list — never a scan of the block history.
 *
 * One definition for two routes (BOOK-114): the title page and the cost line answer for the same
 * book state, so their memories move together and cannot drift apart. The cost route's own key
 * widens this one (`costKey` in `cost/book.ts`): a step close writes tokens without moving the
 * prose, so the outlay's dependency set is larger than the byline's.
 */

import type { Db } from './db.ts';

export function bookStateKey(db: Db, frontRev: number): string {
  const chapters = db.prepare('SELECT COALESCE(SUM(rev), 0) AS revs FROM chapters').get() as { revs: number };
  // The set, not a count: two readers swapping the flag keep the same sum but not the same byline.
  const hidden = db
    .prepare(
      `SELECT COALESCE(GROUP_CONCAT(id), '') AS ids
         FROM (SELECT id FROM identities WHERE hide_from_authors = 1 ORDER BY id)`,
    )
    .get() as { ids: string };
  // Paragraph versions are append-only: the newest one is the last write of prose.
  const lastBlock = db.prepare('SELECT COALESCE(MAX(hseq), 0) AS hseq FROM block_versions').get() as { hseq: number };
  return `${frontRev}|${chapters.revs}|${lastBlock.hseq}|${hidden.ids}`;
}
