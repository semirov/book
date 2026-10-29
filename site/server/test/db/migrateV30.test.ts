/**
 * BOOK-206 (ADR-045) — migration v30 on the schema side.
 *
 * A fresh install and a replayed step must agree: the six columns `comment_attempts` gains and
 * the `(outcome, next_at)` index are declared once, in `tables.ts`, and `migrateV30` only
 * appends what is missing. The re-open of a legacy `escalated` row is exercised end to end in
 * `server/test/filingTriage.test.ts`; here it is only the shape.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { V30_ATTEMPT_COLUMNS, migrateV30 } from '../../src/db/migrateV30.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';

function columns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

describe('migration v30 — the triage ledger', () => {
  it('a fresh install carries every v30 column, in the order the step appends them', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(SCHEMA_VERSION).toBe(31);
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
      ...V30_ATTEMPT_COLUMNS.map(([name]) => name),
    ]);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'comment_attempts_due'`).get(),
    ).toEqual({ name: 'comment_attempts_due' });
    db.close();
  });

  it('replays as a no-op on an install that already has the shape', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const before = columns(db, 'comment_attempts');
    migrateV30(db);
    expect(columns(db, 'comment_attempts')).toEqual(before);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('re-opens nothing on a book with no escalated row', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(migrateV30(db)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM comment_attempts').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'reopened'`).get()).toEqual({ n: 0 });
    db.close();
  });
});
