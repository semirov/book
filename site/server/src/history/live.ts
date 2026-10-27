/**
 * BOOK-56 — does the log hold a change a reader caused?
 *
 * The book's history surfaces (chronicle, cascade, provenance, revision apparatus, authors,
 * discussion) narrate a past. An empty book has no such past, and a machine's own revision
 * is not a reader's history. The one fact that decides it is whether a `changes` row carries
 * a `source_comment` — a filing that became a change — and it is computed here, once, so no
 * surface recounts the log on its own.
 */

import type { Db } from '../db/db.ts';

/** The rows a reader caused: a change whose source is a comment, never a machine pass. */
export const READER_CHANGES_SQL = 'SELECT COUNT(*) AS n FROM changes WHERE source_comment IS NOT NULL';

export function countReaderChanges(db: Db): number {
  const row = db.prepare(READER_CHANGES_SQL).get() as { n: number };
  return row.n;
}
