/**
 * BOOK-187 / ADR-043 §5 — the boot sequence, as both entrypoints run it.
 *
 * Five facts are pinned here, in the order the boot asserts them: a fresh volume is created at the
 * current version and seeded; a v22 volume is dumped (verified) before any DDL and upgraded; a
 * volume from a newer build refuses to start with `SCHEMA_FUTURE` and writes nothing; a dump that
 * cannot be verified refuses with `DUMP_FAILED` and the migration never runs; and the stamps and
 * `PROMPT_DRIFT` tell the truth about which bundle the volume was written under.
 *
 * Everything happens in a temp dir this file owns — the live data dir is production and is never
 * opened here (BOOK-107's isolation setup proves that after the run).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { BuildStamp } from '../src/buildStamp.ts';
import { BootRefusal, bootDatabase, bootFailureLine, dumpName, dumpStamp, pruneDumps } from '../src/db/boot.ts';
import { databaseFile, openDatabase, type Db } from '../src/db/db.ts';
import { getMeta } from '../src/db/repo/meta.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-boot-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AT = new Date('2026-10-28T14:02:10Z');

function stamp(overrides: Partial<BuildStamp> = {}): BuildStamp {
  return {
    commit: '5558449',
    builtAt: '2026-10-28T14:00:00.000Z',
    stamp: '28.10 17:00',
    promptBundleSha: 'a'.repeat(64),
    imageDigest: 'sha256:deadbeef',
    ...overrides,
  };
}

/** Boot with the clock and the log under the test's control; returns the lines the boot wrote. */
async function boot(
  dataDir: string,
  options: { buildInfo?: BuildStamp; now?: Date } = {},
): Promise<{ db: Db; lines: string[] }> {
  const lines: string[] = [];
  const db = await bootDatabase({
    dataDir,
    buildInfo: options.buildInfo ?? stamp(),
    now: () => options.now ?? AT,
    log: (line) => lines.push(line),
  });
  return { db, lines };
}

