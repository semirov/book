/**
 * Migration v32 (BOOK-218) — the filing's own public number, written down instead of inferred.
 *
 * A reader is shown «замечание 12», and that number may never change: it is the same number the
 * margin note, the card and the record's head print. Until now the number was the row's implicit
 * `rowid` — an implementation detail SQLite is free to renumber (`VACUUM`, a table rebuild), so
 * the row a reader was shown could be renamed under them. This step gives `comments` an explicit
 * `number INTEGER NOT NULL` column, a unique index, and a **backfill ordered by the existing
 * `rowid`**: every row a reader can already see keeps the number it was counted with.
 *
 * **Nothing is invented and nothing is squeezed.** The backfill counts rows in `rowid` order, so
 * the oldest filing is 1 and the newest is N — the order the row was inserted in, which is what
 * the column means. `hidden` rows are counted too: their number is theirs and must not be handed
 * to a later filing.
 *
 * **`ADD COLUMN` cannot be `NOT NULL` without a default in SQLite**, so the column is added with
 * `DEFAULT 0`, backfilled, and the default left in place: the product's only writer
 * (`insertComment`) always assigns the next number itself, and a row that somehow arrives at 0
 * is a public face the page prints as «замечание 0» — visible, not silent.
 *
 * **A fresh install equals a migrated one**: both read `COMMENTS_TABLE_SQL` and
 * `COMMENTS_NUMBER_INDEX_SQL` from `tables.ts`, and the column's own definition is the same in
 * both. Idempotent to the statement: a table that already has the column and a full backfill is
 * left untouched.
 */

import type { Db } from './db.ts';
import { COMMENTS_NUMBER_INDEX_SQL } from './tables.ts';

function columnNames(db: Db, table: string): Set<string> {
  const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(info.map((column) => column.name));
}

/** Does this install already carry the column? */
export function commentsNumberIsCurrent(db: Db): boolean {
  return columnNames(db, 'comments').has('number');
}

/**
 * The backfill: every row in `rowid` order, numbered from 1. `rowid` is read here on purpose —
 * it is the **oldest** ordering the table still has, and this is the last time anything reads
 * it: from v32 on, the number is the table's own column.
 */
function backfill(db: Db): void {
  const rows = db.prepare('SELECT rowid AS r FROM comments ORDER BY rowid').all() as Array<{ r: number }>;
  const write = db.prepare('UPDATE comments SET number = ? WHERE rowid = ?');
  rows.forEach((row, index) => write.run(index + 1, row.r));
}

/**
 * The v32 step: the column, its numbers and its index. `run` in `migrate` wraps this in a
 * transaction, so a failure leaves neither a half-numbered table nor a bumped `user_version`.
 */
export function migrateV32(db: Db): void {
  if (!commentsNumberIsCurrent(db)) {
    // `DEFAULT 0` is what makes `ADD COLUMN … NOT NULL` legal on a table with rows; the backfill
    // replaces every zero before the unique index can see one.
    db.exec('ALTER TABLE comments ADD COLUMN number INTEGER NOT NULL DEFAULT 0');
  }
  const unnumbered = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE number = 0').get() as { n: number };
  if (unnumbered.n > 0) backfill(db);
  db.exec(COMMENTS_NUMBER_INDEX_SQL);
}
