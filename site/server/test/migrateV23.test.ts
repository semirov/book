import { describe, expect, it } from 'vitest';

import { getMeta, setMeta } from '../src/db/repo/meta.ts';
import { openDatabase, type Db } from '../src/db/db.ts';
import { AUTHOR_MARKER_KEY, backfillAuthorMarker } from '../src/db/migrateV23.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

/**
 * v23 — the author marker (owner, 2026-10-28).
 *
 * `identities.is_author` says which reader *is* the imprint's author, so the byline stops
 * counting the owner as his own reader («Филипп Семиров + 1», the 1 being him). The column is
 * added by migration; the one-time backfill is recorded in `meta` and never guesses between
 * several identities — a fresh book is marked by the operator through the admin route.
 */

function columns(db: Db, table: string): Array<{ name: string; notnull: number; dflt_value: string | null }> {
  return db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number; dflt_value: string | null }>;
}

function identity(db: Db, id: string, name: string): void {
  db.prepare(
    `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
     VALUES (?, ?, ?, '2026-10-20T09:00:00Z', '2026-10-25T08:00:00Z')`,
  ).run(id, `sub-${id}`, name);
}

function marked(db: Db): string[] {
  return (db.prepare('SELECT id FROM identities WHERE is_author = 1 ORDER BY id').all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

/** Shape a v23 database as the v22 one an upgrade actually finds: no column, no decision. */
function shapeAsV22(db: Db): void {
  db.exec('ALTER TABLE identities DROP COLUMN is_author');
  db.prepare('DELETE FROM meta WHERE k = ?').run(AUTHOR_MARKER_KEY);
  db.pragma('user_version = 22');
}

/** Shape the same, but as if the column had been added and the backfill had not run yet. */
function shapeAsV22ColumnOnly(db: Db): void {
  db.prepare('DELETE FROM meta WHERE k = ?').run(AUTHOR_MARKER_KEY);
  db.pragma('user_version = 22');
}

describe('migration v23 — the author marker', () => {
  it('adds the column to a fresh install, unmarked, and records that the book has no author yet', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(34);
    const column = columns(db, 'identities').find((entry) => entry.name === 'is_author');
    expect(column).toMatchObject({ notnull: 1, dflt_value: '0' });
    // Zero identities: nobody is guessed into the role, and the decision is on the record.
    expect(getMeta(db, AUTHOR_MARKER_KEY)).toBe('none:empty');

    // A reader who arrives after the migration is a reader, not the author.
    identity(db, 'idt_later', 'Филипп Семиров');
    expect(marked(db)).toEqual([]);
    db.close();
  });

  it('marks the only identity of a v22 book and records which one', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    shapeAsV22(db);
    identity(db, 'idt_only', 'Филипп Семиров');

    expect(migrate(db)).toEqual({ from: 22, to: SCHEMA_VERSION });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect(marked(db)).toEqual(['idt_only']);
    expect(getMeta(db, AUTHOR_MARKER_KEY)).toBe('single:idt_only');

    // A second boot does nothing at all: no re-guess, no rewritten decision.
    db.prepare('UPDATE identities SET is_author = 0 WHERE id = ?').run('idt_only');
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(marked(db)).toEqual([]);
    expect(getMeta(db, AUTHOR_MARKER_KEY)).toBe('single:idt_only');
    // Even the step itself, run by hand, does not re-mark: the `meta` decision is the guard.
    backfillAuthorMarker(db);
    expect(marked(db)).toEqual([]);
    db.close();
  });

  it('never guesses between several identities: it records the count and marks nobody', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    shapeAsV22(db);
    identity(db, 'idt_one', 'Филипп Семиров');
    identity(db, 'idt_two', 'Аня');

    expect(migrate(db)).toEqual({ from: 22, to: SCHEMA_VERSION });
    expect(marked(db)).toEqual([]);
    expect(getMeta(db, AUTHOR_MARKER_KEY)).toBe('none:multiple:2');
    db.close();
  });

  it('keeps a marker an install already carries, and changes nothing', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    identity(db, 'idt_one', 'Филипп Семиров');
    identity(db, 'idt_two', 'Аня');
    db.prepare('UPDATE identities SET is_author = 1 WHERE id = ?').run('idt_two');
    shapeAsV22ColumnOnly(db);

    expect(migrate(db)).toEqual({ from: 22, to: SCHEMA_VERSION });
    expect(marked(db)).toEqual(['idt_two']);
    expect(getMeta(db, AUTHOR_MARKER_KEY)).toBe('existing');
    db.close();
  });

  it('does not overwrite a decision that is already recorded', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    identity(db, 'idt_only', 'Филипп Семиров');
    shapeAsV22ColumnOnly(db);
    // An operator decision already on record — e.g. «several readers, no author» — stands.
    setMeta(db, AUTHOR_MARKER_KEY, 'none:multiple:3');

    expect(migrate(db)).toEqual({ from: 22, to: SCHEMA_VERSION });
    expect(marked(db)).toEqual([]);
    expect(getMeta(db, AUTHOR_MARKER_KEY)).toBe('none:multiple:3');
    db.close();
  });
});
