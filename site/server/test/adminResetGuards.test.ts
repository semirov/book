import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';

import { EngineBridge } from '../src/engineState/bridge.ts';
import { applyChapterFile } from '../src/ingest/applyChapter.ts';
import { BackupFailedError, FrameMissingError, resetBook } from '../src/reset/book.ts';
import { longProse } from './helpers.ts';
import { count, expectedCounts, SEEDED_STATE_VERSION } from './resetSeed.ts';
import { createResetHarness, stateVersionOf } from './resetApp.ts';

/**
 * BOOK-137 — the guards the reviewer's findings added around the wipe.
 *
 *   B1 — the snapshot counter is bumped, never reset: a page ignores a state whose version went
 *        backwards, so a restart at 1 would leave every open tab on the pre-launch book.
 *   B2 — BOOK-187: the guard reads **rows**. A frame slot whose `chapters` row is prose (not
 *        `basis`, `chars > 0`) refuses the wipe — the reset would otherwise freeze the wrong
 *        text as the canon — and a slot with no row at all is re-seeded from `book_frame`, the
 *        volume's own copy of the sentence.
 *   M2 — a reset may delete only the file it created: an existing backup is never unlinked.
 *   M1 — the engine bridge keeps in-memory cursors over ids the wipe restarts, so it is
 *        re-primed after a completed wipe and never on a dry run or a refusal.
 */

const h = createResetHarness();

afterEach(async () => {
  await h.close();
});

describe('BOOK-137 B1 — the state version never goes down', () => {
  it('bumps the counter instead of resetting it', async () => {
    const target = await h.live();
    expect(stateVersionOf(target.db)).toBe(SEEDED_STATE_VERSION);

    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    expect(stateVersionOf(target.db)).toBe(SEEDED_STATE_VERSION + 1);
    expect(stateVersionOf(target.db)).toBeGreaterThan(SEEDED_STATE_VERSION);
  });

  it('keeps the counter when a second reset removes nothing', async () => {
    const target = await h.live();
    await h.call({ dryRun: false });
    expect(stateVersionOf(target.db)).toBe(SEEDED_STATE_VERSION + 1);

    const again = await h.call({ dryRun: false });
    expect(again.statusCode).toBe(200);
    expect(again.json().total).toBe(0);
    expect(again.json().tables.find((entry: { key: string }) => entry.key === 'meta').rows).toBe(0);
    expect(stateVersionOf(target.db)).toBe(SEEDED_STATE_VERSION + 1);
  });

  it('starts a book that never published a snapshot at 1', async () => {
    const target = await h.live();
    target.db.prepare("DELETE FROM meta WHERE k = 'state_version'").run();
    expect(stateVersionOf(target.db)).toBe(0);

    await h.call({ dryRun: false });
    expect(stateVersionOf(target.db)).toBe(1);
  });
});

