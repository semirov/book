import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { FRAME_LAST_SENTENCE, splitSentences } from '@book/shared';

import { REQUIRED_TRIGGERS } from '../src/db/schema.ts';
import { appendEvent } from '../src/history/log.ts';
import { BackupFailedError, countBook, resetBook } from '../src/reset/book.ts';
import { AT, CONTENT_KEYS, count, expectedCounts, ZEROS } from './resetSeed.ts';
import { createResetHarness } from './resetApp.ts';

/**
 * BOOK-137 — the launch reset: the route, the wipe and its backup.
 *
 * The book these tests wipe is the operator's real shape (`resetSeed.ts`): three chapters (two
 * basis slots and one written chapter), one identity with its session, one filing that became a
 * change, a cascade with its step, both gates, a released lease, impact, contributions, the rate
 * state, a reconcile mark and the `meta` keys. Everything here is a temp fixture; no test
 * touches the live data dir. The guards that refuse the wipe (state version, manuscript, backup
 * ownership, the bridge) are in `adminResetGuards.test.ts`.
 */

const h = createResetHarness();

afterEach(async () => {
  await h.close();
});

function rows(body: { tables: Array<{ key: string; rows: number }> }): Record<string, number> {
  return Object.fromEntries(body.tables.map((entry) => [entry.key, entry.rows]));
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function backups(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name.startsWith('book-reset-'));
}

describe('POST /api/admin/reset/book — the guard and the dry run', () => {
  it('is guarded like the rest of the panel', async () => {
    await h.live();
    const missing = await h.call({ dryRun: true }, null);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    const wrong = await h.call({ dryRun: true }, 'not-the-token');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain('not-the-token');
  });

  it('does not exist when no admin token is configured', async () => {
    await h.live({ token: '' });
    const response = await h.call({ dryRun: true }, null);
    expect(response.statusCode).toBe(404);
  });

  it('reports every counter in the documented order and writes nothing', async () => {
    const target = await h.live();
    const before = expectedCounts(target);
    expect(before.blocks).toBeGreaterThan(0);
    expect(before.block_versions).toBeGreaterThan(0);
    expect(before.block_lineage).toBeGreaterThan(0);
    expect(before.sentences).toBeGreaterThan(0);

    const response = await h.call({ dryRun: true });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.target).toBe('book');
    expect(body.dryRun).toBe(true);
    expect(body.tables.map((entry: { key: string }) => entry.key)).toEqual(CONTENT_KEYS);
    expect(rows(body)).toEqual(before);
    expect(body.total).toBe(total(before));
    expect(body.kept).toEqual([
      { key: 'identities', rows: 1 },
      { key: 'sessions', rows: 1 },
      { key: 'front_matter', rows: 1 },
    ]);
    expect(body.frame).toEqual([1, 42]);
    expect(body.engine).toEqual({ openSteps: 0, liveLeases: 0 });
    // BOOK-202: chapter 1 is kept, so the report names it and the content below excludes it.
    expect(body.chapter1).toMatchObject({ chapter: 1, blocks: expect.any(Number), sentences: expect.any(Number) });
    expect(body.chapter1.sha256After).toBe(body.chapter1.sha256Before);
    // BOOK-187: what the wipe removes, counted from rows — written chapters, characters,
    // paragraphs. There is no manuscript file to report.
    const chars = target.db
      .prepare('SELECT COALESCE(SUM(chars), 0) AS n FROM chapters WHERE basis = 0 AND n <> 1')
      .get() as { n: number };
    const blocks = target.db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE chapter <> 1').get() as { n: number };
    expect(body.content).toEqual({ written: 1, chars: chars.n, blocks: blocks.n });
    expect(body.backup).toBeNull();
    expect(body.backupSkipped).toBeNull();

    // Nothing changed and no backup was made: a dry run is a read.
    expect(expectedCounts(target)).toEqual(before);
    expect(backups(target.dataDir)).toEqual([]);
    // The answer carries counts only — no text, no token.
    expect(response.body).not.toContain('Служебное замечание');
    expect(response.body).not.toContain('panel-token');
  });

  it('treats an absent body as a dry run, and refuses a shape that is not a boolean', async () => {
    const target = await h.live();
    const absent = await h.call(undefined);
    expect(absent.statusCode).toBe(200);
    expect(absent.json().dryRun).toBe(true);
    expect(backups(target.dataDir)).toEqual([]);

    const invalid = await h.call({ dryRun: 'yes' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'INVALID' });
  });

  it('refuses backupOk without a wipe: a dry run with no backup is a contradiction', async () => {
    const target = await h.live();
    for (const body of [{ backupOk: true }, { dryRun: true, backupOk: true }]) {
      const response = await h.call(body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID' });
    }
    expect(backups(target.dataDir)).toEqual([]);
  });
});

