/**
 * BOOK-206 (owner's correction, 2026-10-29) — migration v37 on the schema side.
 *
 * The attempt ledger gains the columns the six-attempt ladder decides with, and only them. A fresh
 * install declares them in `tables.ts`; `migrateV37` appends what an older volume is missing, so a
 * row written before this step keeps every value it had and reads as a narrow attempt.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { V37_ATTEMPT_COLUMNS, migrateV37 } from '../../src/db/migrateV37.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

describe('migration v37 — six attempts on the ledger', () => {
  it('a fresh install carries every v37 column, in the order the step appends them', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(SCHEMA_VERSION).toBe(37);
    expect(columns(db, 'comment_attempts').slice(-V37_ATTEMPT_COLUMNS.length)).toEqual(
      V37_ATTEMPT_COLUMNS.map(([name]) => name),
    );
    db.close();
  });

  it('replays as a no-op on an install that already has the shape', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const before = columns(db, 'comment_attempts');
    migrateV37(db);
    expect(columns(db, 'comment_attempts')).toEqual(before);
    db.close();
  });

  it('keeps an old row narrow, non-desperate, and still readable by the due query', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // A ledger row as v33 wrote it, before the columns existed.
    db.exec('ALTER TABLE comment_attempts DROP COLUMN widened');
    db.exec('ALTER TABLE comment_attempts DROP COLUMN widening_note');
    db.exec('ALTER TABLE comment_attempts DROP COLUMN desperate');
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO comment_attempts (comment_id, n, at, day, body_sha, anchor_sha, outcome, tries)
       VALUES ('cmt_v33', 1, '2026-10-29T00:00:00Z', '2026-10-29', 'sha-1', 'anchor-1', 'submitted', 2)`,
    ).run();
    db.pragma('foreign_keys = ON');

    migrateV37(db);
    expect(db.prepare('SELECT n, tries, widened, widening_note, desperate FROM comment_attempts').get()).toEqual({
      n: 1,
      tries: 2,
      widened: null,
      widening_note: null,
      desperate: 0,
    });
    db.close();
  });
});
