import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { migrateV26 } from '../src/db/migrateV26.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

/**
 * v26 — the three push tables (BOOK-189).
 *
 * The upgrade path that matters: an install that has been running on v25 (the sentence,
 * ADR-044) must gain exactly the tables a fresh install is created with, and running the step
 * again must not fail. The constraints are asserted from `sqlite_master` because they are the
 * promise — one claim per reader and chapter, one row per endpoint, one outbox entry per claim —
 * and a promise that lives only in a test is not one.
 */

function tableExists(db: Db, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function tableSql(db: Db, name: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as
    | { sql: string }
    | undefined;
  return row?.sql ?? '';
}

function indexes(db: Db, table: string): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'`).all(table) as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

/** The shape an upgrade actually finds now: a v25 book with no push tables at all. */
function shapeAsV25(db: Db): void {
  for (const table of ['push_outbox', 'push_log', 'push_subscriptions']) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.pragma('user_version = 25');
}

describe('migration v26 — the push tables', () => {
  it('creates all three on a fresh install', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(27);

    for (const table of ['push_subscriptions', 'push_log', 'push_outbox']) {
      expect(tableExists(db, table), table).toBe(true);
    }
    // The claim is the primary key, not a check two writers share.
    expect(tableSql(db, 'push_log')).toContain('PRIMARY KEY (identity_id, chapter)');
    expect(tableSql(db, 'push_log')).toContain(`CHECK (kind IN ('landed','decision'))`);
    // The outbox repeats the claim as a constraint, so a duplicate row cannot be inserted.
    expect(tableSql(db, 'push_outbox')).toContain('UNIQUE (identity_id, chapter)');
    // The endpoint is a capability: re-subscribing the same device is an update, not a second row.
    expect(tableSql(db, 'push_subscriptions')).toContain('endpoint    TEXT NOT NULL UNIQUE');
    expect(indexes(db, 'push_subscriptions')).toContain('push_subscriptions_identity');
    expect(indexes(db, 'push_log')).toContain('push_log_identity');
    expect(indexes(db, 'push_outbox')).toContain('push_outbox_due');
    // ADR-044's sentence tables are still there: this step adds, it never rebuilds.
    expect(tableExists(db, 'sentences')).toBe(true);
    db.close();
  });

  it('adds the tables to a book that predates them', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    shapeAsV25(db);
    expect(tableExists(db, 'push_subscriptions')).toBe(false);

    expect(migrate(db)).toEqual({ from: 25, to: SCHEMA_VERSION });
    for (const table of ['push_subscriptions', 'push_log', 'push_outbox']) {
      expect(tableExists(db, table), table).toBe(true);
    }
    db.close();
  });

  it('is idempotent: a second step leaves the tables and their rows alone', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idt_v26', 'sub-v26', 'Аня', '2026-10-27T12:00:00Z', '2026-10-27T12:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO push_subscriptions (id, identity_id, endpoint, p256dh, auth, created_at)
       VALUES ('psh_v26', 'idt_v26', 'https://push.example.com/x', 'a', 'b', '2026-10-27T12:00:00Z')`,
    ).run();

    migrateV26(db);
    migrateV26(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 1 });
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('repairs a partial run: the indexes are created even when the tables already are', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // The shape an interrupted first run leaves: tables, no indexes.
    for (const name of ['push_subscriptions_identity', 'push_log_identity', 'push_outbox_due']) {
      db.exec(`DROP INDEX ${name}`);
    }
    expect(indexes(db, 'push_outbox')).not.toContain('push_outbox_due');

    migrateV26(db);
    expect(indexes(db, 'push_subscriptions')).toContain('push_subscriptions_identity');
    expect(indexes(db, 'push_log')).toContain('push_log_identity');
    expect(indexes(db, 'push_outbox')).toContain('push_outbox_due');
    // And a third run is still a no-op rather than an error.
    migrateV26(db);
    db.close();
  });

  it('refuses a second notification for one reader and chapter, and a second row for one endpoint', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idt_two', 'sub-two', 'Аня', '2026-10-27T12:00:00Z', '2026-10-27T12:00:00Z')`,
    ).run();
    const claim = db.prepare(`INSERT INTO push_log (identity_id, chapter, kind, at) VALUES (?, ?, ?, ?)`);
    claim.run('idt_two', 20, 'landed', '2026-10-27T12:00:00Z');
    expect(() => claim.run('idt_two', 20, 'decision', '2026-10-27T12:05:00Z')).toThrow();

    const device = db.prepare(
      `INSERT INTO push_subscriptions (id, identity_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    device.run('psh_a', 'idt_two', 'https://push.example.com/x', 'a', 'b', '2026-10-27T12:00:00Z');
    expect(() => device.run('psh_b', 'idt_two', 'https://push.example.com/x', 'c', 'd', '2026-10-27T12:01:00Z')).toThrow();
    // A kind outside the vocabulary is refused by the database itself.
    expect(() => claim.run('idt_two', 21, 'other', '2026-10-27T12:00:00Z')).toThrow();
    db.close();
  });
});
