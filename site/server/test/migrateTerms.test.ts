import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

/**
 * BOOK-58 — schema v19: the four comment columns of the terms record.
 *
 * Additive and nullable: `terms_version`/`terms_sha` are what a submission accepted, and
 * `accepted_at`/`accepted_terms_version` are the moment a landed variant was entered. A row
 * written before the step keeps its history and reads null in all four — «no terms were
 * recorded», never a default. The shape is compared with a fresh install, so a migrated
 * database and a new one cannot disagree. On its own file, because `migrate.test.ts` sits at
 * the 500-line arch bound.
 */

const TERMS_COLUMNS = ['terms_version', 'terms_sha', 'accepted_at', 'accepted_terms_version'] as const;

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

/** `name:type:notnull:default:pk` — the shape a migrated install and a fresh one must share. */
function shape(db: Db): string[] {
  const rows = db.pragma('table_info(comments)') as ColumnInfo[];
  return TERMS_COLUMNS.map((name) => {
    const row = rows.find((column) => column.name === name);
    return `${row?.name}:${row?.type}:${String(row?.notnull)}:${String(row?.dflt_value)}:${String(row?.pk)}`;
  });
}

describe('migrate — the terms record (BOOK-58, v19)', () => {
  it('adds the four nullable columns to a v18 install, in the fresh install’s shape, once', () => {
    const fresh = openDatabase(':memory:');
    migrate(fresh);

    const db = openDatabase(':memory:');
    migrate(db);
    db.exec(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_v18', 'yandex-v18', 'Аня', '2026-10-27T11:00:00Z', '2026-10-27T11:00:00Z')`,
    );
    db.exec(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
       VALUES ('cmt_v18', 'idn_v18', 8, 'Аня', 'Замечание без типа.', 'a', 'f', 'new', '2026-10-27T12:00:00Z')`,
    );
    // Shape a v18 install: the terms record did not exist before this step.
    for (const column of TERMS_COLUMNS) db.exec(`ALTER TABLE comments DROP COLUMN ${column}`);
    db.pragma('user_version = 18');

    expect(migrate(db)).toEqual({ from: 18, to: SCHEMA_VERSION });
    // Nullable text, no default: a submission may still carry no terms (an old row, a seed).
    expect(shape(db)).toEqual(TERMS_COLUMNS.map((name) => `${name}:TEXT:0:null:0`));
    // And a migrated install is the fresh one's shape, column for column.
    expect(shape(db)).toEqual(shape(fresh));
    // The row written before the step keeps its history and gains four honest nulls.
    expect(
      db.prepare(`SELECT ${TERMS_COLUMNS.join(', ')} FROM comments WHERE id = 'cmt_v18'`).get(),
    ).toEqual({
      terms_version: null,
      terms_sha: null,
      accepted_at: null,
      accepted_terms_version: null,
    });
    // A second run changes nothing.
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
    fresh.close();
  });
});
