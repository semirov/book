import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import Database from 'better-sqlite3';

import { openDatabase, type Db } from '../src/db/db.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import {
  inspectDataDir,
  inspectDumps,
  inspectFrame,
  inspectGraph,
  inspectSchema,
} from '../src/doctor/inspect.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * BOOK-188 — the inspector behind `GET /api/admin/doctor`.
 *
 * Every assertion here is about what the preflight is allowed to *see*: counts, paths, booleans
 * and sha256, never a text or a secret. The negative cases matter as much as the positive ones —
 * a broken dump, a stray file and an absent stage-3 table must be reported, not thrown.
 */

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const scratchDirs: string[] = [];
const scratchDbs: Db[] = [];
const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const db of scratchDbs.splice(0)) db.close();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A migrated fixture whose ch01/ch42 carry the frozen frame, reconciled into `blocks`. */
function framed(): Fixture {
  const fixture = createFixture({ 'ch01.md': FRAME_FIRST_SENTENCE, 'ch42.md': FRAME_LAST_SENTENCE });
  fixtures.push(fixture);
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  return fixture;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** A scratch database inside a temp dir, kept until `afterEach` closes it. */
function scratchDb(dir: string): Db {
  const db = openDatabase(join(dir, 'book.db'));
  scratchDbs.push(db);
  return db;
}

/** A factory that counts every open and hands back the real read-only connection. */
function countingOpen(): { impl: typeof Database; opens: () => number } {
  let opens = 0;
  const Counting = function (this: unknown, file: string, options: Database.Options): unknown {
    opens += 1;
    return new Database(file, options);
  };
  return { impl: Counting as unknown as typeof Database, opens: () => opens };
}

describe('inspectSchema', () => {
  it('reports the file version next to the version this image expects', () => {
    const fixture = framed();
    expect(inspectSchema(fixture.db)).toEqual({ userVersion: SCHEMA_VERSION, expected: SCHEMA_VERSION });
  });
});

describe('inspectFrame', () => {
  it('reads the seeded rows and reports the sha256 of the frozen sentences', () => {
    const fixture = framed();
    const frame = inspectFrame(fixture.db);
    // BOOK-187: a v28 volume carries the two rows, so the table — not the basis slot — answers.
    expect(frame.source).toBe('book_frame');
    expect(frame.rows).toEqual([
      { chapter: 1, position: 'first', sha256: sha(FRAME_FIRST_SENTENCE) },
      { chapter: 42, position: 'last', sha256: sha(FRAME_LAST_SENTENCE) },
    ]);
    // The digest is the whole answer: neither sentence may ride along in the report.
    const printed = JSON.stringify(frame);
    expect(printed).not.toContain(FRAME_FIRST_SENTENCE);
    expect(printed).not.toContain(FRAME_LAST_SENTENCE);
  });

  it('prefers BOOK-187’s book_frame table when it exists', () => {
    const dir = tempDir('book-frame-');
    const db = scratchDb(dir);
    db.exec('CREATE TABLE book_frame (chapter INTEGER NOT NULL, position TEXT NOT NULL, text TEXT NOT NULL)');
    db.prepare('INSERT INTO book_frame (chapter, position, text) VALUES (?, ?, ?)').run(1, 'first', 'Первый слот.');
    db.prepare('INSERT INTO book_frame (chapter, position, text) VALUES (?, ?, ?)').run(42, 'last', 'Последний слот.');

    const frame = inspectFrame(db);
    expect(frame.source).toBe('book_frame');
    expect(frame.rows).toEqual([
      { chapter: 1, position: 'first', sha256: sha('Первый слот.') },
      { chapter: 42, position: 'last', sha256: sha('Последний слот.') },
    ]);
    expect(frame.rows).toHaveLength(2);
  });

  it('accepts a book_frame without a position column and without a text column it ignores', () => {
    const dir = tempDir('book-frame-shape-');
    const db = scratchDb(dir);
    db.exec('CREATE TABLE book_frame (chapter INTEGER NOT NULL, text TEXT NOT NULL)');
    db.prepare('INSERT INTO book_frame (chapter, text) VALUES (?, ?)').run(1, 'Один.');
    const frame = inspectFrame(db);
    expect(frame.source).toBe('book_frame');
    expect(frame.rows).toEqual([{ chapter: 1, position: 'first', sha256: sha('Один.') }]);
  });

  it('falls back to the basis when book_frame has no text column', () => {
    const fixture = framed();
    // A volume written by a build whose table had no `text`: the row cannot answer, so the slot does.
    fixture.db.exec('DROP TABLE book_frame');
    fixture.db.exec('CREATE TABLE book_frame (chapter INTEGER NOT NULL, body TEXT NOT NULL)');
    const frame = inspectFrame(fixture.db);
    expect(frame.source).toBe('basis');
    expect(frame.rows.map((row) => row.chapter)).toEqual([1, 42]);
  });
});

describe('inspectDumps', () => {
  it('reports no dump when the backups directory is absent or empty', () => {
    const empty = tempDir('dumps-empty-');
    expect(inspectDumps(empty).preMigration).toBeNull();
    mkdirSync(join(empty, 'backups'));
    expect(inspectDumps(empty).preMigration).toBeNull();
  });

  it('reads the newest pre-migration dump with integrity ok and its user_version', () => {
    const fixture = framed();
    fixture.db.pragma('wal_checkpoint(TRUNCATE)');
    const backups = join(fixture.dataDir, 'backups');
    mkdirSync(backups);
    const dump = join(backups, 'pre-v22-20261028T120000Z.db');
    copyFileSync(join(fixture.dataDir, 'book.db'), dump);

    const result = inspectDumps(fixture.dataDir).preMigration;
    expect(result).not.toBeNull();
    expect(result?.file).toBe(dump);
    expect(result?.integrity).toBe('ok');
    expect(result?.userVersion).toBe(SCHEMA_VERSION);
    expect(result?.bytes).toBeGreaterThan(0);
    expect(typeof result?.mtimeMs).toBe('number');
  });

  it('treats a garbage file as unreadable, never as a throw', () => {
    const ui = tempDir('dumps-garbage-');
    mkdirSync(join(ui, 'backups'));
    const file = join(ui, 'backups', 'pre-v21-20261027T120000Z.db');
    writeFileSync(file, 'this is not a sqlite database at all\n'.repeat(64));

    expect(() => inspectDumps(ui)).not.toThrow();
    const result = inspectDumps(ui).preMigration;
    expect(result?.integrity.startsWith('unreadable:')).toBe(true);
    expect(result?.integrity).toBe('unreadable:SQLITE_NOTADB');
    expect(result?.userVersion).toBeNull();
  });

  it('picks the newest by mtime, not the first name', () => {
    const dir = tempDir('dumps-mtime-');
    mkdirSync(join(dir, 'backups'));
    const old = join(dir, 'backups', 'pre-v22-20260101T000000Z.db');
    const young = join(dir, 'backups', 'pre-v22-20260102T000000Z.db');
    writeFileSync(old, 'old');
    writeFileSync(young, 'young');
    utimesSync(young, new Date('2026-10-28T12:00:00Z'), new Date('2026-10-28T12:00:00Z'));
    utimesSync(old, new Date('2026-10-27T12:00:00Z'), new Date('2026-10-27T12:00:00Z'));

    const result = inspectDumps(dir).preMigration;
    expect(result?.file).toBe(young);
    expect(result?.integrity.startsWith('unreadable:')).toBe(true);
  });

  it('ignores files that are not a pre-v dump', () => {
    const fixture = framed();
    const backups = join(fixture.dataDir, 'backups');
    mkdirSync(backups);
    writeFileSync(join(backups, 'book-reset-20261028T120000Z.db'), 'not a dump');
    writeFileSync(join(backups, 'notes.txt'), 'not a dump');
    expect(inspectDumps(fixture.dataDir).preMigration).toBeNull();
  });

  it('opens the dump read-only with fileMustExist, so a check can never create one', () => {
    const dir = tempDir('dumps-open-');
    mkdirSync(join(dir, 'backups'));
    writeFileSync(join(dir, 'backups', 'pre-v22-20260101T000000Z.db'), 'x');
    const seen: unknown[] = [];
    class Spy {
      constructor(_file: string, options: unknown) {
        seen.push(options);
        throw Object.assign(new Error('not opened on purpose'), { code: 'SQLITE_CANTOPEN' });
      }
    }
    const result = inspectDumps(dir, { DatabaseImpl: Spy as unknown as typeof Database });
    expect(seen).toEqual([{ readonly: true, fileMustExist: true }]);
    expect(result.preMigration?.integrity).toBe('unreadable:SQLITE_CANTOPEN');
    expect(result.preMigration?.userVersion).toBeNull();
  });

  it('memoises the integrity check by file, mtime and size', () => {
    const fixture = framed();
    fixture.db.pragma('wal_checkpoint(TRUNCATE)');
    const backups = join(fixture.dataDir, 'backups');
    mkdirSync(backups);
    const dump = join(backups, 'pre-v22-20261028T120000Z.db');
    copyFileSync(join(fixture.dataDir, 'book.db'), dump);
    const counter = countingOpen();

    const first = inspectDumps(fixture.dataDir, { DatabaseImpl: counter.impl });
    const second = inspectDumps(fixture.dataDir, { DatabaseImpl: counter.impl });
    expect(first.preMigration?.integrity).toBe('ok');
    expect(second.preMigration).toEqual(first.preMigration);
    // The second poll of the preflight must not read the dump again.
    expect(counter.opens()).toBe(1);

    // A touched file is a different file: the key carries mtime, so the answer is re-read.
    utimesSync(dump, new Date(), new Date(Date.now() + 60_000));
    const third = inspectDumps(fixture.dataDir, { DatabaseImpl: counter.impl });
    expect(counter.opens()).toBe(2);
    expect(third.preMigration?.integrity).toBe('ok');
  });

  it('keeps at most eight answers, so the cache cannot grow with the data dir', () => {
    const fixture = framed();
    fixture.db.pragma('wal_checkpoint(TRUNCATE)');
    const backups = join(fixture.dataDir, 'backups');
    mkdirSync(backups);
    const dumps = Array.from({ length: 9 }, (_unused, index) =>
      join(backups, `pre-v22-2026102${String(index + 1)}T000000Z.db`),
    );
    for (const dump of dumps) copyFileSync(join(fixture.dataDir, 'book.db'), dump);
    const counter = countingOpen();

    // Each dump becomes the newest in turn, so every call adds a fresh key.
    for (const [index, dump] of dumps.entries()) {
      const when = new Date(Date.now() + index * 1_000);
      utimesSync(dump, when, when);
      inspectDumps(fixture.dataDir, { DatabaseImpl: counter.impl });
    }
    expect(counter.opens()).toBe(9);

    // The first key was evicted by the ninth insert: touching that dump is a miss again.
    const [firstDump] = dumps;
    if (firstDump === undefined) throw new Error('no dump');
    utimesSync(firstDump, new Date(), new Date(Date.now() + 60_000));
    inspectDumps(fixture.dataDir, { DatabaseImpl: counter.impl });
    expect(counter.opens()).toBe(10);
  });
});

describe('inspectDataDir', () => {
  it('passes the clean allow-list set and names the three forbidden paths when they exist', () => {
    const dir = tempDir('data-dir-');
    for (const name of [
      'book.db',
      'book.db-wal',
      'book.db-shm',
      'book-before-20261001T000000Z.db',
      'book-reset-20261028T120000Z.db',
      'cover.jpg',
      '.book-volume',
    ]) {
      writeFileSync(join(dir, name), name === '.book-volume' ? 'book-volume 1\nschema=28\n' : '');
    }
    for (const name of ['backups', 'archive', 'versions', 'index', 'exchange', 'backup']) {
      mkdirSync(join(dir, name));
    }
    writeFileSync(join(dir, 'admin.token'), 'admin-secret-value');
    writeFileSync(join(dir, 'engine.token'), 'engine-secret-value');
    mkdirSync(join(dir, 'writer', 'pre'), { recursive: true });
    writeFileSync(join(dir, 'writer', 'state.json'), '{}');

    const report = inspectDataDir(dir);
    expect(report.path).toBe(dir);
    expect(report.entries).toEqual([...report.entries].sort());
    expect(report.entries).toContain('writer');
    expect(report.denied).toEqual(['writer/state.json', 'writer/pre']);
    expect(report.stray).toEqual([]);
    expect(report.tokens).toEqual({ admin: true, engine: true });
    expect(report.error).toBeNull();
    // Names, never values.
    const printed = JSON.stringify(report);
    expect(printed).not.toContain('admin-secret-value');
    expect(printed).not.toContain('engine-secret-value');
  });

  it('accepts the live legacy marker (`28\\n`) and refuses one whose content is not a marker', () => {
    const dir = tempDir('data-dir-marker-');
    writeFileSync(join(dir, 'book.db'), '');
    const marker = join(dir, '.book-volume');
    writeFileSync(marker, '28\n');
    expect(inspectDataDir(dir).stray).toEqual([]);

    writeFileSync(marker, 'hello\n');
    const report = inspectDataDir(dir);
    // The defect this fix removes: the doctor used to name the volume's own marker a stray.
    expect(report.stray).toEqual([marker]);
    expect(report.entries).toContain('.book-volume');
  });

  it('refuses a directory named `.book-volume`', () => {
    const dir = tempDir('data-dir-marker-dir-');
    mkdirSync(join(dir, '.book-volume'));
    expect(inspectDataDir(dir).stray).toEqual([join(dir, '.book-volume')]);
  });

  it('does not report a dump’s own `-wal`/`-shm` as a stray (BOOK-217)', () => {
    const dir = tempDir('data-dir-sidecar-');
    const dump = 'book-before-ch65-drop-20261028T183821Z.db';
    for (const name of ['book.db', dump, `${dump}-wal`, `${dump}-shm`]) {
      writeFileSync(join(dir, name), '');
    }
    // The doctor and the deploy gate share one classifier: the sidecars the incident's home gate
    // refused are the dump's own files here too.
    const report = inspectDataDir(dir);
    expect(report.entries).toEqual([dump, `${dump}-shm`, `${dump}-wal`, 'book.db']);
    expect(report.stray).toEqual([]);
  });

  it('still reports a `-wal` whose base is not allow-listed', () => {
    const dir = tempDir('data-dir-sidecar-stray-');
    writeFileSync(join(dir, 'book.db'), '');
    writeFileSync(join(dir, 'notes.db-wal'), '');
    expect(inspectDataDir(dir).stray).toEqual([join(dir, 'notes.db-wal')]);
  });

  it('reports an extra top-level entry as stray by its absolute path, and keeps the tokens booleans', () => {
    const dir = tempDir('data-dir-stray-');
    writeFileSync(join(dir, 'book.db'), '');
    writeFileSync(join(dir, 'notes.txt'), 'prose that does not belong here');
    mkdirSync(join(dir, 'backups'));

    const report = inspectDataDir(dir);
    expect(report.stray).toEqual([join(dir, 'notes.txt')]);
    expect(report.denied).toEqual([]);
    expect(report.tokens).toEqual({ admin: false, engine: false });
    expect(JSON.stringify(report)).not.toContain('prose that does not belong here');
  });

  it('reports an empty writer/ as denied — the same fact the deploy guard states', () => {
    const dir = tempDir('data-dir-writer-');
    writeFileSync(join(dir, 'book.db'), '');
    mkdirSync(join(dir, 'writer'));
    // No denied path is there, but `writer/` itself is a leftover: `writer/` with nothing in it
    // was `data dir clean` here while `bin/home-check.mjs` refused it (BOOK-187 review).
    expect(inspectDataDir(dir).stray).toEqual([]);
    expect(inspectDataDir(dir).denied).toEqual(['writer']);
  });

  it('never reports writer/ as a stray, and names the paths it holds when they exist', () => {
    const dir = tempDir('data-dir-writer-files-');
    mkdirSync(join(dir, 'writer'));
    writeFileSync(join(dir, 'writer', 'draft.md'), 'prose');
    expect(inspectDataDir(dir).stray).toEqual([]);
    expect(inspectDataDir(dir).denied).toEqual(['writer']);

    writeFileSync(join(dir, 'writer', 'state.json'), '{}');
    expect(inspectDataDir(dir).denied).toEqual(['writer/state.json']);
  });

  it('reports a data dir it cannot list as an error instead of throwing', () => {
    const missing = join(tempDir('data-dir-missing-'), 'no-such-dir');
    expect(() => inspectDataDir(missing)).not.toThrow();
    const report = inspectDataDir(missing);
    expect(report.error).toBe('ENOENT');
    expect(report.path).toBe(missing);
    expect(report.entries).toEqual([]);
    expect(report.denied).toEqual([]);
    expect(report.stray).toEqual([]);
    expect(report.tokens).toEqual({ admin: false, engine: false });
  });

  it('reports a file where the data dir should be as an error too', () => {
    const dir = tempDir('data-dir-file-');
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'this is a file');
    expect(inspectDataDir(asFile).error).toBe('ENOTDIR');
  });
});