describe('BOOK-137 B2 — the guard reads rows, and the frame is a row', () => {
  it('reports the content from rows on a dry run, and wipes a book whose prose is only rows', async () => {
    const target = await h.live();
    const before = expectedCounts(target);

    const dry = await h.call({ dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().content).toEqual({
      written: 1,
      chars: count(target.db, 'SELECT COALESCE(SUM(chars), 0) AS n FROM chapters WHERE basis = 0'),
      blocks: count(target.db, 'SELECT COUNT(*) AS n FROM blocks'),
    });
    expect(dry.json().content.written).toBe(1);

    const done = await h.call({ dryRun: false });
    expect(done.statusCode).toBe(200);
    expect(done.json().dryRun).toBe(false);
    expect(expectedCounts(target)).not.toEqual(before);
    expect(count(target.db, 'SELECT COUNT(*) AS n FROM chapters WHERE basis = 0')).toBe(0);
  });

  it('refuses a frame slot whose row is prose, before any backup, and names the row', async () => {
    // ch01 is the frame: prose there is a canon problem (`FRAME_NOT_BASIS`), not a chapter to
    // reset — and it is refused before the backup, so nothing is written.
    const target = await h.live({
      files: {
        'ch01.md': longProse(['Глава первая. Теперь это обычная глава, а не кадр.']),
        'ch42.md': FRAME_LAST_SENTENCE,
        'ch08.md': longProse(['Служебный абзац.']),
      },
    });
    const before = expectedCounts(target);
    const chars = count(target.db, 'SELECT chars AS n FROM chapters WHERE n = 1');
    expect(chars).toBeGreaterThan(0);

    const refused = await h.call({ dryRun: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'FRAME_NOT_BASIS' });
    expect(refused.json().message).toContain('chapter 1');
    expect(refused.json().message).toContain(String(chars));
    // No file, no git, no operator step to clear: the remedy is the canon's own row.
    expect(refused.json().message).not.toContain('manuscript/');
    expect(refused.json().message).not.toContain('git ');
    expect(expectedCounts(target)).toEqual(before);
    expect(stateVersionOf(target.db)).toBe(SEEDED_STATE_VERSION);
  });

  it('re-seeds a frame slot that has no chapter row from its book_frame row', async () => {
    const target = await h.live();
    // A slot with no row at all: an empty book, not a broken mount (BOOK-187).
    target.db.prepare('DELETE FROM blocks WHERE chapter = 1').run();
    target.db.prepare('DELETE FROM chapters WHERE n = 1').run();

    const response = await h.call({ dryRun: false });
    expect(response.statusCode).toBe(200);
    const rows = target.db.prepare('SELECT n, basis, block_count FROM chapters ORDER BY n').all();
    expect(rows).toEqual([
      { n: 1, basis: 1, block_count: 1 },
      { n: 42, basis: 1, block_count: 1 },
    ]);
    expect((target.db.prepare('SELECT text FROM blocks WHERE chapter = 1').get() as { text: string }).text).toBe(
      FRAME_FIRST_SENTENCE,
    );
  });

  it('keeps the frozen sentence when only the frame rows are left', async () => {
    // The positive control for both refusals: two basis slots and nothing else is a clean book.
    const target = await h.live();
    target.db.prepare('DELETE FROM blocks WHERE chapter NOT IN (1, 42)').run();
    target.db.prepare('DELETE FROM chapters WHERE basis = 0').run();

    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    const frame = target.db.prepare('SELECT n, block_count, basis FROM chapters ORDER BY n').all();
    expect(frame).toEqual([
      { n: 1, block_count: 1, basis: 1 },
      { n: 42, block_count: 1, basis: 1 },
    ]);
  });

  it('refuses a volume that holds neither a frame row nor a chapter row', async () => {
    const target = await h.live();
    target.db.prepare('DELETE FROM book_frame').run();
    target.db.prepare('DELETE FROM blocks WHERE chapter IN (1, 42)').run();
    target.db.prepare('DELETE FROM chapters WHERE n IN (1, 42)').run();

    expect(() =>
      resetBook(target.db, { dataDir: target.dataDir, now: new Date(), dryRun: false }),
    ).toThrow(FrameMissingError);
    expect(count(target.db, 'SELECT COUNT(*) AS n FROM chapters WHERE basis = 0')).toBe(1);
  });
});

describe('BOOK-137 M2 — a backup the reset did not create', () => {
  it('refuses a target that already exists instead of deleting it', async () => {
    const target = await h.live();
    const file = join(target.dataDir, 'taken.db');
    writeFileSync(file, 'an earlier copy', { mode: 0o600 });
    const before = readFileSync(file);

    expect(() =>
      resetBook(target.db, {
        dataDir: target.dataDir,
        now: new Date(),
        dryRun: false,
        backupFile: file,
      }),
    ).toThrow(BackupFailedError);
    expect(readFileSync(file)).toEqual(before);
    expect(count(target.db, 'SELECT COUNT(*) AS n FROM chapters WHERE basis = 0')).toBe(1);
  });

  it('never overwrites the file an earlier reset left at the same second', async () => {
    const target = await h.live();
    const now = new Date('2026-10-28T12:00:00Z');
    const taken = join(target.dataDir, 'book-reset-20261028T120000Z.db');
    writeFileSync(taken, 'an earlier copy', { mode: 0o600 });
    const before = readFileSync(taken);

    const report = resetBook(target.db, { dataDir: target.dataDir, now, dryRun: false });
    expect(report.backup?.file).toBe(join(target.dataDir, 'book-reset-20261028T120000Z-1.db'));
    expect(readFileSync(taken)).toEqual(before);
  });
});

describe('BOOK-137 M1 — the bridge after a wipe', () => {
  it('re-primes on a completed reset, so the next fact is narrated', async () => {
    const bridges: EngineBridge[] = [];
    const target = await h.live({ onBookReset: () => bridges[0]?.prime() });
    const frames: Array<{ type: string; data: unknown }> = [];
    const bridge = new EngineBridge({
      db: target.db,
      emit: (type, data) => frames.push({ type, data }),
      progressThrottleMs: 0,
    });
    bridges.push(bridge);
    bridge.prime();

    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    // The book was just emptied: nothing to narrate, and the cursors sit on the empty log.
    bridge.tick();
    expect(frames.filter((frame) => frame.type === 'history:event')).toHaveLength(0);

    // The first fact of the fresh book: `hseq` restarts at 1, which is exactly the id a stale
    // cursor would skip. Without the re-prime this tick emits no history frame at all.
    const raw = longProse(['Новая глава после сброса.']);
    const file = join(target.manuscript, 'ch09.md');
    writeFileSync(file, raw, 'utf8');
    applyChapterFile({
      db: target.db,
      dataDir: target.dataDir,
      n: 9,
      raw,
      mtimeMs: statSync(file).mtimeMs,
      nowMs: Date.now(),
    });
    bridge.tick();
    expect(frames.filter((frame) => frame.type === 'history:event').length).toBeGreaterThan(0);
  });

  it('survives a failing hook: the wipe stays done and the answer carries the warning', async () => {
    const target = await h.live({
      onBookReset: () => {
        throw new Error('boom');
      },
    });

    const response = await h.call({ dryRun: false });
    // A broken bridge is not a failed reset: the wipe is committed, so the answer is a 200 with
    // a warning — never a 500 that would tell the operator nothing happened.
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.warning).toContain('engine bridge');
    expect(body.backup).not.toBeNull();
    expect(count(target.db, 'SELECT COUNT(*) AS n FROM chapters WHERE basis = 0')).toBe(0);
    expect(stateVersionOf(target.db)).toBe(SEEDED_STATE_VERSION + 1);
  });

  it('never re-primes on a dry run or a refusal', async () => {
    let calls = 0;
    const target = await h.live({
      onBookReset: () => {
        calls += 1;
      },
    });
    // A frame slot turned into prose is the refusal; the canon is restored by putting the row
    // back (the same `chapters`/`blocks` write the applier does), never by editing a file.
    const frame = target.db.prepare('SELECT * FROM chapters WHERE n = 1').get() as Record<string, unknown>;
    target.db.prepare("UPDATE chapters SET basis = 0, chars = 120 WHERE n = 1").run();
    try {
      await h.call({ dryRun: true });
      expect((await h.call({ dryRun: false })).statusCode).toBe(409);
      expect(calls).toBe(0);
    } finally {
      target.db
        .prepare('UPDATE chapters SET basis = ?, chars = ? WHERE n = 1')
        .run(frame.basis as number, frame.chars as number);
    }

    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    expect(calls).toBe(1);
  });
});
