/**
 * v24 — the disposition of a filing (BOOK-174 comment #3888).
 *
 * Five columns on `comments` (how the filing was read) and one table for the editor's check.
 * A fresh install is created at v24 already; an upgraded one is altered, and afterwards the two
 * must be indistinguishable — column for column, CHECK for CHECK — because the same questions
 * are asked of both. A row written before this step keeps `disposition IS NULL`: nobody read it
 * this way, and nothing invents a reading after the fact.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { REQUIRED_TABLES, SCHEMA_VERSION } from '../src/db/schema.ts';

const AT = '2026-10-28T12:00:00Z';
const CHAIN = ['disposition', 'lock', 'carrier_kind', 'quote_kept', 'sentence_id'];

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
    `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, flags, ip_hash, status, created_at)
     VALUES (?, 'idt_reader', 12, 'Аня', 'Служебное замечание.', ?, '[]', 'ip', 'rejected', ?)`,
  ).run(id, `sha-${id}`, AT);
}

/** Shape a v24 database as the v23 one an upgrade actually finds: no chain, no counts table. */
function shapeAsV23(db: Db): void {
  for (const column of CHAIN) db.exec(`ALTER TABLE comments DROP COLUMN ${column}`);
  db.exec('DROP TABLE disposition_counts');
  db.pragma('user_version = 23');
}

describe('migration v24 — the disposition chain', () => {
  it('creates the five columns and the counts table on a fresh install', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(24);

    const names = columns(db, 'comments').map((column) => column.name);
    for (const column of CHAIN) expect(names).toContain(column);
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

  it('adds them to a v23 install, keeping every row and leaving its disposition null', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    identity(db);
    comment(db, 'cmt_old');
    shapeAsV23(db);
    expect(columns(db, 'comments').map((column) => column.name)).not.toContain('disposition');

    expect(migrate(db)).toEqual({ from: 23, to: 24 });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(24);
    expect(db.prepare('SELECT status, disposition, lock, carrier_kind, quote_kept, sentence_id FROM comments').get()).toEqual({
      status: 'rejected',
      disposition: null,
      lock: null,
      carrier_kind: null,
      quote_kept: null,
      sentence_id: null,
    });
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
         quote_kept = 'срок тридцать дней', sentence_id = 'b3.s1' WHERE id = 'cmt_new'`,
    ).run();

    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(
      db.prepare('SELECT disposition, carrier_kind, quote_kept, sentence_id FROM comments WHERE id = ?').get('cmt_new'),
    ).toEqual({
      disposition: 'through_paper',
      carrier_kind: 'document',
      quote_kept: 'срок тридцать дней',
      sentence_id: 'b3.s1',
    });
    db.close();
  });

  it('leaves a migrated install equal to a fresh one, column for column', () => {
    const fresh = openDatabase(':memory:');
    migrate(fresh);
    const upgraded = openDatabase(':memory:');
    migrate(upgraded);
    shapeAsV23(upgraded);
    migrate(upgraded);

    const shapeOf = (db: Db): string[] => columns(db, 'comments').map((column) => `${column.name} ${column.type}`);
    expect(new Set(shapeOf(upgraded))).toEqual(new Set(shapeOf(fresh)));
    // And the same storage bounds: every value either install accepts, the other accepts too.
    for (const db of [fresh, upgraded]) {
      identity(db);
      comment(db, `cmt_${db === fresh ? 'fresh' : 'upgraded'}`);
      db.prepare(
        `UPDATE comments SET disposition = 'refused_in_world', quote_kept = 'не соответствует форме',
           sentence_id = 'b7.s2'`,
      ).run();
    }
    expect(upgraded.prepare('SELECT disposition, quote_kept FROM comments').get()).toEqual(
      fresh.prepare('SELECT disposition, quote_kept FROM comments').get(),
    );
    fresh.close();
    upgraded.close();
  });
});