describe('POST /api/admin/reset/book — the wipe', () => {
  it('empties the content, keeps the people, and answers with the removed counts', async () => {
    const target = await h.live();
    const before = expectedCounts(target);

    const response = await h.call({ dryRun: false });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dryRun).toBe(false);
    expect(rows(body)).toEqual(before);
    expect(body.total).toBe(total(before));

    const db = target.db;
    // BOOK-202: every other chapter goes; ch01 is the chapter the reset keeps.
    expect(count(db, 'SELECT COUNT(*) AS n FROM chapters WHERE basis = 0 AND n <> 1')).toBe(0);
    expect(
      count(
        db,
        'SELECT COUNT(*) AS n FROM blocks JOIN chapters AS c ON c.n = blocks.chapter WHERE c.basis = 0 AND c.n <> 1',
      ),
    ).toBe(0);
    for (const table of [
      'changes',
      'steps',
      'comments',
      'events',
      'rate_events',
      'contributions',
      'contribution_history',
      'sentence_touches',
    ]) {
      expect(count(db, `SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0);
    }
    // The histories are the wiped chapters' only: ch01's rows are still there.
    expect(count(db, 'SELECT COUNT(*) AS n FROM revisions WHERE chapter <> 1')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM block_versions WHERE chapter <> 1')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM block_lineage WHERE chapter <> 1')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM revisions WHERE chapter = 1')).toBeGreaterThan(0);
    // ADR-044: a wiped book holds the finale's frame paragraph and ch01's own sentences — the
    // counter ignores both, because neither is content the reset removed (BOOK-202).
    const frameSentences = (
      db
        .prepare('SELECT b.text AS text FROM blocks b JOIN chapters c ON c.n = b.chapter WHERE c.basis = 1')
        .all() as Array<{ text: string }>
    ).reduce((sum, block) => sum + splitSentences(block.text).length, 0);
    const keptSentences = count(db, 'SELECT COUNT(*) AS n FROM sentences WHERE erased_at IS NULL');
    expect(keptSentences - frameSentences).toBe(body.chapter1.sentences);
    expect(countBook(db).find((entry) => entry.key === 'sentences')?.rows).toBe(0);
    // The people and the canon stay; only the frame is re-projected.
    expect(count(db, 'SELECT COUNT(*) AS n FROM identities')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM front_matter')).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM meta WHERE k = 'engine.alerts'")).toBe(0);
    const keptMeta = db.prepare('SELECT k FROM meta ORDER BY k').all() as Array<{ k: string }>;
    expect(keptMeta.map((row) => row.k)).toEqual([
      'engine.heartbeat',
      // The author marker is a fact about a person, not about the book: a launch reset keeps it,
      // or the owner would silently become his own contributor again (owner, 2026-10-28).
      'identities.is_author',
      'last_scan_at',
      'rights.backfill',
      'state_version',
    ]);
    expect(db.prepare('SELECT holder, heartbeat_at FROM lane').get()).toEqual({ holder: null, heartbeat_at: null });

    // The finale is the frozen basis slot; ch01 keeps the chapter it had (BOOK-202).
    const basis = db
      .prepare('SELECT n, basis, chars, block_count, rev FROM chapters WHERE basis = 1 ORDER BY n')
      .all() as Array<{ n: number; basis: number; chars: number; block_count: number; rev: number }>;
    expect(basis).toEqual([{ n: 42, basis: 1, chars: 0, block_count: 1, rev: 0 }]);
    expect(
      db.prepare('SELECT basis, block_count FROM chapters WHERE n = 1').get(),
    ).toEqual({ basis: 0, block_count: body.chapter1.blocks });
    expect((db.prepare('SELECT text FROM blocks WHERE chapter = 42').get() as { text: string }).text).toBe(
      FRAME_LAST_SENTENCE,
    );
    // No dangling reference, and the log's append-only promise is back.
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name);
    // BOOK-176: the ledger's guards are restored with the log's — a reset empties the book but
    // keeps every promise that makes the tables mean something.
    expect(triggers).toEqual([...REQUIRED_TRIGGERS].sort());
    // A fresh book numbers its fifo from 1: `changes` restarted with its rows. `events` does not
    // restart — ch01's kept `hseq` pointers still address the log's old numbers (BOOK-202).
    expect(count(db, "SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'changes'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'events'")).toBe(1);
  });

  it('restarts the log counter when nothing kept addresses the old numbers', async () => {
    // A volume that never held ch01: no kept row carries an `hseq`, so the log is a fresh log.
    const target = await h.live();
    const db = target.db;
    db.exec('DELETE FROM sentences WHERE block_id IN (SELECT id FROM blocks WHERE chapter = 1)');
    for (const table of ['block_versions', 'block_lineage', 'revisions']) {
      db.exec(`DELETE FROM ${table} WHERE chapter = 1`);
    }
    db.exec('DELETE FROM blocks WHERE chapter = 1');
    db.exec('DELETE FROM chapters WHERE n = 1');

    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    expect(count(db, "SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'events'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'changes'")).toBe(0);
  });

  it('keeps the log counter under ch01’s hseq pointers, so the next event cannot reuse one', async () => {
    const target = await h.live();
    const db = target.db;
    // Every number ch01's kept rows address in the log — a restart would reuse one of these.
    const kept = Math.max(
      count(db, 'SELECT COALESCE(MAX(hseq), 0) AS n FROM revisions WHERE chapter = 1'),
      count(db, 'SELECT COALESCE(MAX(hseq), 0) AS n FROM block_versions WHERE chapter = 1'),
      count(db, 'SELECT COALESCE(MAX(first_hseq), 0) AS n FROM block_lineage WHERE chapter = 1'),
      count(db, 'SELECT COALESCE(MAX(last_hseq), 0) AS n FROM block_lineage WHERE chapter = 1'),
    );
    expect(kept).toBeGreaterThan(0);

    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    const next = appendEvent(db, { kind: 'chapter.revised', chapter: 8, authorKind: 'operator' }, Date.now());
    expect(next).toBeGreaterThan(kept);
  });

  it('removes revisions that name a step and a cascade — and keeps ch01’s with its pointers cleared', async () => {
    const target = await h.live();
    // A real book's revisions carry the step and cascade that wrote them, and both are deleted
    // before `revisions` in the wipe order. The reset must survive that order.
    target.db
      .prepare("UPDATE revisions SET step_id = 'stp_one', cascade_id = 'csc_one', change_id = 'chg_one'")
      .run();

    const response = await h.call({ dryRun: false });
    expect(response.statusCode).toBe(200);
    expect(count(target.db, 'SELECT COUNT(*) AS n FROM revisions WHERE chapter <> 1')).toBe(0);
    // BOOK-202: ch01's revision is kept, and the pointers into the wiped tables are nulled
    // rather than left dangling for `foreign_key_check` to catch.
    expect(
      target.db.prepare('SELECT chapter, change_id, cascade_id, step_id FROM revisions').all(),
    ).toEqual([{ chapter: 1, change_id: null, cascade_id: null, step_id: null }]);
    expect(target.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('takes a verified backup of the book it removed', async () => {
    const target = await h.live();
    const before = expectedCounts(target);

    const body = (await h.call({ dryRun: false })).json();
    expect(body.backup).toMatchObject({ mode: '0600', integrity: 'ok', countsMatch: true });
    expect(body.backupSkipped).toBeNull();
    expect(body.warning).toBeUndefined();

    const file = body.backup.file as string;
    expect(file.startsWith(target.dataDir)).toBe(true);
    expect(file).toMatch(/book-reset-\d{8}T\d{6}Z\.db$/u);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const copy = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(Object.fromEntries(countBook(copy).map((entry) => [entry.key, entry.rows]))).toEqual(before);
    } finally {
      copy.close();
    }
  });

  it('never overwrites an earlier backup taken in the same second', async () => {
    const target = await h.live();
    const now = new Date('2026-10-28T12:00:00Z');
    const options = { bookRoot: target.root, dataDir: target.dataDir, now, dryRun: false };

    const first = resetBook(target.db, options);
    expect(first.backup?.file).toBe(join(target.dataDir, 'book-reset-20261028T120000Z.db'));

    // New activity after the first reset makes the book non-empty again; the second reset in
    // the same second must not clobber the copy the first one left. (A rescan would not work
    // any more: the file is gone, so files win and the chapter would be removed, not restored.)
    target.db.prepare('INSERT INTO rate_events (key, ts) VALUES (?, ?)').run('edit:id:after', 1_760_000_000_000);
    const second = resetBook(target.db, options);
    expect(second.total).toBeGreaterThan(0);
    expect(second.backup?.file).toBe(join(target.dataDir, 'book-reset-20261028T120000Z-1.db'));
    expect(backups(target.dataDir).sort()).toEqual([
      'book-reset-20261028T120000Z-1.db',
      'book-reset-20261028T120000Z.db',
    ]);
  });

  it('reports zeros and takes no second backup when there is nothing left to remove', async () => {
    const target = await h.live();
    await h.call({ dryRun: false });
    const [firstBackup] = backups(target.dataDir);
    expect(firstBackup).toBeDefined();

    const dry = await h.call({ dryRun: true });
    expect(rows(dry.json())).toEqual(ZEROS);
    expect(dry.json().total).toBe(0);

    const again = await h.call({ dryRun: false });
    expect(again.statusCode).toBe(200);
    const body = again.json();
    expect(rows(body)).toEqual(ZEROS);
    expect(body.total).toBe(0);
    expect(body.backup).toBeNull();
    expect(body.backupSkipped).toBe('nothing to remove');
    expect(backups(target.dataDir)).toEqual([firstBackup]);
  });
});

describe('the book the API serves after a reset', () => {
  it('renders the kept chapter 1, the finale frame, and no comments', async () => {
    const target = await h.live();
    const kept = target.db.prepare('SELECT block_count FROM chapters WHERE n = 1').get() as { block_count: number };
    await h.call({ dryRun: false });

    const state = (await h.get('/api/state')).json();
    // BOOK-202: ch01 is a written chapter now, not a basis slot.
    expect(state.chapters.written).toEqual([1]);
    expect(state.chapters.count).toBe(1);
    expect(state.chapters.basis).toEqual([42]);
    expect(state.history.live).toBe(false);

    const comments = (await h.get('/api/comments')).json();
    expect(comments).toEqual({ items: [], nextBefore: null });

    const chapter1 = await h.get('/api/chapters/1');
    expect(chapter1.statusCode).toBe(200);
    expect(chapter1.json()).toMatchObject({ basis: false, blocks: expect.any(Array) });
    expect(chapter1.json().blocks).toHaveLength(kept.block_count);

    const finale = await h.get('/api/chapters/42');
    expect(finale.statusCode).toBe(200);
    expect(finale.json().basis).toBe(true);
    expect(finale.json().blocks).toHaveLength(1);
    expect(finale.json().blocks[0].text).toBe(FRAME_LAST_SENTENCE);

    const missing = await h.get('/api/chapters/8');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_WRITTEN' });
  });
});

describe('the reset refuses rather than destroying', () => {
  it('refuses with FRAME_MISSING when no row holds the frame, and wipes nothing', async () => {
    // BOOK-187: a slot with no chapter row is seeded from `book_frame`; a volume that holds
    // neither is the only thing left to refuse. The rows are deleted on purpose here.
    const target = await h.live();
    target.db.prepare('DELETE FROM book_frame').run();
    target.db.prepare('DELETE FROM blocks WHERE chapter = 42').run();
    target.db.prepare('DELETE FROM chapters WHERE n = 42').run();
    const before = expectedCounts(target);

    const response = await h.call({ dryRun: false });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'FRAME_MISSING' });
    expect(response.json().message).toContain('book_frame 42/last');
    expect(expectedCounts(target)).toEqual(before);
    expect(backups(target.dataDir)).toEqual([]);
  });

  it('refuses with ENGINE_BUSY while a step is open, and still counts on a dry run', async () => {
    const target = await h.live();
    target.db
      .prepare(
        `INSERT INTO steps (step_id, seq, wave, pass, chapter, boundary, outcome, at)
         VALUES ('stp_open', 2, 0, 'draft', 9, '9', NULL, ?)`,
      )
      .run(AT);
    const before = expectedCounts(target);

    const dry = await h.call({ dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().engine).toEqual({ openSteps: 1, liveLeases: 0 });

    const response = await h.call({ dryRun: false });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'ENGINE_BUSY', openSteps: 1, liveLeases: 0 });
    expect(expectedCounts(target)).toEqual(before);
    expect(backups(target.dataDir)).toEqual([]);
  });

  it('refuses with BACKUP_FAILED when the copy cannot be written, and wipes nothing', async () => {
    const target = await h.live();
    const before = expectedCounts(target);

    expect(() =>
      resetBook(target.db, {
        dataDir: target.dataDir,
        now: new Date(),
        dryRun: false,
        backupFile: join(target.dataDir, 'no-such-dir', 'book.db'),
      }),
    ).toThrow(BackupFailedError);
    expect(expectedCounts(target)).toEqual(before);
    expect(backups(target.dataDir)).toEqual([]);
  });

  it('proceeds without a backup when the operator passes backupOk', async () => {
    const target = await h.live();
    const db = target.db;
    h.readonlyDir(target.dataDir);

    const refused = await h.call({ dryRun: false });
    expect(refused.statusCode).toBe(500);
    expect(refused.json()).toMatchObject({ code: 'BACKUP_FAILED' });
    // BOOK-202: ch01 is kept, so the marker of «not wiped» is the other chapter's row.
    expect(count(db, 'SELECT COUNT(*) AS n FROM chapters WHERE n = 8')).toBe(1);
    expect(backups(target.dataDir)).toEqual([]);

    const forced = await h.call({ dryRun: false, backupOk: true });
    expect(forced.statusCode).toBe(200);
    const body = forced.json();
    expect(body.backup).toBeNull();
    expect(body.warning).toBe('no backup: backupOk was given');
    expect(count(db, 'SELECT COUNT(*) AS n FROM chapters WHERE n = 8')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM identities')).toBe(1);
  });
});
