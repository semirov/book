/**
 * Migration v32 (BOOK-218) — the filing's own public number, written down.
 *
 * The property the owner asked for is not «a column exists» but «a number a reader was shown
 * never moves»: two inserts get consecutive numbers, a `VACUUM` (which renumbers implicit
 * rowids) changes nothing, and a v29 install upgraded by this step ends with the same numbers a
 * fresh install would have given the same rows in the same order. The step's own failure modes
 * — inventing a number, dropping a row, renumbering a hidden one — are asserted beside it.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { insertComment } from '../../src/comments/repo.ts';
import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { commentsNumberIsCurrent, migrateV32 } from '../../src/db/migrateV32.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';

const AT = '2026-10-29T09:00:00Z';

let db: Db;

afterEach(() => {
  db.close();
});

/** One identity is all a filing needs; the author snapshot travels on the row. */
function identity(target: Db): void {
  target
    .prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idt_1', 'yandex-1', 'Аня', ?, ?)`,
    )
    .run(AT, AT);
}

function boot(): Db {
  const fresh = openDatabase(':memory:');
  migrate(fresh);
  identity(fresh);
  return fresh;
}

/** A filing with every required column at its smallest honest value. */
function filing(id: string, overrides: Partial<Parameters<typeof insertComment>[1]> = {}): void {
  insertComment(db, {
    id,
    identityId: 'idt_1',
    chapter: 8,
    blockId: null,
    blockIndex: null,
    baseRev: null,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: 'Служебное замечание.',
    proposedText: null,
    interventionKind: null,
    bodySha: `sha-${id}`,
    flags: [],
    ipHash: 'ip',
    status: 'new',
    guard: null,
    reason: null,
    createdAt: AT,
    idemKey: null,
    ...overrides,
  });
}

function numbers(): number[] {
  return (db.prepare('SELECT number FROM comments ORDER BY number').all() as Array<{ number: number }>).map(
    (row) => row.number,
  );
}

describe('migration v32 — the filing’s public number', () => {
  it('gives two inserts consecutive numbers, 1-based and in insertion order', () => {
    db = boot();
    expect(SCHEMA_VERSION).toBe(37);
    filing('cmt_a');
    filing('cmt_b');
    expect(numbers()).toEqual([1, 2]);
    // The number is the row's own column, never an implicit rowid.
    const row = db.prepare('SELECT number, rowid AS r FROM comments WHERE id = ?').get('cmt_b') as {
      number: number;
      r: number;
    };
    expect(row.number).toBe(2);
  });

  it('keeps the numbers through VACUUM, which may renumber implicit rowids', () => {
    db = boot();
    filing('cmt_a');
    filing('cmt_b');
    const before = numbers();
    db.exec('VACUUM');
    expect(numbers()).toEqual(before);
  });

  it('keeps a hidden row’s number out of circulation', () => {
    db = boot();
    filing('cmt_a');
    filing('cmt_b');
    db.prepare("UPDATE comments SET status = 'hidden' WHERE id = 'cmt_a'").run();
    filing('cmt_c');
    // 1 is taken (by a row the public page no longer lists), so the next filing is 3.
    expect(numbers()).toEqual([1, 2, 3]);
  });

  it('refuses a duplicate number: the index is the table’s own rule', () => {
    db = boot();
    filing('cmt_a');
    expect(() => db.prepare('UPDATE comments SET number = 1').run()).not.toThrow();
    filing('cmt_b');
    expect(() => db.prepare('UPDATE comments SET number = 1 WHERE id = ?').run('cmt_b')).toThrow(
      /UNIQUE/u,
    );
  });

  it('backfills a v29 install by the order the rows were written, and changes no row', () => {
    db = openDatabase(':memory:');
    migrate(db);
    // Shape a v29 install: the number and its index did not exist before this step.
    db.exec('DROP INDEX comments_number');
    db.exec('ALTER TABLE comments DROP COLUMN number');
    db.pragma('user_version = 29');
    identity(db);
    const insert = db.prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
       VALUES (?, 'idt_1', 8, 'Аня', 'Служебное замечание.', ?, 'ip', 'new', ?)`,
    );
    for (const [index, id] of ['cmt_old', 'cmt_mid', 'cmt_new'].entries()) {
      insert.run(id, `sha-${String(index)}`, AT);
    }
    // A deleted row leaves a gap in the rowid space; the backfill must still be 1..N.
    db.prepare("DELETE FROM comments WHERE id = 'cmt_mid'").run();
    expect(commentsNumberIsCurrent(db)).toBe(false);

    expect(migrate(db)).toEqual({ from: 29, to: SCHEMA_VERSION });
    expect(commentsNumberIsCurrent(db)).toBe(true);
    const rows = db.prepare('SELECT id, number FROM comments ORDER BY number').all();
    expect(rows).toEqual([
      { id: 'cmt_old', number: 1 },
      { id: 'cmt_new', number: 2 },
    ]);
    // A migrated install states the fresh install's column: NOT NULL, the same default, and a
    // reader cannot store a row with no number twice (the unique index refuses the second zero).
    const column = (db.pragma('table_info(comments)') as Array<{ name: string; notnull: number; dflt_value: string | null }>).find(
      (entry) => entry.name === 'number',
    );
    expect(column).toMatchObject({ notnull: 1, dflt_value: '0' });
    const unnumbered = db.prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
       VALUES (?, 'idt_1', 8, 'Аня', 'x', ?, 'ip', 'new', ?)`,
    );
    unnumbered.run('cmt_nonum_1', 'sha-n1', AT);
    expect(() => unnumbered.run('cmt_nonum_2', 'sha-n2', AT)).toThrow(/UNIQUE/u);
    // …and the step itself renumbers a zero row, so the reader's next number is never taken.
    migrateV32(db);
    expect(db.prepare("SELECT number FROM comments WHERE id = 'cmt_nonum_1'").get()).toEqual({ number: 3 });
  });

  it('replays as a no-op, and numbers nothing twice', () => {
    db = boot();
    filing('cmt_a');
    filing('cmt_b');
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(migrateV32(db)).toBeUndefined();
    expect(numbers()).toEqual([1, 2]);
    // A row that somehow arrived unnumbered is numbered by the step, not left at zero.
    db.prepare("INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at, number) VALUES ('cmt_zero', 'idt_1', 8, 'Аня', 'x', 'z', 'ip', 'new', ?, 0)").run(AT);
    migrateV32(db);
    expect(numbers()).toEqual([1, 2, 3]);
  });
});
