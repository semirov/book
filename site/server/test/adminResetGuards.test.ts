import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FRAME_LAST_SENTENCE } from '@book/shared';

import { EngineBridge } from '../src/engineState/bridge.ts';
import { applyChapterFile } from '../src/ingest/applyChapter.ts';
import { BackupFailedError, resetBook } from '../src/reset/book.ts';
import { longProse } from './helpers.ts';
import { clearProse, count, expectedCounts, SEEDED_STATE_VERSION } from './resetSeed.ts';
import { createResetHarness, stateVersionOf } from './resetApp.ts';

/**
 * BOOK-137 — the guards the reviewer's findings added around the wipe.
 *
 *   B1 — the snapshot counter is bumped, never reset: a page ignores a state whose version went
 *        backwards, so a restart at 1 would leave every open tab on the pre-launch book.
 *   B2 — the manuscript is the source of truth: a `chNN.md` that still holds prose is a written
 *        chapter the next boot scan would restore, so the reset refuses (and the frame slot has
 *        its own refusal when it is no longer the frozen sentence).
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

describe('BOOK-137 B2 — a manuscript that still holds prose', () => {
  it('reports the prose chapter on a dry run and refuses the wipe', async () => {
    const target = await h.live({ keepProse: true });
    const before = expectedCounts(target);

    const dry = await h.call({ dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().manuscript).toEqual({ proseChapters: 1 });

    const refused = await h.call({ dryRun: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'MANUSCRIPT_WRITTEN', files: ['ch08.md'] });
    // The remedy has to be one that clears the condition: engine-written chapters are
    // untracked, so `git checkout` would leave them in place and the operator would loop.
    expect(refused.json().message).toBe(
      'the manuscript holds 1 chapter file(s) whose prose a boot scan would restore; ' +
        'remove them from manuscript/ (untracked engine output: git clean -fd manuscript/; ' +
        'a committed chapter: git rm) and run the reset again',
    );
    expect(expectedCounts(target)).toEqual(before);
    expect(stateVersionOf(target.db)).toBe(SEEDED_STATE_VERSION);

    // Once the operator has removed the file, the same command goes through: the rows were
    // never the problem.
    clearProse(target);
    const ok = await h.call({ dryRun: false });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().dryRun).toBe(false);
    expect(count(target.db, 'SELECT COUNT(*) AS n FROM chapters WHERE basis = 0')).toBe(0);
  });

  it('judges the frame slots separately, and refuses one rewritten into prose', async () => {
    // ch01 is the frame: prose there is a canon problem (`FRAME_NOT_BASIS`), not a chapter a
    // boot scan would restore — and it is refused before the backup, so nothing is written.
    const target = await h.live({
      files: {
        'ch01.md': longProse(['Глава первая. Теперь это обычная глава, а не кадр.']),
        'ch42.md': FRAME_LAST_SENTENCE,
        'ch08.md': longProse(['Служебный абзац.']),
      },
    });
    const before = expectedCounts(target);

    const dry = await h.call({ dryRun: true });
    expect(dry.json().manuscript).toEqual({ proseChapters: 0 });

    const refused = await h.call({ dryRun: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'FRAME_NOT_BASIS' });
    expect(refused.json().message).toContain('ch01.md');
    expect(expectedCounts(target)).toEqual(before);
    expect(stateVersionOf(target.db)).toBe(SEEDED_STATE_VERSION);
  });

  it('keeps the frozen sentence when only the frame files are left', async () => {
    // The positive control for both refusals: two basis slots and nothing else is a clean book.
    const target = await h.live();
    const dry = await h.call({ dryRun: true });
    expect(dry.json().manuscript).toEqual({ proseChapters: 0 });

    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    const frame = target.db.prepare('SELECT n, block_count, basis FROM chapters ORDER BY n').all();
    expect(frame).toEqual([
      { n: 1, block_count: 1, basis: 1 },
      { n: 42, block_count: 1, basis: 1 },
    ]);
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
        bookRoot: target.root,
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

    const report = resetBook(target.db, { bookRoot: target.root, dataDir: target.dataDir, now, dryRun: false });
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
      keepProse: true,
      onBookReset: () => {
        calls += 1;
      },
    });
    await h.call({ dryRun: true });
    expect((await h.call({ dryRun: false })).statusCode).toBe(409);
    expect(calls).toBe(0);

    clearProse(target);
    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    expect(calls).toBe(1);
  });
});