/** A temp volume that already holds a migrated database at `version`. */
function volumeAt(version: number): string {
  const dir = tempDir();
  const db = openDatabase(databaseFile(dir));
  migrate(db);
  db.prepare(
    `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
     VALUES (1, 2, 'Тестовая глава', 'abc', 10, 1, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
  ).run();
  if (version === 22) {
    db.exec('DROP TABLE book_frame');
    db.exec('DROP TABLE writer_state');
    db.exec('DROP TABLE pass_transcripts');
    db.exec('DROP TABLE block_deltas');
  }
  db.pragma(`user_version = ${String(version)}`);
  db.close();
  return dir;
}

function backupsOf(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'backups')).sort();
  } catch {
    return [];
  }
}

describe('bootDatabase — a fresh volume (BOOK-187)', () => {
  it('creates the schema at v28, seeds the frame and writes the stamps', async () => {
    const dataDir = tempDir();
    const { db } = await boot(dataDir);

    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS n FROM book_frame').get()).toEqual({ n: 2 });
    expect(getMeta(db, 'schema_version')).toBe(String(SCHEMA_VERSION));
    expect(getMeta(db, 'build_commit')).toBe('5558449');
    expect(getMeta(db, 'image_digest')).toBe('sha256:deadbeef');
    expect(getMeta(db, 'prompt_bundle')).toBe('a'.repeat(64));
    // A fresh install runs every step, so this boot did migrate — and says when.
    expect(getMeta(db, 'migrated_at')).toBe(AT.toISOString());
    expect(getMeta(db, 'booted_at')).toBe(AT.toISOString());
    expect(getMeta(db, 'prompt_drift')).toBeNull();
    // A fresh volume is still dumped before its first migration: the boot never writes DDL into a
    // file no copy of exists, even when that file holds nothing yet (ADR-043 G9).
    expect(backupsOf(dataDir)).toEqual([dumpName(0, AT)]);
    db.close();
  });

  it('records an absent image digest as the empty stamp, never as null', async () => {
    const dataDir = tempDir();
    const { db } = await boot(dataDir, { buildInfo: stamp({ imageDigest: null, promptBundleSha: null }) });
    expect(getMeta(db, 'image_digest')).toBe('');
    expect(getMeta(db, 'prompt_bundle')).toBeNull();
    db.close();
  });
});

describe('bootDatabase — a v22 volume (BOOK-187, ADR-043 §5)', () => {
  it('takes a verified dump before any DDL, then migrates and stamps the moment', async () => {
    const dataDir = volumeAt(22);
    const { db, lines } = await boot(dataDir);

    const dumps = backupsOf(dataDir);
    expect(dumps).toEqual([dumpName(22, AT)]);
    expect(dumpName(22, AT)).toMatch(/^pre-v22-\d{8}T\d{6}Z\.db$/u);

    // The dump is a real copy of the book as it was: the copy opens, reports v22 and holds the row.
    const copy = new Database(join(dataDir, 'backups', dumps[0]!), { readonly: true });
    expect(Number(copy.pragma('user_version', { simple: true }))).toBe(22);
    expect(copy.prepare('SELECT title FROM chapters WHERE n = 1').get()).toEqual({ title: 'Тестовая глава' });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();

    // Then the migration ran, and the frame is there.
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT text FROM book_frame WHERE chapter = 1').get()).toEqual({ text: FRAME_FIRST_SENTENCE });
    expect(db.prepare('SELECT text FROM book_frame WHERE chapter = 42').get()).toEqual({ text: FRAME_LAST_SENTENCE });
    expect(getMeta(db, 'migrated_at')).toBe(AT.toISOString());
    // The upgrade is what a fresh install would also produce: the same rows, unharmed.
    expect(db.prepare('SELECT title FROM chapters WHERE n = 1').get()).toEqual({ title: 'Тестовая глава' });
    expect(lines).toEqual([]);
    db.close();
  });

  it('does not dump, and does not re-date the migration, when it boots the same version again', async () => {
    const dataDir = volumeAt(22);
    const first = await boot(dataDir);
    first.db.close();

    const later = new Date('2026-10-29T09:00:00Z');
    const second = await boot(dataDir, { now: later });
    expect(backupsOf(dataDir)).toHaveLength(1);
    expect(getMeta(second.db, 'migrated_at')).toBe(AT.toISOString());
    expect(getMeta(second.db, 'booted_at')).toBe(later.toISOString());
    second.db.close();
  });

  it('keeps three dumps and prunes the older ones, only after a verified one', () => {
    const dataDir = tempDir();
    const dir = join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    // Five dumps, one day apart, written in name order; the newest three are the ones to keep.
    const names = [1, 2, 3, 4, 5].map((day) => `pre-v22-2026100${String(day)}T000000Z.db`);
    for (const [index, name] of names.entries()) {
      writeFileSync(join(dir, name), 'x', 'utf8');
      utimesSync(join(dir, name), new Date(2026, 9, index + 1), new Date(2026, 9, index + 1));
    }
    // A file that is not one of ours is never touched.
    writeFileSync(join(dir, 'keep-me.db'), 'x', 'utf8');

    // A data dir with no backups at all is not an error: there is nothing to keep.
    expect(pruneDumps(tempDir())).toEqual([]);
    expect(pruneDumps(dataDir)).toEqual(names.slice(0, 2));
    expect(backupsOf(dataDir)).toEqual(['keep-me.db', ...names.slice(2)]);
  });
});

describe('bootDatabase — refusing to start (ADR-043 §5)', () => {
  it('refuses a volume from a newer build, writes nothing, and keeps the version', async () => {
    const dataDir = tempDir();
    const db = openDatabase(databaseFile(dataDir));
    migrate(db);
    db.pragma(`user_version = ${String(SCHEMA_VERSION + 7)}`);
    const metaBefore = db.prepare('SELECT COUNT(*) AS n FROM meta').get();
    db.close();

    const refusal = await boot(dataDir).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(BootRefusal);
    expect((refusal as BootRefusal).code).toBe('SCHEMA_FUTURE');
    expect((refusal as BootRefusal).message).toContain(`v${String(SCHEMA_VERSION + 7)}`);
    expect((refusal as BootRefusal).message).toContain(`v${String(SCHEMA_VERSION)}`);
    expect(bootFailureLine(refusal)).toContain('boot refused (SCHEMA_FUTURE)');

    const after = new Database(databaseFile(dataDir), { readonly: true });
    // No DDL, no dump, no stamps: the volume is exactly as the newer build left it.
    expect(Number(after.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION + 7);
    expect(after.prepare('SELECT COUNT(*) AS n FROM meta').get()).toEqual(metaBefore);
    after.close();
    expect(backupsOf(dataDir)).toEqual([]);
  });

  it('refuses to migrate when the dump cannot be verified, and runs no DDL', async () => {
    const dataDir = volumeAt(22);
    // A regular file where the backups directory must be: the dump cannot even be written.
    writeFileSync(join(dataDir, 'backups'), 'not a directory\n', 'utf8');

    const refusal = await boot(dataDir).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(BootRefusal);
    expect((refusal as BootRefusal).code).toBe('DUMP_FAILED');

    const after = new Database(databaseFile(dataDir), { readonly: true });
    expect(Number(after.pragma('user_version', { simple: true }))).toBe(22);
    expect(after.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'book_frame'`).get()).toBeUndefined();
    after.close();
  });

  it('marks the refusal line only for a refusal', () => {
    expect(bootFailureLine(new Error('boom'))).toBeNull();
    expect(bootFailureLine(new BootRefusal('DUMP_FAILED', 'no copy'))).toBe('boot refused (DUMP_FAILED): no copy');
  });

  it('names the dump after the version it copies and the UTC second it was taken', () => {
    expect(dumpStamp(AT)).toBe('20261028T140210Z');
    expect(dumpName(22, AT)).toBe('pre-v22-20261028T140210Z.db');
  });
});

