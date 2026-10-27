/**
 * BOOK-56 — does the log hold a change a reader caused?
 *
 * The book's history surfaces (chronicle, cascade, provenance, revision apparatus, authors,
 * discussion) narrate a past. An empty book has no such past, and a machine's own revision
 * is not a reader's history. The one fact that decides it is whether a `changes` row carries
 * a `source_comment` — a filing that became a change — and it is computed here, once, so no
 * surface recounts the log on its own.
 *
 * A book that has begun is a smaller fact than a reader change and a larger one than nothing:
 * its log holds a first moment, so the chronicle exists from that moment and carries exactly
 * one record — «начало книги». The rest of the apparatus still waits for a reader change.
 */

import type { Db } from '../db/db.ts';

/** The rows a reader caused: a change whose source is a comment, never a machine pass. */
export const READER_CHANGES_SQL = 'SELECT COUNT(*) AS n FROM changes WHERE source_comment IS NOT NULL';

/** The book's first logged moment: the oldest row's `at`, and the starting record's date. */
export const FIRST_EVENT_SQL = 'SELECT at FROM events ORDER BY hseq ASC LIMIT 1';

export function countReaderChanges(db: Db): number {
  const row = db.prepare(READER_CHANGES_SQL).get() as { n: number };
  return row.n;
}

/**
 * `null` only on an empty log. A book that has begun has at least one row — the one that
 * makes the chronicle exist — so every non-empty log names the moment the book started.
 */
export function firstEventAt(db: Db): string | null {
  const row = db.prepare(FIRST_EVENT_SQL).get() as { at: string } | undefined;
  return row?.at ?? null;
}
