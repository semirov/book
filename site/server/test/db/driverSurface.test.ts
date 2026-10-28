/**
 * BOOK-175 — the driver surface we actually run, proven on the major that replaced it.
 *
 * `better-sqlite3` 13 is the first Node-API release: `prebuild-install` and `bindings` are gone
 * and the binary ships inside the package. A major like that can change an error `code`, a
 * `pragma` return shape or a transaction's locking without moving the SQLite version, and our
 * engine branches on those exact strings (`engine/control.ts` maps `SQLITE_BUSY` to `DB_BUSY` /
 * 503, `engine/premise.ts` maps `SQLITE_CONSTRAINT_UNIQUE` to «superseded»). This file pins the
 * surface, not the implementation: every statement below is one the repo itself runs.
 *
 * What is deliberately not repeated here: `writeBackup`'s own guards (mode 0600, no overwrite,
 * count comparison) belong to `adminReset.test.ts`; `dbErrors.test.ts` owns the route mapping
 * and `engine/premise.test.ts` the partial-index race. Here the question is only «does the
 * driver still speak this».
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { countBook } from '../../src/reset/counts.ts';
import { writeBackup } from '../../src/reset/backup.ts';
import { createFixture } from '../helpers.ts';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A second connection on the same file, the way our four writer processes share `book.db`. */
function secondConnection(db: Db): Db {
  const other = new Database(db.name);
  opened.push(other);
  return other;
}

/** A WAL database file of our own, plus its path. */
function fileDb(): { db: Db; file: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-driver-'));
  dirs.push(dataDir);
  const file = databaseFile(dataDir);
  const db = openDatabase(file);
  opened.push(db);
  return { db, file };
}

describe('prepare — statements, binding and cursors', () => {
  it('binds named and positional parameters on the same table', () => {
    const { db } = fileDb();
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL)');

    const named = db.prepare('INSERT INTO probe (name, qty) VALUES (@name, @qty)').run({ name: 'warden', qty: 2 });
    // `run()` reports the change it made; the engine reads this as the write's receipt.
    expect(named).toMatchObject({ changes: 1 });
    expect(named.lastInsertRowid).toBeTypeOf('number');

    expect(db.prepare('INSERT INTO probe (name, qty) VALUES (?, ?)').run('lamp', 3).changes).toBe(1);

    expect(db.prepare('SELECT name, qty FROM probe WHERE name = @name').get({ name: 'warden' })).toEqual({
      name: 'warden',
      qty: 2,
    });
    expect(db.prepare('SELECT name FROM probe WHERE qty > ? ORDER BY qty').all(0)).toEqual([
      { name: 'warden' },
      { name: 'lamp' },
    ]);
    // Nothing matched is `undefined`, not a throw: the engine relies on that for lookups.
    expect(db.prepare('SELECT name FROM probe WHERE name = ?').get('absent')).toBeUndefined();
  });

  it('iterates rows lazily and supports an early break', () => {
    const { db } = fileDb();
    db.exec('CREATE TABLE probe (n INTEGER PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO probe (n) VALUES (?)');
    for (const n of [1, 2, 3, 4]) insert.run(n);

    const seen: number[] = [];
    for (const row of db.prepare('SELECT n FROM probe ORDER BY n').iterate()) seen.push((row as { n: number }).n);
    expect(seen).toEqual([1, 2, 3, 4]);

    // The early-exit path: the cursor is closed when the loop stops (the engine breaks out of
    // scans when a pass is refused).
    let count = 0;
    for (const _row of db.prepare('SELECT n FROM probe ORDER BY n').iterate()) {
      count += 1;
      if (count === 2) break;
    }
    expect(count).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM probe').get()).toEqual({ n: 4 });
  });

  it('binds a plain object that came from another realm (the early-13.x regression)', () => {
    const { db } = fileDb();
    db.exec('CREATE TABLE probe (name TEXT NOT NULL)');
    // An early 13.x rejected plain objects whose prototype is another realm's `Object` — vitest
    // threads and any `node:vm` host hand out exactly those. 13.0.3's binder accepts any realm's
    // top-level prototype (`IsPlainObject` walks the chain), and this pins that: a driver that
    // regressed it turns red here.
    const bound = runInNewContext('({ name: "realm" })') as { name: string };
    db.prepare('INSERT INTO probe (name) VALUES (@name)').run(bound);
    expect(db.prepare('SELECT name FROM probe').all()).toEqual([{ name: 'realm' }]);
  });
});