describe('bootDatabase — the prompt bundle (ADR-043 G3)', () => {
  it('records a drift instead of overwriting the bundle the volume was written under', async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir, { buildInfo: stamp({ promptBundleSha: 'a'.repeat(64) }) });
    first.db.close();

    const second = await boot(dataDir, { buildInfo: stamp({ promptBundleSha: 'b'.repeat(64) }) });
    expect(getMeta(second.db, 'prompt_bundle')).toBe('a'.repeat(64));
    expect(getMeta(second.db, 'prompt_drift')).toBe('b'.repeat(64));
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toContain('PROMPT_DRIFT');
    expect(second.lines[0]).toContain('b'.repeat(64));
    second.db.close();

    // The same rollback shown twice is still one fact, not a growing record.
    const third = await boot(dataDir, { buildInfo: stamp({ promptBundleSha: 'b'.repeat(64) }) });
    expect(getMeta(third.db, 'prompt_drift')).toBe('b'.repeat(64));
    third.db.close();
  });

  it('clears the drift when the recorded bundle is the one the image carries again', async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir, { buildInfo: stamp({ promptBundleSha: 'a'.repeat(64) }) });
    first.db.close();
    const drifted = await boot(dataDir, { buildInfo: stamp({ promptBundleSha: 'b'.repeat(64) }) });
    drifted.db.close();

    const back = await boot(dataDir, { buildInfo: stamp({ promptBundleSha: 'a'.repeat(64) }) });
    expect(getMeta(back.db, 'prompt_bundle')).toBe('a'.repeat(64));
    expect(getMeta(back.db, 'prompt_drift')).toBeNull();
    expect(back.lines).toEqual([]);
    back.db.close();
  });

  it('writes the bundle of an older volume that has none, and the drift is not invented', async () => {
    const dataDir = volumeAt(22);
    const { db } = await boot(dataDir, { buildInfo: stamp({ promptBundleSha: 'c'.repeat(64) }) });
    expect(getMeta(db, 'prompt_bundle')).toBe('c'.repeat(64));
    expect(getMeta(db, 'prompt_drift')).toBeNull();
    db.close();
  });
});

describe('the entrypoints — a refusal is one line and exit 1 (ADR-043 §5)', () => {
  /** A volume from a newer build, and the env both entrypoints need to reach the refusal. */
  function futureVolume(): { dataDir: string; webDist: string } {
    const dataDir = tempDir();
    const db = openDatabase(databaseFile(dataDir));
    migrate(db);
    db.pragma(`user_version = ${String(SCHEMA_VERSION + 7)}`);
    db.close();
    const webDist = tempDir();
    writeFileSync(join(webDist, 'index.html'), '<!doctype html>', 'utf8');
    return { dataDir, webDist };
  }

  for (const entry of ['index.ts', 'engine.ts']) {
    it(`${entry} refuses to start: exit 1, one stderr line naming the code and both versions`, () => {
      const { dataDir, webDist } = futureVolume();
      const child = spawnSync(process.execPath, ['--import', 'tsx', join('server', 'src', entry)], {
        cwd: resolve(import.meta.dirname, '..', '..'),
        encoding: 'utf8',
        env: { ...process.env, DATA_DIR: dataDir, WEB_DIST: webDist, PORT: '8791', ENGINE_PORT: '8792' },
        // A refusal that regressed into listening would never exit: the bound is the test's.
        timeout: 30_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      const lines = child.stderr.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('boot refused (SCHEMA_FUTURE)');
      expect(lines[0]).toContain(`v${String(SCHEMA_VERSION + 7)}`);
      expect(lines[0]).toContain(`v${String(SCHEMA_VERSION)}`);
      expect(lines[0]).toContain(dataDir);
      // Nothing was written on the way out: no copy, no migration.
      expect(backupsOf(dataDir)).toEqual([]);
    });
  }
});

describe('bootDatabase — the boot is idempotent on the volume it served', () => {
  it('leaves one connection’s worth of state, and no second row anywhere', async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir);
    first.db.close();

    const second = await boot(dataDir);
    const meta = second.db.prepare('SELECT k FROM meta ORDER BY k').all() as Array<{ k: string }>;
    // One row per stamp, despite two boots: `setMeta` upserts, it does not append.
    expect(new Set(meta.map((row) => row.k)).size).toBe(meta.length);
    second.db.close();
  });
});
