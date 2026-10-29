/**
 * BOOK-DOC-84 §10.8 (v35) — the ladder's columns and the widened stage vocabulary.
 *
 * The migration is a plain column addition on `steps`/`comment_attempts`, and a rebuild of
 * `pass_stages` (SQLite cannot widen an inline CHECK). The test proves both shapes: a v30 row
 * survives the rebuild, the new stages insert, and a second run is a no-op.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrateV35 } from '../../src/db/migrateV35.ts';
import { migrate } from '../../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

/** A v30-shaped `pass_stages`: the stage CHECK stopped at `refused`, and it holds one row. */
function asV30(db: Db): void {
  db.exec('DROP TABLE pass_stages');
  db.exec(`CREATE TABLE pass_stages (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_id       TEXT NOT NULL,
    chapter       INTEGER NOT NULL,
    stage_seq     INTEGER NOT NULL,
    stage         TEXT NOT NULL CHECK (stage IN ('queued','read','verdict','drafting','typing','landed','refused')),
    at            TEXT NOT NULL,
    actor_process TEXT NOT NULL,
    actor_model   TEXT,
    change_id     TEXT,
    summary       TEXT NOT NULL,
    span          TEXT,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    cost_usd      REAL,
    UNIQUE (pass_id, stage_seq)
  )`);
  db.exec('CREATE INDEX pass_stages_chapter_seq ON pass_stages(chapter, seq)');
  db.prepare(
    `INSERT INTO pass_stages (pass_id, chapter, stage_seq, stage, at, actor_process, summary)
     VALUES ('stp_old', 8, 1, 'landed', '2026-10-24T09:00:00.000Z', 'writer', 'старая строка')`,
  ).run();
  db.pragma('user_version = 30');
}

describe('migration v35 — the ladder', () => {
  it('adds the columns and rebuilds `pass_stages` with the new stages, keeping every row', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    asV30(db);

    migrateV35(db);

    expect(columns(db, 'steps')).toEqual(expect.arrayContaining(['desperate', 'widened']));
    expect(columns(db, 'comment_attempts')).toEqual(expect.arrayContaining(['widened', 'desperate']));
    expect(columns(db, 'pass_stages')).toEqual(
      expect.arrayContaining(['attempt', 'max_attempts', 'widened', 'desperate', 'gate', 'round', 'iteration', 'verdict']),
    );
    // The row survived the rebuild, with the shared columns intact.
    expect(db.prepare('SELECT pass_id, chapter, stage, summary FROM pass_stages').all()).toEqual([
      { pass_id: 'stp_old', chapter: 8, stage: 'landed', summary: 'старая строка' },
    ]);
    // The vocabulary grew: a widening inserts, an unknown stage still does not.
    db.prepare(
      `INSERT INTO pass_stages (pass_id, chapter, stage_seq, stage, at, actor_process, summary, widened)
       VALUES ('stp_old', 8, 2, 'widening', '2026-10-24T09:01:00.000Z', 'writer', 'расширение', 'wider-edit')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO pass_stages (pass_id, chapter, stage_seq, stage, at, actor_process, summary)
         VALUES ('stp_old', 8, 3, 'invented', '2026-10-24T09:02:00.000Z', 'writer', 'нет')`,
      ).run(),
    ).toThrow(/CHECK/u);
    db.close();
  });

  it('replays as a no-op on a fresh install', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const before = columns(db, 'pass_stages');
    migrateV35(db);
    expect(columns(db, 'pass_stages')).toEqual(before);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    db.close();
  });
});
