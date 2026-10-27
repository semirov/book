import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

/**
 * The BOOK-61 gates in isolation — schema v15, the step after main's BOOK-113 (`v14`): Gate A's
 * hold, Gate B's verdict and the conditional `rights` role on both gate tables.
 *
 * The one thing a migration must never do is make a migrated install behave differently from
 * a fresh one, so the test builds both and compares their shapes column by column, then proves
 * the coupled CHECK refuses a mismatched pair on the migrated copy. It lives in its own file
 * because `migrate.test.ts` is at the 500-line limit — the subject is the one it grew past.
 */

describe('the BOOK-61 gates (schema v15)', () => {
  /** The v14 gate tables, verbatim enough: the roles and the two verdict enums are the point. */
  const NARROW_GATES = `
  CREATE TABLE gate_dispatches (
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('editor','consultant')),
    session TEXT NOT NULL,
    dispatched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (step_id, role)
  );
  CREATE TABLE gate_verdicts (
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('editor','consultant')),
    verdict TEXT NOT NULL CHECK (verdict IN ('HOLDS','GAP')),
    findings TEXT NOT NULL DEFAULT '[]',
    cycles INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL,
    late INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (step_id, role)
  );`;

  /** Column name, declared type, NOT NULL, default and PK position — the table's shape. */
  function shape(db: Db, table: string): string[] {
    return (db.pragma(`table_info(${table})`) as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>)
      .map((column) => `${column.name}|${column.type}|${column.notnull}|${column.dflt_value ?? ''}|${column.pk}`)
      .sort();
  }

  it('adds the hold and rights columns to a v13 install, keeps every row, and widens both gate tables', () => {
    const fresh = openDatabase(':memory:');
    migrate(fresh);

    const db = openDatabase(':memory:');
    migrate(db);
    // A step, its dispatch and the editor's verdict, all written before BOOK-61.
    db.prepare(
      `INSERT INTO steps (step_id, seq, wave, pass, boundary, at) VALUES ('stp_1', 0, 0, 'draft', '1', '2026-10-25T09:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO gate_dispatches (step_id, role, session, dispatched_at, expires_at)
       VALUES ('stp_1', 'editor', 'fwd', '2026-10-25T09:00:00Z', '2026-10-25T09:05:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO gate_verdicts (step_id, role, verdict, model, at)
       VALUES ('stp_1', 'editor', 'HOLDS', 'stub', '2026-10-25T09:04:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_1', 'yandex-1', 'Аня', '2026-10-25T11:00:00Z', '2026-10-25T11:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
       VALUES ('cmt_old', 'idn_1', 8, 'Аня', 'Старое замечание.', 'a', 'f', 'new', '2026-10-25T12:00:00Z')`,
    ).run();

    // Shape a v14 install (main's head): the narrow gate tables, no Gate A/B columns, no scan.
    db.exec('DROP TABLE gate_dispatches');
    db.exec('DROP TABLE gate_verdicts');
    db.exec(NARROW_GATES);
    db.exec(
      `INSERT INTO gate_dispatches (step_id, role, session, dispatched_at, expires_at)
       VALUES ('stp_1', 'editor', 'fwd', '2026-10-25T09:00:00Z', '2026-10-25T09:05:00Z')`,
    );
    db.exec(
      `INSERT INTO gate_verdicts (step_id, role, verdict, model, at)
       VALUES ('stp_1', 'editor', 'HOLDS', 'stub', '2026-10-25T09:04:00Z')`,
    );
    for (const column of [
      'held_rule',
      'held_by',
      'held_at',
      'rights_verdict',
      'rights_rule',
      'rights_at',
      'rights_by',
      'rights_source',
    ]) {
      db.exec(`ALTER TABLE comments DROP COLUMN ${column}`);
    }
    db.exec('ALTER TABLE steps DROP COLUMN rights_scan');
    db.pragma('user_version = 14');

    try {
      // BOOK-61 is this step; BOOK-137 (v16) lands on the way to the head version.
      expect(migrate(db)).toEqual({ from: 14, to: SCHEMA_VERSION });

      // Every row survived both rebuilds.
      expect(db.prepare('SELECT role, verdict FROM gate_verdicts').all()).toEqual([{ role: 'editor', verdict: 'HOLDS' }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM gate_dispatches').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT body FROM comments WHERE id = ?').get('cmt_old')).toEqual({
        body: 'Старое замечание.',
      });

      // A migrated install has the fresh install's shape, table for table.
      for (const table of ['comments', 'steps', 'gate_dispatches', 'gate_verdicts']) {
        expect(shape(db, table), table).toEqual(shape(fresh, table));
      }

      // Gate B is conditional: `rights` is accepted, and its verdict is coupled to the role.
      db.prepare(
        `INSERT INTO gate_dispatches (step_id, role, session, dispatched_at, expires_at)
         VALUES ('stp_1', 'rights', 'fwd', '2026-10-25T09:00:00Z', '2026-10-25T09:05:00Z')`,
      ).run();
      db.prepare(
        `INSERT INTO gate_verdicts (step_id, role, verdict, model, at)
         VALUES ('stp_1', 'rights', 'CLEAR', 'stub', '2026-10-25T09:06:00Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO gate_verdicts (step_id, role, verdict, model, at)
             VALUES ('stp_1', 'rights', 'HOLDS', 'stub', '2026-10-25T09:07:00Z')`,
          )
          .run(),
      ).toThrow(/CHECK/u);
      expect(() =>
        db
          .prepare(
            `INSERT INTO gate_verdicts (step_id, role, verdict, model, at)
             VALUES ('stp_1', 'editor', 'CLEAR', 'stub', '2026-10-25T09:07:00Z')`,
          )
          .run(),
      ).toThrow(/CHECK|UNIQUE/u);

      // The four CHECKed columns: a value outside each vocabulary is the database's refusal.
      const insertComment = db.prepare(
        `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at,
           held_by, rights_source)
         VALUES (?, 'idn_1', 8, 'Аня', 'x', 'b', 'f', 'new', '2026-10-25T12:00:00Z', ?, ?)`,
      );
      expect(() => insertComment.run('cmt_bad_1', 'robot', null)).toThrow(/CHECK/u);
      expect(() => insertComment.run('cmt_bad_2', null, 'guess')).toThrow(/CHECK/u);
      expect(() => insertComment.run('cmt_ok', 'operator', 'scan')).not.toThrow();
      // Idempotent: the second run has nothing to do.
      expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    } finally {
      db.close();
      fresh.close();
    }
  });
});
