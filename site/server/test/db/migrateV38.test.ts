/**
 * BOOK-222 follow-up — migration v38 on the schema side.
 *
 * A landing holds its text on the step and publishes nothing before the close, so the patch's
 * character edits (the thing that keeps sentence ids across a write) have to wait beside the
 * candidate: `steps.candidate_sentences`. A fresh install declares it in `tables.ts`; `migrateV38`
 * appends it to a volume that predates it, and a row written before this step reads as «the
 * candidate carries no edit» — which is what a rewrite, a draft or an older build wrote.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { V38_STEP_COLUMNS, migrateV38 } from '../../src/db/migrateV38.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

describe('migration v38 — the patch edits held with the candidate', () => {
  it('a fresh install carries every v38 column, beside the candidate it belongs to', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(SCHEMA_VERSION).toBe(38);
    const steps = columns(db, 'steps');
    const [name] = V38_STEP_COLUMNS[0] ?? ['candidate_sentences'];
    // The edit and the text are one fact: the column is declared right after the sha the gates read.
    expect(steps.indexOf(name)).toBe(steps.indexOf('candidate_sha') + 1);
    db.close();
  });

  it('replays as a no-op on an install that already has the shape', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const before = columns(db, 'steps');
    migrateV38(db);
    expect(columns(db, 'steps')).toEqual(before);
    db.close();
  });

  it('reads an older candidate as one that carries no patch, and keeps its text', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // A candidate as v36 wrote it — beside `candidate_text`/`candidate_sha` there was no column.
    db.exec('ALTER TABLE steps DROP COLUMN candidate_sentences');
    db.prepare(
      `INSERT INTO steps (step_id, seq, wave, lane, pass, chapter, boundary, at, candidate_text, candidate_sha)
       VALUES ('stp_v36', 1, 1, 'forward', 'change', 12, '12', '2026-10-29T00:00:00Z', 'Глава двенадцатая\n\nТекст главы.\n', 'sha-old')`,
    ).run();

    migrateV38(db);
    expect(
      db.prepare('SELECT candidate_text, candidate_sha, candidate_sentences FROM steps WHERE step_id = ?').get('stp_v36'),
    ).toEqual({
      candidate_text: 'Глава двенадцатая\n\nТекст главы.\n',
      candidate_sha: 'sha-old',
      // No edits, so the publish re-segments the text — the behaviour of the build that wrote it.
      candidate_sentences: null,
    });
    db.close();
  });
});
