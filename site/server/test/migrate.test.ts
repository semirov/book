import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { ensureStepLifecycle, migrate } from '../src/db/migrate.ts';
import { REQUIRED_TABLES, REQUIRED_TRIGGERS, SCHEMA_VERSION, CHAPTERS_COLUMNS } from '../src/db/schema.ts';

function tables(db: Db): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function triggers(db: Db): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function tableSql(db: Db, table: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
    | { sql: string }
    | undefined;
  return row?.sql ?? '';
}

describe('migrate — schema v7', () => {
  it('creates every table of revision 4 and no retired one', () => {
    const db = openDatabase(':memory:');
    const result = migrate(db);
    expect(result).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(7);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);

    const present = tables(db);
    for (const table of REQUIRED_TABLES) expect(present).toContain(table);
    expect(present).not.toContain('obligations');
    expect(present).not.toContain('cascade_stages');
    expect(triggers(db).sort()).toEqual([...REQUIRED_TRIGGERS].sort());
    expect(db.prepare('SELECT COUNT(*) AS n FROM lane').get()).toEqual({ n: 1 });
    // BOOK-6: a slot may hold only its basis sentence, which is not a written chapter.
    expect(columns(db, 'chapters')).toContain('basis');
    db.close();
  });

  it('is idempotent: a second run changes nothing and keeps the data', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
       VALUES (1, 1, 'Половик в тамбуре', 'abc', 10, 1, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
    ).run();

    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(db.prepare('SELECT title FROM chapters WHERE n = 1').get()).toEqual({ title: 'Половик в тамбуре' });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('rebuilds a version-1 install: the projection is dropped and the retired tables go', () => {
    const db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE chapters (
        n INTEGER PRIMARY KEY,
        rev INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL,
        chars INTEGER NOT NULL,
        block_count INTEGER NOT NULL,
        written_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parse_error TEXT
      );
      CREATE TABLE obligations (id TEXT PRIMARY KEY, chapter INTEGER NOT NULL);
      CREATE TABLE cascade_stages (cascade_id TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE lane (id INTEGER PRIMARY KEY, holder TEXT, heartbeat_at TEXT);
      INSERT INTO lane (id) VALUES (1);
      INSERT INTO chapters (n, rev, sha256, chars, block_count, written_at, updated_at)
        VALUES (1, 4, 'old', 9000, 120, '2026-10-24T09:00:00Z', '2026-10-24T09:00:00Z');
    `);
    db.pragma('user_version = 1');

    expect(migrate(db)).toEqual({ from: 1, to: SCHEMA_VERSION });
    const present = tables(db);
    expect(present).not.toContain('obligations');
    expect(present).not.toContain('cascade_stages');
    expect(present).toContain('steps');
    expect(present).toContain('gate_verdicts');
    expect(present).toContain('front_matter');
    expect(present).toContain('identities');
    expect(present).toContain('sessions');
    expect(present).toContain('block_lineage');
    expect(present).toContain('block_versions');
    expect(present).toContain('contribution_history');
    expect(columns(db, 'revisions')).toContain('hseq');
    expect(columns(db, 'chapters')).toContain('title');
    // Files are the source of truth: the old projection is not carried across.
    expect(db.prepare('SELECT COUNT(*) AS n FROM chapters').get()).toEqual({ n: 0 });
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('refuses a database from a newer build', () => {
    const db = openDatabase(':memory:');
    db.pragma('user_version = 9');
    expect(() => migrate(db)).toThrow(/newer|understands/u);
    db.close();
  });

  it('adds the M6b revision clock and the block chain to a v4 install, once', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v4 database: no `hseq` on revisions and no block chain yet.
    db.exec('DROP TABLE block_versions');
    db.exec('DROP INDEX revisions_hseq');
    db.exec('ALTER TABLE revisions DROP COLUMN hseq');
    db.pragma('user_version = 4');

    expect(migrate(db)).toEqual({ from: 4, to: SCHEMA_VERSION });
    expect(columns(db, 'revisions')).toContain('hseq');
    expect(tables(db)).toContain('block_versions');
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('adds the M7 reconcile marks to a v5 install, once', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v5 database: the operator's mark on a restore did not exist before M7.
    db.exec('DROP TABLE reconciles');
    db.pragma('user_version = 5');

    expect(migrate(db)).toEqual({ from: 5, to: SCHEMA_VERSION });
    expect(tables(db)).toContain('reconciles');
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('adds the BOOK-6 basis column to a v6 install, once, keeping the projection', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v6 database: `chapters.basis` did not exist before BOOK-6.
    db.exec('ALTER TABLE chapters DROP COLUMN basis');
    db.exec(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
       VALUES (1, 2, 'Половик в тамбуре', 'abc', 10, 1, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
    );
    // A paragraph that references the rebuilt table by name: the swap must not orphan it.
    db.exec(
      `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev)
       VALUES ('ch01#aaaaaaaa', 1, 0, 'Половик намок.', 'aaaaaaaa', 1, 2)`,
    );
    db.pragma('user_version = 6');

    expect(migrate(db)).toEqual({ from: 6, to: SCHEMA_VERSION });
    expect(columns(db, 'chapters')).toEqual([...CHAPTERS_COLUMNS]);
    // A pre-BOOK-6 row is a written chapter, not a basis slot.
    expect(db.prepare('SELECT basis, title FROM chapters WHERE n = 1').get()).toEqual({
      basis: 0,
      title: 'Половик в тамбуре',
    });
    // The rebuild kept the paragraph, and its foreign key still resolves after the swap.
    expect(db.prepare('SELECT chapter FROM blocks WHERE id = ?').get('ch01#aaaaaaaa')).toEqual({ chapter: 1 });
    // SQLite cannot add a CHECK with ALTER, so v7 rebuilds the table: a migrated install has
    // the same shape as a fresh one, including the constraint.
    expect(tableSql(db, 'chapters')).toContain('CHECK (basis IN (0,1))');
    expect(() =>
      db
        .prepare(
          `INSERT INTO chapters (n, rev, sha256, chars, block_count, basis, written_at, updated_at)
           VALUES (2, 1, 'x', 0, 1, 2, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/u);
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('adds the M5 comment columns to a v3 install, once', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v3 comments table: the two M5 columns did not exist before this milestone.
    db.exec('ALTER TABLE comments DROP COLUMN proposed_text');
    db.exec('ALTER TABLE comments DROP COLUMN base_rev');
    db.exec('ALTER TABLE comments DROP COLUMN flags');
    db.pragma('user_version = 3');

    expect(migrate(db)).toEqual({ from: 3, to: SCHEMA_VERSION });
    const cols = columns(db, 'comments');
    expect(cols).toEqual(expect.arrayContaining(['proposed_text', 'base_rev', 'flags']));
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });
});

describe('the history log is append-only (ADR-027)', () => {
  it('refuses UPDATE and DELETE on events', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO events (at, kind, author_kind, author_label)
       VALUES ('2026-10-25T09:00:00Z', 'chapter.created', 'unattributed', '')`,
    ).run();

    expect(() => db.prepare("UPDATE events SET author_label = 'x' WHERE hseq = 1").run()).toThrow(/append-only/u);
    expect(() => db.prepare('DELETE FROM events WHERE hseq = 1').run()).toThrow(/append-only/u);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    db.close();
  });
});

describe('the M3 step lifecycle repair', () => {
  it('rebuilds a pre-M3 steps table once: outcome nullable, land/cycle columns present', () => {
    const db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE steps (
        step_id TEXT PRIMARY KEY,
        cascade_id TEXT,
        seq INTEGER NOT NULL,
        wave INTEGER NOT NULL,
        lane TEXT,
        pass TEXT NOT NULL,
        chapter INTEGER,
        boundary TEXT NOT NULL,
        outcome TEXT NOT NULL,
        rev_before INTEGER, rev_after INTEGER,
        seams_in TEXT, seams_out TEXT,
        blocks_touched INTEGER, chars_delta INTEGER,
        model TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_rub REAL NOT NULL DEFAULT 0,
        hseq_from INTEGER, hseq_to INTEGER,
        lease_id TEXT, session TEXT,
        at TEXT NOT NULL, ms INTEGER, note TEXT
      );
      INSERT INTO steps (step_id, seq, wave, pass, boundary, outcome, at, note)
        VALUES ('stp_old', 0, 0, 'draft', '1', 'rewritten', '2026-10-25T09:00:00Z', 'old row');
    `);

    expect(ensureStepLifecycle(db)).toBe(true);
    const columns = db.pragma('table_info(steps)') as Array<{ name: string; notnull: number }>;
    expect(columns.find((column) => column.name === 'outcome')?.notnull).toBe(0);
    for (const name of ['cycle', 'start_sha', 'landed_at', 'landed_sha', 'pre_blocks', 'closed_at', 'last_findings']) {
      expect(columns.map((column) => column.name)).toContain(name);
    }
    // The old row survives; its note is intact.
    expect(db.prepare('SELECT note FROM steps WHERE step_id = ?').get('stp_old')).toEqual({ note: 'old row' });
    // Idempotent: the second call has nothing to do.
    expect(ensureStepLifecycle(db)).toBe(false);
    db.close();
  });
});
