/**
 * BOOK-174 §7 — the editor's check: where «no refusals» damages the book.
 *
 * Three in a row is mockery, more than one in four in a chapter reads as a court, more than one
 * in six across a part reads as a trial, and a part that never refuses has no weight at all.
 * The counters are recomputed from `comments`; nothing here is a reader surface.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import {
  dispositionLimitLines,
  dispositionLimits,
  readDispositionCounts,
  refreshDispositionCounts,
} from '../../src/feedback/dispositionCounts.ts';

const AT = '2026-10-28T12:00:00Z';

type StoredDisposition = 'as_said' | 'through_paper' | 'refused_in_world' | 'inadmissible' | 'escalated';

function open(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function identity(db: Db, id = 'idt_reader'): string {
  db.prepare(
    `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
     VALUES (?, ?, 'Аня', ?, ?)`,
  ).run(id, `sub-${id}`, AT, AT);
  return id;
}

let seq = 0;

/** One decided filing with a stored disposition, in decision order. */
function file(
  db: Db,
  input: {
    chapter: number;
    disposition: StoredDisposition;
    status?: 'accepted' | 'applied' | 'registered' | 'escalated';
    identity?: string;
  },
): void {
  seq += 1;
  const id = `cmt_${String(seq).padStart(24, '0')}`;
  db.prepare(
    `INSERT INTO comments
       (id, identity_id, chapter, author, body, body_sha, flags, ip_hash, status, created_at,
        decided_at, reason, disposition, number)
     VALUES (?, ?, ?, 'Аня', 'Служебное замечание.', ?, '[]', 'ip', ?, ?, ?, 'принято', ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
  ).run(
    id,
    input.identity ?? 'idt_reader',
    input.chapter,
    `sha-${id}`,
    input.status ?? 'accepted',
    AT,
    new Date(Date.UTC(2026, 9, 28, 12, seq)).toISOString(),
    input.disposition,
  );
}

function counts(db: Db) {
  refreshDispositionCounts(db, AT);
  return readDispositionCounts(db);
}

describe('refreshDispositionCounts — one row per scope, recomputed from comments', () => {
  it('counts accepted filings and in-world refusals per chapter, per reader and per part', () => {
    const db = open();
    identity(db);
    file(db, { chapter: 12, disposition: 'as_said' });
    file(db, { chapter: 12, disposition: 'refused_in_world' });
    file(db, { chapter: 13, disposition: 'through_paper', identity: 'idt_reader' });

    const rows = counts(db);
    expect(rows.find((row) => row.scope === 'chapter' && row.key === 'ch:12')).toMatchObject({
      accepted: 2,
      in_world: 1,
    });
    expect(rows.find((row) => row.scope === 'reader_chapter' && row.key === 'reader:idt_reader|ch:12')).toMatchObject({
      accepted: 2,
      in_world: 1,
    });
    // Chapters 12 and 13 are part 2.
    expect(rows.find((row) => row.scope === 'part' && row.key === 'part:2')).toMatchObject({
      accepted: 3,
      in_world: 1,
    });
    // The opening and the finale stand outside the parts, so they produce no part row.
    expect(rows.some((row) => row.key === 'part:0')).toBe(false);
    db.close();
  });

  it('counts only decided filings: an escalated one is not accepted and adds no refusal', () => {
    const db = open();
    identity(db);
    file(db, { chapter: 12, disposition: 'escalated', status: 'escalated' });
    file(db, { chapter: 12, disposition: 'inadmissible', status: 'registered' });
    const rows = counts(db);
    expect(rows.find((row) => row.key === 'ch:12')).toMatchObject({ accepted: 1, in_world: 0 });
    db.close();
  });

  it('replaces the table whole, so a rewritten chapter cannot keep a stale count', () => {
    const db = open();
    identity(db);
    file(db, { chapter: 12, disposition: 'refused_in_world' });
    counts(db);
    db.prepare('DELETE FROM comments').run();
    expect(counts(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM disposition_counts').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('dispositionLimits — the four thresholds', () => {
  it('is ok on a healthy band: seven as said, two through paper, one refused in world', () => {
    const db = open();
    identity(db);
    for (let index = 0; index < 7; index += 1) file(db, { chapter: 12, disposition: 'as_said' });
    for (let index = 0; index < 2; index += 1) file(db, { chapter: 12, disposition: 'through_paper' });
    file(db, { chapter: 12, disposition: 'refused_in_world' });
    expect(dispositionLimits(counts(db))).toEqual({
      run: 'ok',
      chapterShare: 'ok',
      partShare: 'ok',
      partZero: 'ok',
    });
    expect(dispositionLimitLines(counts(db))).toEqual(['ok']);
    db.close();
  });

  it('stops a run of three in one chapter', () => {
    const db = open();
    identity(db);
    for (let index = 0; index < 3; index += 1) file(db, { chapter: 22, disposition: 'refused_in_world' });
    const rows = counts(db);
    expect(rows.find((row) => row.key === 'ch:22')).toMatchObject({ run: 3 });
    expect(dispositionLimits(rows).run).toBe('stop');
    expect(dispositionLimitLines(rows).join('\n')).toContain('ch:22: 3 подряд');
    db.close();
  });

  it('calls a part with accepted filings and no refusal a defect', () => {
    const db = open();
    identity(db);
    file(db, { chapter: 22, disposition: 'as_said' });
    file(db, { chapter: 23, disposition: 'through_paper' });
    expect(dispositionLimits(counts(db)).partZero).toBe('defect');
    db.close();
  });

  it('flags more than one in four refusals in a chapter, once the chapter has six', () => {
    const db = open();
    identity(db);
    for (let index = 0; index < 4; index += 1) file(db, { chapter: 12, disposition: 'as_said' });
    for (let index = 0; index < 2; index += 1) file(db, { chapter: 12, disposition: 'refused_in_world' });
    expect(dispositionLimits(counts(db)).chapterShare).toBe('over');

    // Five filings is below the chapter's own floor: the share is not judged yet.
    const small = open();
    identity(small);
    for (let index = 0; index < 3; index += 1) file(small, { chapter: 12, disposition: 'as_said' });
    for (let index = 0; index < 2; index += 1) file(small, { chapter: 12, disposition: 'refused_in_world' });
    expect(dispositionLimits(counts(small)).chapterShare).toBe('ok');
    small.close();
    db.close();
  });

  it('flags more than one in six across a part', () => {
    const db = open();
    identity(db);
    for (let index = 0; index < 4; index += 1) file(db, { chapter: 12, disposition: 'as_said' });
    for (let index = 0; index < 2; index += 1) file(db, { chapter: 12, disposition: 'through_paper' });
    for (let index = 0; index < 2; index += 1) file(db, { chapter: 13, disposition: 'refused_in_world' });
    const rows = counts(db);
    expect(rows.find((row) => row.key === 'part:2')).toMatchObject({ accepted: 8, in_world: 2 });
    expect(dispositionLimits(rows).partShare).toBe('over');
    db.close();
  });
});

describe('feedback.mjs limits — the operator’s one line', () => {
  it('prints ok on a clean book and one line per breach otherwise', () => {
    const db = open();
    identity(db);
    const print = (lines: string[]) => (line: string) => {
      lines.push(line);
    };

    const clean: string[] = [];
    expect(runFeedback(['limits'], { db, dir: '', print: print(clean) })).toBe(0);
    expect(clean).toEqual(['ok']);

    for (let index = 0; index < 3; index += 1) file(db, { chapter: 22, disposition: 'refused_in_world' });
    const breach: string[] = [];
    expect(runFeedback(['limits'], { db, dir: '', print: print(breach) })).toBe(0);
    expect(breach.join('\n')).toContain('ch:22: 3 подряд');
    // The counters are materialised by the run itself — one chapter row and its part, never a
    // reader surface.
    expect(
      db.prepare('SELECT scope, key FROM disposition_counts ORDER BY scope, key').all(),
    ).toEqual([
      { scope: 'chapter', key: 'ch:22' },
      { scope: 'part', key: 'part:3' },
      { scope: 'reader_chapter', key: 'reader:idt_reader|ch:22' },
    ]);
    db.close();
  });
});
