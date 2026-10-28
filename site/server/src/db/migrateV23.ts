/**
 * v23 — the author marker (`identities.is_author`), the owner's decision of 2026-10-28.
 *
 * The owner signs in and files like every reader, so his own identity was a contributor row and
 * the `+1` on the byline was him. The column says which reader *is* the imprint's author; the
 * readers list, the listed shares and the byline count skip him, while filings, discussion and
 * his own trace stay his. It lives here rather than inside `migrate.ts` for the same reason the
 * v22 ledger step does: the schema step is one line, the decision is documented once.
 *
 * The backfill runs exactly once and records what it decided in `meta`. It never guesses between
 * several identities — several readers and no marker is `none:multiple:<n>`, and the operator
 * marks his own later through `POST /api/admin/authors/author`.
 */

import type { Db } from './db.ts';
import { getMeta, setMeta } from './repo/meta.ts';

/** The `meta` key that records the one-time author backfill decision. */
export const AUTHOR_MARKER_KEY = 'identities.is_author';

export function migrateV23(db: Db): void {
  // `ALTER TABLE … ADD COLUMN` unless the column is already there: the step runs on a fresh
  // install too, and a build that runs it twice must not fail.
  const columns = new Set(
    (db.pragma('table_info(identities)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has('is_author')) {
    db.exec('ALTER TABLE identities ADD COLUMN is_author INTEGER NOT NULL DEFAULT 0');
  }
  backfillAuthorMarker(db);
}

/**
 * Mark the author on a database that predates the column, exactly once.
 *
 * Four outcomes: `existing` (a marker is already there), `single:<id>` (the book held one
 * identity, and it is the author), `none:empty` (no identity yet — a fresh book is marked by the
 * operator) and `none:multiple:<n>` (several readers, no marker: never guess). A recorded
 * decision is never recomputed, so a later boot cannot mark a reader nobody chose.
 */
export function backfillAuthorMarker(db: Db): void {
  if (getMeta(db, AUTHOR_MARKER_KEY) !== null) return;
  const marked = db.prepare('SELECT COUNT(*) AS n FROM identities WHERE is_author = 1').get() as { n: number };
  if (marked.n > 0) {
    setMeta(db, AUTHOR_MARKER_KEY, 'existing');
    return;
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM identities').get() as { n: number };
  if (total.n === 0) {
    setMeta(db, AUTHOR_MARKER_KEY, 'none:empty');
    return;
  }
  if (total.n === 1) {
    const only = db.prepare('SELECT id FROM identities').get() as { id: string };
    db.prepare('UPDATE identities SET is_author = 1 WHERE id = ?').run(only.id);
    setMeta(db, AUTHOR_MARKER_KEY, `single:${only.id}`);
    return;
  }
  setMeta(db, AUTHOR_MARKER_KEY, `none:multiple:${String(total.n)}`);
}