describe('transaction — commit, rollback and the immediate variant', () => {
  it('commits a whole unit and rolls the whole unit back on a throw', () => {
    const { db } = fileDb();
    db.exec('CREATE TABLE probe (n INTEGER PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO probe (n) VALUES (?)');
    const rows = (): number => (db.prepare('SELECT COUNT(*) AS n FROM probe').get() as { n: number }).n;

    const two = db.transaction((a: number, b: number): number => {
      insert.run(a);
      insert.run(b);
      return a + b;
    });
    expect(two(1, 2)).toBe(3);
    expect(rows()).toBe(2);

    const failing = db.transaction((): void => {
      insert.run(3);
      throw new Error('boom');
    });
    expect(() => failing()).toThrow('boom');
    // The first insert belongs to the aborted unit: no half-written step.
    expect(rows()).toBe(2);
  });

  it('exposes immediate/deferred/exclusive and runs them', () => {
    const { db } = fileDb();
    db.exec('CREATE TABLE probe (n INTEGER PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO probe (n) VALUES (?)');

    const run = db.transaction((n: number): void => {
      insert.run(n);
    });
    // Not used by the site today, but a nesting/locking change here would be silent.
    expect(typeof run.immediate).toBe('function');
    expect(typeof run.deferred).toBe('function');
    expect(typeof run.exclusive).toBe('function');

    run.immediate(7);
    run.deferred(8);
    run.exclusive(9);
    expect(db.prepare('SELECT n FROM probe ORDER BY n').all()).toEqual([{ n: 7 }, { n: 8 }, { n: 9 }]);
  });
});

describe('pragma — read, write and the simple shape', () => {
  it('reads back what openDatabase() set', () => {
    const { db } = fileDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    // `busy_timeout = 5000` is the site's setting; it must survive the round trip as a number.
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('writes a pragma and reads the value back', () => {
    const { db } = fileDb();
    db.pragma('busy_timeout = 1234');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(1234);
    expect(db.pragma('busy_timeout')).toEqual([{ timeout: 1234 }]);
  });

  it('returns rows as objects with the column names migrate.ts reads', () => {
    const { db } = fileDb();
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, name TEXT)');
    const columns = db.pragma('table_info(probe)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(['id', 'name']);
    expect(db.pragma('user_version', { simple: true })).toBe(0);
  });
});

describe('backups — VACUUM INTO through the repo path, and db.backup()', () => {
  it('takes a copy the repo can verify and read back', () => {
    const fixture = createFixture();
    try {
      const file = join(fixture.dataDir, 'copy.db');
      const fact = writeBackup(fixture.db, file, countBook(fixture.db));
      expect(fact).toMatchObject({ integrity: 'ok', countsMatch: true, mode: '0600' });

      const copy = new Database(file, { readonly: true, fileMustExist: true });
      try {
        expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
        // The copy answers the schema's own query: the tables came across, not just the header.
        expect(copy.prepare('SELECT COUNT(*) AS n FROM chapters').get()).toEqual(
          fixture.db.prepare('SELECT COUNT(*) AS n FROM chapters').get(),
        );
      } finally {
        copy.close();
      }
    } finally {
      fixture.close();
    }
  });

  it('still ships db.backup(), which resolves to a readable file', async () => {
    const { db, file } = fileDb();
    db.exec('CREATE TABLE probe (n INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO probe (n) VALUES (1)').run();

    const target = `${file}.backup`;
    const progress: unknown[] = [];
    // The promise API is what the memo lists; nothing in the site uses it yet, so this is the
    // proof that it exists and works before someone reaches for it.
    const result = await db.backup(target, { progress: (info) => progress.push(info) });
    expect(result).toMatchObject({ remainingPages: 0 });
    expect(result.totalPages).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);

    const copy = new Database(target, { readonly: true, fileMustExist: true });
    try {
      expect(copy.prepare('SELECT n FROM probe').all()).toEqual([{ n: 1 }]);
    } finally {
      copy.close();
    }
  });
});

describe('SqliteError codes — the strings the engine branches on', () => {
  it('reports a second writer as SQLITE_BUSY', () => {
    const { db } = fileDb();
    db.exec('CREATE TABLE probe (n INTEGER PRIMARY KEY)');
    db.pragma('busy_timeout = 50');

    const other = secondConnection(db);
    // A competing process holding the write lock: exactly the four-writer shape.
    other.exec('BEGIN IMMEDIATE');
    try {
      let caught: unknown;
      try {
        db.prepare('INSERT INTO probe (n) VALUES (1)').run();
      } catch (error) {
        caught = error;
      }
      // `engine/control.ts` maps this code to `DB_BUSY` / 503, not to `SCHEMA_MISMATCH`.
      expect(caught).toBeInstanceOf(Database.SqliteError);
      expect((caught as { code: string }).code).toBe('SQLITE_BUSY');
      expect((caught as Error).name).toBe('SqliteError');
    } finally {
      other.exec('ROLLBACK');
    }
  });

  it('reports a duplicate as SQLITE_CONSTRAINT_UNIQUE', () => {
    const { db } = fileDb();
    db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, chapter INTEGER NOT NULL)');
    db.exec('CREATE UNIQUE INDEX probe_one_per_chapter ON probe (chapter) WHERE chapter > 0');
    db.prepare('INSERT INTO probe (id, chapter) VALUES (?, ?)').run('a', 5);

    let caught: unknown;
    try {
      db.prepare('INSERT INTO probe (id, chapter) VALUES (?, ?)').run('b', 5);
    } catch (error) {
      caught = error;
    }
    // `engine/premise.ts` turns this exact code into «superseded»; a different string would
    // surface as a 500 instead of a quiet decision.
    expect(caught).toBeInstanceOf(Database.SqliteError);
    expect((caught as { code: string }).code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect((caught as Error).message).toMatch(/UNIQUE constraint failed/u);
  });
});
