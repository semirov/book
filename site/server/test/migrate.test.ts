import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { ensureStepLifecycle, migrate } from '../src/db/migrate.ts';
import { REQUIRED_TABLES, REQUIRED_TRIGGERS, SCHEMA_VERSION, CHAPTERS_COLUMNS, EVENTS_TABLE_SQL } from '../src/db/schema.ts';
import { sha256Hex } from '../src/util/hash.ts';

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

describe('migrate — schema v16', () => {
  it('creates every table of revision 4 and no retired one', () => {
    const db = openDatabase(':memory:');
    const result = migrate(db);
    expect(result).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(16);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);

    const present = tables(db);
    for (const table of REQUIRED_TABLES) expect(present).toContain(table);
    expect(present).not.toContain('obligations');
    expect(present).not.toContain('cascade_stages');
    expect(triggers(db).sort()).toEqual([...REQUIRED_TRIGGERS].sort());
    expect(db.prepare('SELECT COUNT(*) AS n FROM lane').get()).toEqual({ n: 1 });
    // BOOK-6: a slot may hold only its basis sentence, which is not a written chapter.
    expect(columns(db, 'chapters')).toContain('basis');
    // BOOK-7: page 2 has its own hash, so an owner edit is a first-class basis.
    expect(columns(db, 'front_matter')).toContain('about_sha256');
    // BOOK-9: the auditor's verdict, written once before triage.
    expect(columns(db, 'comments')).toEqual(
      expect.arrayContaining(['audit_verdict', 'audit_reason', 'audited_at', 'audited_by']),
    );
    expect(tableSql(db, 'comments')).toContain(`CHECK (audit_verdict IN ('FITS','OFF'))`);
    // BOOK-137: the frame mark on the filing and on the change, and the paperwork mode.
    expect(columns(db, 'comments')).toContain('frame');
    expect(columns(db, 'changes')).toEqual(expect.arrayContaining(['frame', 'frame_mode']));
    expect(tableSql(db, 'comments')).toContain(`CHECK (frame IN ('touched','adjacent','untouched'))`);
    expect(tableSql(db, 'changes')).toContain(`CHECK (frame_mode IN ('оформление','поправка','расхождение'))`);
    // BOOK-7: an intervention on an empty chapter is that chapter's premise.
    expect(columns(db, 'changes')).toContain('premise');
    expect(columns(db, 'steps')).toContain('premise_change');
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'changes_premise_pending'`).get(),
    ).toEqual({ name: 'changes_premise_pending' });
    // BOOK-16: the intervention's kind, on the comment and on the change it becomes.
    expect(columns(db, 'comments')).toContain('intervention_kind');
    expect(columns(db, 'changes')).toContain('intervention_kind');
    expect(tableSql(db, 'comments')).toContain(
      `CHECK (intervention_kind IN ('document','decision','testimony','erasure'))`,
    );
    expect(tableSql(db, 'changes')).toContain(
      `CHECK (intervention_kind IN ('document','decision','testimony','erasure'))`,
    );
    // BOOK-113: the operator's edit exemption, off for every reader until a route turns it on.
    expect(columns(db, 'identities')).toContain('edit_exempt');
    db.close();
  });

  it('is idempotent: a second run changes nothing and keeps the data', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
       VALUES (1, 1, 'Тестовая глава', 'abc', 10, 1, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
    ).run();

    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(db.prepare('SELECT title FROM chapters WHERE n = 1').get()).toEqual({ title: 'Тестовая глава' });
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
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
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
       VALUES (1, 2, 'Тестовая глава', 'abc', 10, 1, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
    );
    // A paragraph that references the rebuilt table by name: the swap must not orphan it.
    db.exec(
      `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev)
       VALUES ('ch01#aaaaaaaa', 1, 0, 'Тестовый абзац.', 'aaaaaaaa', 1, 2)`,
    );
    db.pragma('user_version = 6');

    expect(migrate(db)).toEqual({ from: 6, to: SCHEMA_VERSION });
    expect(columns(db, 'chapters')).toEqual([...CHAPTERS_COLUMNS]);
    // A pre-BOOK-6 row is a written chapter, not a basis slot.
    expect(db.prepare('SELECT basis, title FROM chapters WHERE n = 1').get()).toEqual({
      basis: 0,
      title: 'Тестовая глава',
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

  it('adds the BOOK-7 page-2 hash to a v7 install, once, backfilling the text that stands', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v7 database: page 2 had no hash of its own before BOOK-7.
    db.exec('ALTER TABLE front_matter DROP COLUMN about_sha256');
    db.prepare(
      `INSERT INTO front_matter (id, title, about, rev, sha256, updated_at)
       VALUES (1, 'Без названия', 'Тестовая аннотация.', 1, 'file-sha', '2026-10-25T09:00:00Z')`,
    ).run();
    db.pragma('user_version = 7');

    expect(migrate(db)).toEqual({ from: 7, to: SCHEMA_VERSION });
    expect(columns(db, 'front_matter')).toContain('about_sha256');
    expect(db.prepare('SELECT about, about_sha256 FROM front_matter WHERE id = 1').get()).toEqual({
      about: 'Тестовая аннотация.',
      about_sha256: sha256Hex('Тестовая аннотация.'),
    });
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('adds the BOOK-9 auditor columns to a v8 install, once', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v8 database: a comment carried no audit before BOOK-9.
    db.exec('ALTER TABLE comments DROP COLUMN audit_verdict');
    db.exec('ALTER TABLE comments DROP COLUMN audit_reason');
    db.exec('ALTER TABLE comments DROP COLUMN audited_at');
    db.exec('ALTER TABLE comments DROP COLUMN audited_by');
    db.pragma('user_version = 8');

    expect(migrate(db)).toEqual({ from: 8, to: SCHEMA_VERSION });
    expect(columns(db, 'comments')).toEqual(
      expect.arrayContaining(['audit_verdict', 'audit_reason', 'audited_at', 'audited_by']),
    );
    // A migrated install has the fresh table's shape, constraint included.
    expect(tableSql(db, 'comments')).toContain(`CHECK (audit_verdict IN ('FITS','OFF'))`);
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('adds the BOOK-16 intervention kind to a v9 install, once, keeping an old row', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v9 database: neither a comment nor a change carried a kind before BOOK-16.
    db.exec('ALTER TABLE comments DROP COLUMN intervention_kind');
    db.exec('ALTER TABLE changes DROP COLUMN intervention_kind');
    db.exec(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_1', 'yandex-1', 'Аня', '2026-10-25T11:00:00Z', '2026-10-25T11:00:00Z')`,
    );
    db.exec(
      `INSERT INTO comments (id, identity_id, chapter, author, body, proposed_text, body_sha, ip_hash,
                             status, created_at)
       VALUES ('cmt_old', 'idn_1', 8, 'Аня', 'Старое замечание.', 'Старая правка.', 'a', 'f', 'new',
               '2026-10-25T12:00:00Z')`,
    );
    db.pragma('user_version = 9');

    expect(migrate(db)).toEqual({ from: 9, to: SCHEMA_VERSION });
    expect(columns(db, 'comments')).toContain('intervention_kind');
    expect(columns(db, 'changes')).toContain('intervention_kind');
    // An old intervention keeps its history and simply has no kind — null is valid for it.
    expect(db.prepare('SELECT intervention_kind, proposed_text FROM comments WHERE id = ?').get('cmt_old')).toEqual({
      intervention_kind: null,
      proposed_text: 'Старая правка.',
    });
    expect(tableSql(db, 'comments')).toContain(
      `CHECK (intervention_kind IN ('document','decision','testimony','erasure'))`,
    );
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('adds the BOOK-7 premise columns to a v10 install, once, keeping rows', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v10 database: neither a change nor a step knew about a chapter premise.
    db.exec('DROP INDEX IF EXISTS changes_premise_pending');
    db.exec('ALTER TABLE changes DROP COLUMN premise');
    db.exec('ALTER TABLE steps DROP COLUMN premise_change');
    db.exec(
      `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, status, enqueued_at)
       VALUES ('chg_old', 'operator', 8, 'старое замечание', 1, 'sha', '[]', 'phrase', 'pending', '2026-10-25T12:00:00Z')`,
    );
    db.pragma('user_version = 10');

    expect(migrate(db)).toEqual({ from: 10, to: SCHEMA_VERSION });
    expect(columns(db, 'changes')).toContain('premise');
    expect(columns(db, 'steps')).toContain('premise_change');
    // An old change is an ordinary change, not a premise, and its row survives.
    expect(db.prepare('SELECT intent, premise FROM changes WHERE id = ?').get('chg_old')).toEqual({
      intent: 'старое замечание',
      premise: 0,
    });
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'changes_premise_pending'`).get(),
    ).toEqual({ name: 'changes_premise_pending' });
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('widens the events vocabulary to document.status on a v11 install, keeping rows (BOOK-18)', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v11 log: the old inline CHECK, its indexes and both append-only triggers.
    db.prepare(
      `INSERT INTO events (at, kind, author_kind, author_label, payload)
       VALUES ('2026-10-25T09:00:00Z', 'change.decided', 'writer', 'автор', '{}')`,
    ).run();
    const oldSql = EVENTS_TABLE_SQL.replace(",\n                 'document.status'", '');
    expect(oldSql).not.toContain('document.status');
    db.exec('DROP TRIGGER events_no_update');
    db.exec('DROP TRIGGER events_no_delete');
    db.exec('DROP INDEX events_chapter');
    db.exec('DROP INDEX events_change');
    db.exec('DROP INDEX events_kind');
    db.exec('DROP INDEX events_at');
    db.exec('ALTER TABLE events RENAME TO events_v12');
    db.exec(oldSql);
    db.exec(
      `INSERT INTO events (hseq, at, kind, chapter, is_front, rev, change_id, cascade_id, step_id,
         author_kind, identity_id, author_label, payload, prev_hseq)
       SELECT hseq, at, kind, chapter, is_front, rev, change_id, cascade_id, step_id,
         author_kind, identity_id, author_label, payload, prev_hseq FROM events_v12`,
    );
    db.exec('DROP TABLE events_v12');
    db.pragma('user_version = 11');

    expect(migrate(db)).toEqual({ from: 11, to: SCHEMA_VERSION });
    // The row survives the rebuild, the triggers and indexes are back, and the new kind lands.
    expect(db.prepare(`SELECT kind FROM events`).all()).toEqual([{ kind: 'change.decided' }]);
    expect(triggers(db).sort()).toEqual([...REQUIRED_TRIGGERS].sort());
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (at, kind, author_kind, author_label) VALUES ('2026-10-25T10:00:00Z', 'document.status', 'writer', 'автор')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (at, kind, author_kind, author_label) VALUES ('2026-10-25T10:00:00Z', 'document.moved', 'writer', 'автор')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed|events/u);
    expect(tableSql(db, 'events')).toContain("CHECK (kind IN");
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('refuses a second queued premise for one chapter at the database level (BOOK-7)', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const insert = db.prepare(
      `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, premise, status, enqueued_at)
       VALUES (?, 'accepted_comment', 5, 'замысел', 0, '', '[]', 'chapter', 1, ?, '2026-10-25T12:00:00Z')`,
    );
    insert.run('chg_p1', 'pending');
    // A pending second premise is the database's refusal, not only the application's check.
    expect(() => insert.run('chg_p2', 'pending')).toThrow(/changes_premise_pending|UNIQUE/u);
    // Once the first is settled, the chapter may take another; a superseded row never blocks.
    db.prepare(`UPDATE changes SET status = 'done', outcome = 'applied' WHERE id = 'chg_p1'`).run();
    expect(() => insert.run('chg_p3', 'pending')).not.toThrow();
    expect(() => insert.run('chg_p4', 'void')).not.toThrow();
    db.close();
  });

  it('adds cost_priced to a v12 install and backfills an amount that was really recorded (BOOK-23)', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const insert = db.prepare(
      `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
         status, cost_rub, enqueued_at)
       VALUES (?, 'accepted_comment', 5, 'замер', 1, 'sha', '[]', 'phrase', 'done', ?, '2026-10-25T12:00:00Z')`,
    );
    insert.run('chg_measured', 7.5);
    insert.run('chg_placeholder', 0);
    // Shape a v12 install: the marker did not exist before this step.
    for (const table of ['changes', 'steps', 'change_impact']) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN cost_priced`);
    }
    db.pragma('user_version = 12');
    expect(migrate(db)).toEqual({ from: 12, to: SCHEMA_VERSION });
    for (const table of ['changes', 'steps', 'change_impact']) {
      expect(columns(db, table)).toContain('cost_priced');
    }
    // A recorded amount keeps being a measurement; a stored zero was never a price.
    expect(db.prepare('SELECT id, cost_priced FROM changes ORDER BY id').all()).toEqual([
      { id: 'chg_measured', cost_priced: 1 },
      { id: 'chg_placeholder', cost_priced: 0 },
    ]);
    // The old database boots: migrate probes it, and the next run has nothing to do.
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('adds the BOOK-113 edit exemption to a v13 install', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idt_old', 'yandex-old', 'Аня', '2026-10-25T11:00:00Z', '2026-10-25T11:00:00Z')`,
    ).run();
    // Shape a v13 install: the flag did not exist before BOOK-113.
    db.exec('ALTER TABLE identities DROP COLUMN edit_exempt');
    db.pragma('user_version = 13');
    // BOOK-113, BOOK-61 and BOOK-137 land on the way to the head version.
    expect(migrate(db)).toEqual({ from: 13, to: SCHEMA_VERSION });
    // An existing reader is not exempt by accident: the column reads as 0.
    expect(db.prepare('SELECT edit_exempt FROM identities WHERE id = ?').get('idt_old')).toEqual({ edit_exempt: 0 });
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
