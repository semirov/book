/**
 * Migration v31 (BOOK-117) — the reopen's second window.
 *
 * A re-opened step is closed on the verdicts it earned, and the step wall has to know where the
 * new window starts: `steps.reopened_at`, nullable, appended last. A row written before the
 * column existed was never re-opened, so it is null — never backfilled to `at`, which would make
 * an old step look freshly opened.
 *
 * Split from `migrate.test.ts`, which is at its arch limit, the same way `migrateV26…V30` are.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { SCHEMA_VERSION, STEPS_COLUMNS } from '../../src/db/schema.ts';

function columns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

describe('migration v31 — the reopen window (BOOK-117)', () => {
  it('adds `steps.reopened_at` to a v30 install, last, and invents nothing for an old row', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // A fresh install declares the column in the order `STEPS_COLUMNS` lists it, so the repair
    // that rebuilds a pre-M3 table keeps the two shapes equal.
    expect(columns(db, 'steps')).toEqual([...STEPS_COLUMNS]);

    // Shape a v30 install: a step re-opened to be closed had no window of its own before this.
    db.exec('ALTER TABLE steps DROP COLUMN reopened_at');
    db.exec(
      `INSERT INTO steps (step_id, cascade_id, seq, wave, pass, boundary, at, note)
       VALUES ('stp_before_reopen', NULL, 0, 0, 'draft', 'front', '2026-10-29T09:10:00Z', 'opened before the window')`,
    );
    db.pragma('user_version = 30');

    expect(migrate(db)).toEqual({ from: 30, to: SCHEMA_VERSION });
    expect(columns(db, 'steps')).toEqual([...STEPS_COLUMNS]);
    // A row written before the reopen existed was never re-opened: null, never backfilled to
    // `at` — the wall keeps measuring such a step from its opening.
    expect(db.prepare('SELECT reopened_at, note FROM steps WHERE step_id = ?').get('stp_before_reopen')).toEqual({
      reopened_at: null,
      note: 'opened before the window',
    });
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });
});
