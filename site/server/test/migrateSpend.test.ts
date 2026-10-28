/**
 * BOOK-117 — the money ledger's migration, on its own so `migrate.test.ts` stays under the
 * 500-line arch bound. A v14 install (the writer lane's stage store) gains `pass_spend` and
 * nothing else moves; a re-run changes nothing, and one pass can be charged only once.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

function tables(db: Db): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

describe('migrate — the money ledger (BOOK-117)', () => {
  it('adds pass_spend to a v14 install, once, with one row per pass', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v14 install: the ledger did not exist before this step.
    db.exec('DROP INDEX IF EXISTS pass_spend_day');
    db.exec('DROP TABLE pass_spend');
    db.pragma('user_version = 14');

    expect(migrate(db)).toEqual({ from: 14, to: SCHEMA_VERSION });
    expect(tables(db)).toContain('pass_spend');
    expect(columns(db, 'pass_spend')).toEqual([
      'id',
      'at',
      'day',
      'pass_id',
      'chapter',
      'pass',
      'change_id',
      'model',
      'tokens_in',
      'tokens_out',
      'usd',
      'priced',
      // BOOK-117: who ran the pass — the ledger keeps the same word the steps row does (v21).
      'provenance',
    ]);
    // The day's sum is the index's job, and a re-close cannot charge the same pass twice.
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'pass_spend_day'`).get(),
    ).toEqual({ name: 'pass_spend_day' });
    const insert = db.prepare(
      `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, model, tokens_in, tokens_out, usd, priced)
       VALUES (?, '2026-10-27', ?, 8, 'draft', 'deepseek/deepseek-v4-pro', 10, 2, 0.000011, 1)`,
    );
    insert.run('2026-10-27T09:00:00Z', 'stp_a');
    expect(() => insert.run('2026-10-27T09:00:00Z', 'stp_a')).toThrow(/UNIQUE/u);
    expect(() => insert.run('2026-10-27T09:00:00Z', 'stp_b')).not.toThrow();
    // `priced` is 0 or 1, not any integer: an honest "not measured" has one spelling.
    expect(() =>
      db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, pass, tokens_in, tokens_out, usd, priced)
           VALUES ('2026-10-27T09:00:00Z', '2026-10-27', 'stp_c', 'draft', 0, 0, 0, 2)`,
        )
        .run(),
    ).toThrow(/CHECK/u);
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('adds pass_stages to a v13 install and keeps the pass-local order unique (BOOK-117)', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Shape a v13 install: the stage store did not exist before this step.
    db.exec('DROP INDEX IF EXISTS pass_stages_chapter_seq');
    db.exec('DROP TABLE pass_stages');
    db.pragma('user_version = 13');

    expect(migrate(db)).toEqual({ from: 13, to: SCHEMA_VERSION });
    expect(tables(db)).toContain('pass_stages');
    const insert = db.prepare(
      `INSERT INTO pass_stages (pass_id, chapter, stage_seq, stage, at, actor_process, summary)
       VALUES (?, 8, ?, 'typing', '2026-10-27T09:00:00Z', 'site', 'правка на странице')`,
    );
    insert.run('stp_a', 1);
    // One pass cannot hold the same stage number twice: a retried write is not a second stage.
    expect(() => insert.run('stp_a', 1)).toThrow(/UNIQUE/u);
    expect(() => insert.run('stp_b', 1)).not.toThrow();
    db.close();
  });

});
