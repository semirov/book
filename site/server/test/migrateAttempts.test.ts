/**
 * BOOK-158 — the attempt ledger and the ledger's `triage` pass, on their own so
 * `migrate.test.ts` stays under the 500-line arch bound.
 *
 * Two additive facts on a v19 install: `comment_attempts` appears, and `pass_spend` gains
 * `triage` in its `pass` CHECK. SQLite cannot widen a CHECK in place, so the ledger is rebuilt
 * with its rows and index kept — and a migrated v19 must be **identical** to a fresh install,
 * table for table and index for index, or the two would answer the same question differently
 * depending on when the database was created.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

/** The v19 money ledger, before `triage` existed — the shape a real old install carries. */
const PASS_SPEND_V19 = `CREATE TABLE pass_spend (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  day        TEXT NOT NULL,
  pass_id    TEXT NOT NULL UNIQUE,
  chapter    INTEGER,
  pass       TEXT NOT NULL CHECK (pass IN ('draft','change','cascade','front','ending','sweep')),
  change_id  TEXT,
  model      TEXT,
  tokens_in  INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  usd        REAL NOT NULL,
  priced     INTEGER NOT NULL CHECK (priced IN (0,1))
)`;

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function indexes(db: Db): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

/** Every table and index, with the SQL that built it: the comparison a rebuild must survive. */
function shape(db: Db): Array<{ name: string; sql: string | null }> {
  return db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string | null }>;
}

/** Turn a migrated database into the v19 it would have been found as. */
function asV19(db: Db): void {
  db.exec('DROP INDEX IF EXISTS comment_attempts_day');
  db.exec('DROP INDEX IF EXISTS comment_attempts_comment');
  db.exec('DROP INDEX IF EXISTS comment_attempts_body');
  db.exec('DROP TABLE comment_attempts');
  db.exec('DROP INDEX IF EXISTS pass_spend_day');
  db.exec('ALTER TABLE pass_spend RENAME TO pass_spend_fresh');
  db.exec(PASS_SPEND_V19);
  db.exec(
    `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced)
     SELECT at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced FROM pass_spend_fresh`,
  );
  db.exec('DROP TABLE pass_spend_fresh');
  db.exec('CREATE INDEX pass_spend_day ON pass_spend(day)');
  db.pragma('user_version = 19');
}

describe('migrate — the attempt ledger (BOOK-158)', () => {
  it('gives a v19 install the ledger and the triage pass, and keeps its money rows', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    asV19(db);
    db.prepare(
      `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, model, tokens_in, tokens_out, usd, priced)
       VALUES ('2026-10-24T09:00:00Z', '2026-10-24', 'stp_old', 8, 'draft', NULL, 10, 2, 0.000011, 1)`,
    ).run();

    expect(migrate(db)).toEqual({ from: 19, to: SCHEMA_VERSION });
    expect(columns(db, 'comment_attempts')).toEqual([
      'id',
      'comment_id',
      'n',
      'at',
      'day',
      'body_sha',
      'anchor_sha',
      'quote',
      'outcome',
      'decided_at',
      'model',
      'tokens_in',
      'tokens_out',
      'usd',
      'priced',
      // BOOK-206 (v30): the claim, the tries, the backoff and the one stored verdict.
      'claim_by',
      'claim_until',
      'tries',
      'next_at',
      'verdict',
      'verdict_at',
    ]);
    expect(indexes(db)).toEqual(
      expect.arrayContaining(['comment_attempts_day', 'comment_attempts_comment', 'comment_attempts_body', 'comment_attempts_due']),
    );
    // The old row survived the rebuild, and the widened CHECK now takes a triage pass.
    expect(db.prepare('SELECT pass_id, usd FROM pass_spend').all()).toEqual([{ pass_id: 'stp_old', usd: 0.000011 }]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, pass, tokens_in, tokens_out, usd, priced)
           VALUES ('2026-10-25T09:00:00Z', '2026-10-25', 'triage:cmt_1:1', 'triage', 0, 0, 0, 0)`,
        )
        .run(),
    ).not.toThrow();
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('ends with the same shape as a fresh install', () => {
    const migrated = openDatabase(':memory:');
    migrate(migrated);
    asV19(migrated);
    migrate(migrated);

    const fresh = openDatabase(':memory:');
    migrate(fresh);

    expect(shape(migrated)).toEqual(shape(fresh));
    migrated.close();
    fresh.close();
  });

  it('keeps one attempt number per filing: a second submission takes the next', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idt_1', 'yandex-1', 'Аня', '2026-10-25T12:00:00Z', '2026-10-25T12:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at, number)
       VALUES ('cmt_1', 'idt_1', 8, 'Аня', 'текст', 'sha', 'a', 'new', '2026-10-25T12:00:00Z', (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO comment_attempts (comment_id, n, at, day, body_sha, anchor_sha, outcome)
       VALUES ('cmt_1', ?, '2026-10-25T12:00:00Z', '2026-10-25', 'sha', 'anchor', 'submitted')`,
    );
    insert.run(1);
    expect(() => insert.run(1)).toThrow(/UNIQUE/u);
    expect(() => insert.run(2)).not.toThrow();
    // An outcome outside the ledger's vocabulary is refused by the column, not by a reader.
    expect(() =>
      db
        .prepare(
          `INSERT INTO comment_attempts (comment_id, n, at, day, body_sha, anchor_sha, outcome)
           VALUES ('cmt_1', 3, '2026-10-25T12:00:00Z', '2026-10-25', 'sha', 'anchor', 'maybe')`,
        )
        .run(),
    ).toThrow(/CHECK/u);
    db.close();
  });
});
