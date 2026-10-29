/**
 * v27 — the disposition of a filing (BOOK-174 comment #3888).
 *
 * Four columns on `comments` (how the filing was read: its carrier, its lock, what it kept) and
 * one table for the editor's check. A fresh install is created at v27 already; an upgraded one is
 * altered, and afterwards the two must be indistinguishable — column for column, CHECK for CHECK
 * — because the same questions are asked of both. A row written before this step keeps
 * `disposition IS NULL`: nobody read it this way, and nothing invents a reading after the fact.
 *
 * The anchor is **not** one of these columns: ADR-044 gave a filing its `sentence_id` in v25, and
 * a reading is recorded against that sentence rather than moving the reader's place. 27, not 24:
 * v24 is ADR-043's, and the cursor has long passed it.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { REQUIRED_TABLES, SCHEMA_VERSION } from '../src/db/schema.ts';

const AT = '2026-10-28T12:00:00Z';
/** The four columns v27 owns. `sentence_id` is ADR-044's and is asserted to stay untouched. */
const CHAIN = ['disposition', 'lock', 'carrier_kind', 'quote_kept'];
/** The tables the steps below v27 created: an upgrade must keep every one of them. */
const KEPT_TABLES = ['sentences', 'sentence_touches', 'push_subscriptions', 'push_log', 'push_outbox'];

type Column = { name: string; type: string; notnull: number; dflt_value: string | null };

function columns(db: Db, table: string): Column[] {
  return (db.pragma(`table_info(${table})`) as Column[]).map((column) => ({
    name: column.name,
    type: column.type,
    notnull: column.notnull,
    dflt_value: column.dflt_value,
  }));
}

function tableSql(db: Db, table: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
    | { sql: string }
    | undefined;
  return row?.sql ?? '';
}

function identity(db: Db): void {
  db.prepare(
    `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
     VALUES ('idt_reader', 'sub-reader', 'Аня', ?, ?)`,
  ).run(AT, AT);
}

function comment(db: Db, id: string): void {
  db.prepare(
    `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, flags, ip_hash, status, created_at, number)
     VALUES (?, 'idt_reader', 12, 'Аня', 'Служебное замечание.', ?, '[]', 'ip', 'rejected', ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
  ).run(id, `sha-${id}`, AT);
}

/** Shape a v27 database as the v26 one an upgrade actually finds: no chain, no counts table. */
function shapeAsV26(db: Db): void {
  for (const column of CHAIN) db.exec(`ALTER TABLE comments DROP COLUMN ${column}`);
  db.exec('DROP TABLE disposition_counts');
  db.pragma('user_version = 26');
}

describe('migration v27 — the disposition chain', () => {
  it('creates the four columns and the counts table on a fresh install', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(37);

    const names = columns(db, 'comments').map((column) => column.name);
    for (const column of CHAIN) expect(names).toContain(column);
    // ADR-044's anchor is here because v25 created it, not because a reading added it.
    expect(names).toContain('sentence_id');
    expect(REQUIRED_TABLES).toContain('disposition_counts');
    expect(columns(db, 'disposition_counts').map((column) => column.name)).toEqual([
      'scope',
      'key',
      'accepted',
      'in_world',
      'run',
      'at',
    ]);

    // The CHECKs travel with the columns, so a value outside the closed sets cannot be stored.
    const sql = tableSql(db, 'comments');
    expect(sql).toContain(
      `CHECK (disposition IN ('as_said','through_paper','refused_in_world','inadmissible','escalated'))`,
    );
    expect(sql).toContain(`CHECK (lock IN ('rights','harm','frame','finale'))`);
    expect(sql).toContain(
      `CHECK (carrier_kind IN ('document','speech','registry_discrepancy','numbered_object','unheeded_joke','obligatory_joke'))`,
    );
    identity(db);
    comment(db, 'cmt_check');
    expect(() => db.prepare(`UPDATE comments SET disposition = 'wide' WHERE id = 'cmt_check'`).run()).toThrow();
    expect(() => db.prepare(`UPDATE comments SET carrier_kind = 'letter' WHERE id = 'cmt_check'`).run()).toThrow();
    db.close();
  });

  it('adds them to a v26 install, keeping its sentences, push tables and rows', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    identity(db);
    comment(db, 'cmt_old');
    db.prepare(`UPDATE comments SET sentence_id = NULL WHERE id = 'cmt_old'`).run();
    shapeAsV26(db);
    expect(columns(db, 'comments').map((column) => column.name)).not.toContain('disposition');
    const before = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const table of KEPT_TABLES) expect(before.has(table), table).toBe(true);

    // BOOK-187's v28 follows, so the cursor lands on the head of the chain.
    expect(migrate(db)).toEqual({ from: 26, to: SCHEMA_VERSION });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT status, disposition, lock, carrier_kind, quote_kept FROM comments').get()).toEqual({
      status: 'rejected',
      disposition: null,
      lock: null,
      carrier_kind: null,
      quote_kept: null,
    });
    // The steps below are untouched: their tables and columns are still there.
    for (const table of KEPT_TABLES) expect(columns(db, table).length).toBeGreaterThan(0);
    expect(columns(db, 'disposition_counts').length).toBe(6);
    db.close();
  });

  it('is idempotent: a second run adds nothing and keeps a stored chain', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    identity(db);
    comment(db, 'cmt_new');
    db.prepare(
      `UPDATE comments SET disposition = 'through_paper', carrier_kind = 'document',
         quote_kept = 'срок тридцать дней' WHERE id = 'cmt_new'`,
    ).run();

    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(
      db.prepare('SELECT disposition, carrier_kind, quote_kept FROM comments WHERE id = ?').get('cmt_new'),
    ).toEqual({
      disposition: 'through_paper',
      carrier_kind: 'document',
      quote_kept: 'срок тридцать дней',
    });
    db.close();
  });

  it('leaves a migrated install equal to a fresh one, column for column', () => {
    const fresh = openDatabase(':memory:');
    migrate(fresh);
    const upgraded = openDatabase(':memory:');
    migrate(upgraded);
    shapeAsV26(upgraded);
    migrate(upgraded);

    const shapeOf = (db: Db): string[] => columns(db, 'comments').map((column) => `${column.name} ${column.type}`);
    expect(new Set(shapeOf(upgraded))).toEqual(new Set(shapeOf(fresh)));
    // And the same storage bounds: every value either install accepts, the other accepts too.
    for (const db of [fresh, upgraded]) {
      identity(db);
      comment(db, `cmt_${db === fresh ? 'fresh' : 'upgraded'}`);
      db.prepare(
        `UPDATE comments SET disposition = 'refused_in_world', quote_kept = 'не соответствует форме'`,
      ).run();
    }
    expect(
      upgraded.prepare('SELECT disposition, quote_kept FROM comments WHERE id = ?').get('cmt_upgraded'),
    ).toEqual(fresh.prepare('SELECT disposition, quote_kept FROM comments WHERE id = ?').get('cmt_fresh'));
    fresh.close();
    upgraded.close();
  });
});
