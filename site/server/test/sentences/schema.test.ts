/**
 * A migrated install and a fresh one must accept exactly the same rows (ADR-044 §2.5).
 *
 * The carrier columns are added by `ALTER TABLE`, and SQLite cannot add a foreign key that way — so
 * the fresh schema must not declare one either. This test compares the two shapes column for column
 * (name and type; order differs by construction) and checks that neither carries a foreign key on
 * `sentence_id`, which is the one decision a future reader is most likely to "fix" and break.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';

const CARRIERS = ['comments', 'facts', 'literals', 'mentions'] as const;

type ColumnInfo = { name: string; type: string; notnull: number };

function columnShape(db: Db, table: string): ColumnInfo[] {
  return (db.pragma(`table_info(${table})`) as ColumnInfo[])
    .map((column) => ({ name: column.name, type: column.type, notnull: column.notnull }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function foreignKeys(db: Db, table: string): string[] {
  return (db.pragma(`foreign_key_list(${table})`) as Array<{ from: string; table: string }>).map(
    (row) => `${row.from}→${row.table}`,
  );
}

/** The v24 shape: no sentence tables, no carrier columns. */
function shapeAsV24(db: Db): void {
  db.exec('DROP TABLE sentence_touches');
  db.exec('DROP TABLE sentences');
  for (const column of ['sel_end', 'sel_start', 'sentence_id']) db.exec(`ALTER TABLE comments DROP COLUMN ${column}`);
  for (const table of ['facts', 'literals', 'mentions']) db.exec(`ALTER TABLE ${table} DROP COLUMN sentence_id`);
  db.pragma('user_version = 24');
}

describe('v25 — fresh install equals a migrated one', () => {
  it('has the same carrier columns, types and no foreign key in either shape', () => {
    const fresh = openDatabase(':memory:');
    migrate(fresh);
    const upgraded = openDatabase(':memory:');
    migrate(upgraded);
    shapeAsV24(upgraded);
    expect(migrate(upgraded)).toEqual({ from: 24, to: SCHEMA_VERSION });

    for (const table of CARRIERS) {
      expect(columnShape(upgraded, table)).toEqual(columnShape(fresh, table));
      expect(foreignKeys(upgraded, table)).toEqual(foreignKeys(fresh, table));
      expect(foreignKeys(upgraded, table).filter((key) => key.startsWith('sentence_id'))).toEqual([]);
    }
    // `sentences` itself is the same table in both, indexes included — the partial unique index is
    // what makes «one live sentence per place» a database fact, so a lost one is a shape change.
    expect(columnShape(upgraded, 'sentences')).toEqual(columnShape(fresh, 'sentences'));
    expect(columnShape(upgraded, 'sentence_touches')).toEqual(columnShape(fresh, 'sentence_touches'));
    const indexes = (db: Db): string[] =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('sentences','sentence_touches')
                    AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes(upgraded)).toEqual(indexes(fresh));
    expect(indexes(upgraded)).toEqual([
      'sentence_touches_change',
      'sentence_touches_sentence',
      'sentences_block',
      'sentences_live_place',
    ]);
    fresh.close();
    upgraded.close();
  });
});
