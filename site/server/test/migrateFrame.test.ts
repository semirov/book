import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

/**
 * BOOK-137 — schema v16: the frame mark on the filing and on the change, and the paperwork
 * mode on the change. The step is additive and idempotent, and the CHECK travels with the
 * ADD COLUMN, so a migrated install has the fresh one's shape. Rows written before it keep
 * their history and carry no mark — null is the honest answer, and the decision re-derives it.
 */

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function tableSql(db: Db, table: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
    | { sql: string }
    | undefined;
  return row?.sql ?? '';
}

describe('migrate — BOOK-137 (v16)', () => {
  it('adds the BOOK-137 frame columns to a v13 install, once, keeping rows', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.exec(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_14', 'yandex-14', 'Аня', '2026-10-25T11:00:00Z', '2026-10-25T11:00:00Z')`,
    );
    db.exec(
      `INSERT INTO comments (id, identity_id, chapter, block_id, quote, author, body, body_sha, ip_hash,
                             status, created_at)
       VALUES ('cmt_v13', 'idn_14', 1, 'ch01#frame', 'Я вошёл в пустую комнату.', 'Аня', 'К первой фразе.',
               'a', 'f', 'new', '2026-10-25T12:00:00Z')`,
    );
    db.exec(
      `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, status,
                            outcome, enqueued_at)
       VALUES ('chg_v13', 'accepted_comment', 8, 'замер', 1, 'sha', '[]', 'phrase', 'done', 'applied',
               '2026-10-25T12:00:00Z')`,
    );
    // Shape a v13 install: the frame was not a stored fact before BOOK-137.
    db.exec('ALTER TABLE comments DROP COLUMN frame');
    db.exec('ALTER TABLE changes DROP COLUMN frame');
    db.exec('ALTER TABLE changes DROP COLUMN frame_mode');
    db.pragma('user_version = 13');

    // BOOK-113 (v14) and BOOK-61 (v15) land on the way; this step is the head one.
    expect(migrate(db)).toEqual({ from: 13, to: SCHEMA_VERSION });
    expect(columns(db, 'comments')).toContain('frame');
    expect(columns(db, 'changes')).toEqual(expect.arrayContaining(['frame', 'frame_mode']));
    // The CHECK travels with the ADD COLUMN, so a migrated install is the fresh one's shape.
    expect(tableSql(db, 'comments')).toContain(`CHECK (frame IN ('touched','adjacent','untouched'))`);
    expect(tableSql(db, 'changes')).toContain(`CHECK (frame IN ('touched','adjacent','untouched'))`);
    expect(tableSql(db, 'changes')).toContain(`CHECK (frame_mode IN ('оформление','поправка','расхождение'))`);
    // An old row keeps its history and carries no mark: null is the honest answer for it.
    expect(db.prepare('SELECT frame FROM comments WHERE id = ?').get('cmt_v13')).toEqual({ frame: null });
    expect(db.prepare('SELECT frame, frame_mode, outcome FROM changes WHERE id = ?').get('chg_v13')).toEqual({
      frame: null,
      frame_mode: null,
      outcome: 'applied',
    });
    expect(() =>
      db.prepare(`UPDATE changes SET frame = 'changed' WHERE id = 'chg_v13'`).run(),
    ).toThrow(/CHECK constraint failed/u);
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });
});