describe('inspectGraph', () => {
  it('is shipped on this schema, with an empty graph and no closure to time', () => {
    const fixture = framed();
    // BOOK-185 stage 3 (v29): the edge table is in this image, so the answer is «shipped» even
    // on a volume whose graph has not been built yet — the CLI then reports the counts as zero.
    expect(inspectGraph(fixture.db)).toEqual({ shipped: true, facts: 0, threads: 0, edges: 0, closureMs: null });
  });

  it('counts facts, threads and edges and times the closure once stage 3 is in the image', () => {
    const dir = tempDir('graph-');
    const db = scratchDb(dir);
    db.exec(`
      CREATE TABLE facts (id TEXT PRIMARY KEY, chapter INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, chapter INTEGER NOT NULL);
      CREATE TABLE fact_dependency ("from" TEXT NOT NULL, "to" TEXT NOT NULL, chapter INTEGER, kind TEXT);
    `);
    db.prepare('INSERT INTO facts (id, chapter) VALUES (?, ?)').run('fct_one', 3);
    db.prepare('INSERT INTO threads (id, chapter) VALUES (?, ?)').run('thr_one', 3);
    const edge = db.prepare('INSERT INTO fact_dependency ("from", "to", chapter, kind) VALUES (?, ?, ?, ?)');
    edge.run('fct_one', 'fct_two', 3, 'supports');
    edge.run('fct_two', 'fct_three', 4, 'supports');

    const graph = inspectGraph(db);
    expect(graph.shipped).toBe(true);
    if (!graph.shipped) throw new Error('unreachable');
    expect(graph.facts).toBe(1);
    expect(graph.threads).toBe(1);
    expect(graph.edges).toBe(2);
    expect(typeof graph.closureMs).toBe('number');
    expect(graph.closureMs).toBeGreaterThanOrEqual(0);
  });

  it('reports shipped with an empty edge table and no closure to time', () => {
    const dir = tempDir('graph-empty-');
    const db = scratchDb(dir);
    db.exec('CREATE TABLE fact_dependency ("from" TEXT NOT NULL, "to" TEXT NOT NULL, chapter INTEGER, kind TEXT)');
    expect(inspectGraph(db)).toEqual({ shipped: true, facts: 0, threads: 0, edges: 0, closureMs: null });
  });

  it('reports an edge table without both from and to as not shipped', () => {
    const dir = tempDir('graph-shape-');
    const db = scratchDb(dir);
    db.exec('CREATE TABLE fact_dependency ("from" TEXT NOT NULL, chapter INTEGER, kind TEXT)');
    expect(inspectGraph(db)).toEqual({ shipped: false });
  });
});
