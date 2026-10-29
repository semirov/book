import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { FRAME_SEED, seedFrame } from '../src/db/migrateV28.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import { sha256Hex } from '../src/util/hash.ts';

/**
 * BOOK-187 — schema v28: the frame rows, the lane's state, the redacted transcripts and
 * ADR-041 §2.2's block deltas.
 *
 * The step is additive and idempotent, and every object comes from the one constant both the
 * fresh install and the upgrade read, so the two installs cannot drift. 28, not 23: v23–v27 are
 * main's (the author marker, the sentence, the push tables, the disposition chain), so this step
 * appends after them. What is pinned here: a fresh database is created at v28 *with* the two
 * canon rows (the site serves the canon before it has prose), a v27 volume gains the same objects
 * — and the seeded frame — without losing a row, the seed never overwrites a row that is already
 * there, and the CHECKs are the schema's, not the caller's.
 */

type FrameRow = { chapter: number; position: string; text: string; sha256: string; seeded_at: string };

function frameRows(db: Db): FrameRow[] {
  return db.prepare('SELECT chapter, position, text, sha256, seeded_at FROM book_frame ORDER BY chapter').all() as FrameRow[];
}

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function indexes(db: Db): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`).all() as Array<{
    name: string;
  }>).map((row) => row.name);
}

/** A v27 volume: everything v28 adds is removed and the cursor put back one step. */
function asV27(db: Db): void {
  db.exec('DROP TABLE book_frame');
  db.exec('DROP TABLE writer_state');
  db.exec('DROP TABLE pass_transcripts');
  db.exec('DROP TABLE block_deltas');
  db.pragma('user_version = 27');
}

describe('migrate — BOOK-187 (v28): the book’s own state', () => {
  it('creates the four tables, their indexes and the two frame rows on a fresh install', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(32);

    for (const table of ['book_frame', 'writer_state', 'pass_transcripts', 'block_deltas']) {
      expect(columns(db, table).length, table).toBeGreaterThan(0);
    }
    expect(indexes(db)).toEqual(expect.arrayContaining(['pass_transcripts_at', 'block_deltas_rev', 'block_deltas_hseq']));

    // The canon is in the volume before any prose: the site serves ch01/ch42 as basis slots.
    const rows = frameRows(db);
    expect(rows.map((row) => [row.chapter, row.position, row.text])).toEqual([
      [1, 'first', FRAME_FIRST_SENTENCE],
      [42, 'last', FRAME_LAST_SENTENCE],
    ]);
    for (const row of rows) {
      expect(row.sha256).toBe(sha256Hex(row.text));
      // `seeded_at` is the migration moment, so a fresh row is not dated before the run.
      expect(Number.isNaN(Date.parse(row.seeded_at))).toBe(false);
    }
    // The seed names the same two constants the check compiles in — never a retyped sentence.
    expect(FRAME_SEED.map((row) => row.text)).toEqual([FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE]);
    db.close();
  });

  it('upgrades a v27 volume to the same shape, keeping every row it had and seeding the frame', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
       VALUES (1, 3, 'Тестовая глава', 'abc', 10, 1, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev)
       VALUES ('ch01#aaaaaaaa', 1, 0, ?, 'aaaaaaaa', 1, 3)`,
    ).run(FRAME_FIRST_SENTENCE);
    asV27(db);

    expect(migrate(db)).toEqual({ from: 27, to: SCHEMA_VERSION });
    expect(columns(db, 'block_deltas')).toEqual(
      expect.arrayContaining(['block_uid', 'from_ver', 'to_ver', 'chapter', 'rev', 'ops', 'old_len', 'new_len', 'source', 'hseq', 'at']),
    );
    expect(frameRows(db).map((row) => row.text)).toEqual([FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE]);
    // Nothing of the book moved: the projection the v27 install had is still there.
    expect(db.prepare('SELECT title, rev FROM chapters WHERE n = 1').get()).toEqual({ title: 'Тестовая глава', rev: 3 });
    expect(db.prepare('SELECT text FROM blocks WHERE id = ?').get('ch01#aaaaaaaa')).toEqual({ text: FRAME_FIRST_SENTENCE });
    db.close();
  });

  it('is idempotent, and never overwrites a row that is already there', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const before = frameRows(db);
    // A second run, and a direct seed, both leave the rows exactly as they were.
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    seedFrame(db, '2030-01-01T00:00:00Z');
    expect(frameRows(db)).toEqual(before);
    db.close();
  });

  it('keeps the CHECKs and the composite keys the deltas and transcripts rely on', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const insertDelta = db.prepare(
      `INSERT INTO block_deltas (block_uid, from_ver, to_ver, chapter, rev, ops, old_len, new_len, source, hseq, at)
       VALUES ('uid', 1, 2, 1, 2, '[]', 3, 4, ?, 1, '2026-10-28T10:00:00Z')`,
    );
    expect(() => insertDelta.run('rebase')).toThrow(/CHECK constraint failed/u);
    insertDelta.run('patch');
    // One row per (block_uid, to_ver): a version cannot be described twice.
    expect(() => insertDelta.run('diff')).toThrow(/UNIQUE constraint failed/u);

    expect(() =>
      db.prepare(`INSERT INTO book_frame (chapter, position, text, sha256, seeded_at) VALUES (1, 'middle', 'x', 'y', 'z')`).run(),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      db.prepare(`INSERT INTO writer_state (id, day, passes, updated_at) VALUES (2, '2026-10-28', 0, 'z')`).run(),
    ).toThrow(/CHECK constraint failed/u);

    db.prepare(
      `INSERT INTO pass_transcripts (pass_id, seq, at, role, content_redacted) VALUES ('pass_1', 1, '2026-10-28T10:00:00Z', 'draft', '{}')`,
    ).run();
    // The defaults are zeros, not nulls: a pass with no counted tokens is a fact, not an absence.
    expect(db.prepare('SELECT tokens_in, tokens_out, prompt_bundle FROM pass_transcripts WHERE pass_id = ?').get('pass_1')).toEqual({
      tokens_in: 0,
      tokens_out: 0,
      prompt_bundle: null,
    });
    db.close();
  });
});
