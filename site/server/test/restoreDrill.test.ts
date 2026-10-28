/**
 * BOOK-183 — `deploy/restore-drill.sh`: restore the newest backup and prove it is the live state.
 *
 * The drill's whole point is *where* it reads from. The restored copy is opened on the host — it is a
 * copy, nothing else owns it — but the live `book.db` is read only INSIDE a container on the data
 * volume, because since BOOK-183 the live store is a named volume and a host read across the
 * macOS/OrbStack boundary is the two-kernel hazard. So a `runtime=launchd` box refuses rather than
 * opening it, and that refusal is the case below that proves it never falls back to the host.
 *
 * A fake `docker` answers the volume reads from the environment (the live numbers), the backup is a
 * real SQLite file this test builds, and everything lives in temp dirs: no live path, no real docker,
 * no `/data`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_DIR = resolve(import.meta.dirname, '..', '..', 'deploy');
/** The script is `#!/usr/bin/env bash`; the same override `deployHarness.ts` uses. */
const BASH = process.env.BOOK_TEST_BASH ?? '/bin/bash';

/** The drill needs both: a host `sqlite3` for the copy, `shasum` for the version hashes. */
const HAS_SQLITE3 = spawnSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).status === 0;
const HAS_SHASUM = spawnSync('sh', ['-c', 'command -v shasum'], { encoding: 'utf8' }).status === 0;

/**
 * The counts line, in the order `restore-drill.sh`'s `COUNTS_SQL` produces — the two lines are compared
 * as strings, so the order is part of the contract.
 */
const countsFor = (chapters: number): string =>
  `chapters=${String(chapters)} events=2 comments=1 changes=1 identities=1 blocks=2 revisions=1`;

const FAKE_DOCKER = `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$CALLS"
case "$*" in
  *"volume inspect"*) [ "\${FAKE_VOLUME_MISSING:-0}" = "1" ] && exit 1; exit 0 ;;
  *"test -f /vol/book.db"*) [ "\${FAKE_VOLUME_MISSING:-0}" = "1" ] && exit 1; exit 0 ;;
  # The live DB, read by a container on the volume: the numbers the comparison is made against.
  *"--entrypoint node"*) printf '%s\\n' "\${FAKE_LIVE_COUNTS:-}"; exit "\${FAKE_COUNTS_EXIT:-0}" ;;
  # The live versions/, hashed inside the container with sha256sum.
  *sha256sum*) printf '%s\\n' "\${FAKE_LIVE_HASHES:-}"; exit "\${FAKE_VERSIONS_EXIT:-0}" ;;
esac
exit 0
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type World = {
  script: string;
  backup: string;
  logFile: string;
  calls: string;
  /** The hash the container reports for the one snapshot in the backup. */
  hash: string;
  env: Record<string, string>;
};

/** One backup, one fake runtime, one log — nothing that can reach a real path. */
function world(options: { runtime?: string } = {}): World {
  const dir = temp('book-183-drill-');
  const deploy = join(dir, 'deploy');
  const stateDir = join(dir, 'state');
  const backupRoot = join(dir, 'backups');
  const backup = join(backupRoot, 'daily', '20261028T040000');
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls.log');
  const logFile = join(dir, 'drill.log');
  for (const path of [deploy, stateDir, backup, join(backup, 'versions', 'ch01'), bin]) {
    mkdirSync(path, { recursive: true });
  }
  symlinkSync(join(SCRIPT_DIR, 'restore-drill.sh'), join(deploy, 'restore-drill.sh'));
  writeFileSync(calls, '', 'utf8');
  writeFileSync(logFile, '', { encoding: 'utf8', mode: 0o600 });
  if (options.runtime !== undefined) writeFileSync(join(stateDir, 'runtime'), `${options.runtime}\n`, 'utf8');

  const snapshot = '# глава первая\n';
  writeFileSync(join(backup, 'versions', 'ch01', 'rev1.md'), snapshot, 'utf8');
  const hash = createHash('sha256').update(snapshot).digest('hex');

  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { encoding: 'utf8', mode: 0o755 });

  return {
    script: join(deploy, 'restore-drill.sh'),
    backup,
    logFile,
    calls,
    hash,
    env: {
      BOOK_STATE_DIR: stateDir,
      BOOK_DATA_VOLUME: 'book-data',
      BOOK_IMAGE_TAG: 'stub:1',
      BOOK_DOCKER: join(bin, 'docker'),
      BACKUP_ROOT: backupRoot,
      LOG_FILE: logFile,
      HOME: dir,
      TMPDIR: dir,
      CALLS: calls,
      FAKE_LIVE_COUNTS: countsFor(3),
      // `sha256sum` and `shasum` print the same shape: `<hash>  ./chapter/rev.md`.
      FAKE_LIVE_HASHES: `${hash}  ./ch01/rev1.md`,
    },
  };
}

/** The backup's own database, with exactly the tables `COUNTS_SQL` counts. Built lazily: the launchd
 * case must pass on a box without `sqlite3`, because it never gets as far as reading a copy. */
function backupDb(w: World): void {
  if (!HAS_SQLITE3) throw new Error('sqlite3 is not on PATH: a real restored copy cannot be fixtured');
  spawnSync(
    'sqlite3',
    [
      join(w.backup, 'book.db'),
      `CREATE TABLE chapters(n INTEGER); CREATE TABLE events(n INTEGER); CREATE TABLE comments(n INTEGER);
       CREATE TABLE changes(n INTEGER); CREATE TABLE identities(n INTEGER); CREATE TABLE blocks(n INTEGER);
       CREATE TABLE revisions(n INTEGER);
       WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 3) INSERT INTO chapters SELECT n FROM c;
       WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 2) INSERT INTO events SELECT n FROM c;
       INSERT INTO comments VALUES (1); INSERT INTO changes VALUES (1); INSERT INTO identities VALUES (1);
       WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 2) INSERT INTO blocks SELECT n FROM c;
       INSERT INTO revisions VALUES (1);`,
    ],
    { encoding: 'utf8' },
  );
}

type Run = { status: number; stdout: string; stderr: string };

/** The drill as cron runs it: a real process, its own world, nothing ambient. */
function drill(w: World, args: string[] = [], extra: Record<string, string> = {}): Run {
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const name of Object.keys(base)) if (name.startsWith('BOOK_')) delete base[name];
  const result = spawnSync(BASH, [w.script, ...args], {
    encoding: 'utf8',
    env: { ...base, ...w.env, ...extra },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const callsOf = (w: World): string[] =>
  readFileSync(w.calls, 'utf8')
    .split('\n')
    .filter((line) => line !== '');

describe('restore-drill.sh (BOOK-183)', () => {
  it('refuses on a launchd box: the live DB is never opened from the host', () => {
    const w = world({ runtime: 'launchd' });
    const result = drill(w);

    expect(result.status).toBe(1);
    // The sentence that names the rule, and the refusal to fall back to a host read.
    expect(result.stderr).toContain('the drill reads it only through a container (BOOK-183)');
    expect(result.stderr).toContain('it will not open book.db from the host');
    expect(result.stderr).toContain('runtime=launchd');
    // Not one docker call: the refusal is before the image, the volume or the backup is touched.
    expect(callsOf(w)).toEqual([]);
    expect(readFileSync(w.logFile, 'utf8')).toContain('status=fail');
  });

  it('refuses with no runtime file too: an unknown runtime is not a container runtime', () => {
    // No file means the box predates the volume, so its live DB is a host path: the drill refuses
    // rather than guessing, and reads nothing at all.
    const w = world();
    const result = drill(w);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime=launchd: the live DB is a host path');
    expect(result.stderr).toContain('it will not open book.db from the host');
    expect(callsOf(w)).toEqual([]);
  });

  it('compose: no data volume is a refusal, before any container read', () => {
    const w = world({ runtime: 'compose' });
    const result = drill(w, [], { FAKE_VOLUME_MISSING: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no data volume book-data');
    expect(callsOf(w).filter((line) => line.includes('--entrypoint node'))).toEqual([]);
  });

  it.skipIf(!HAS_SQLITE3 || !HAS_SHASUM)('compose: a matching backup is proved against the live volume', () => {
    const w = world({ runtime: 'compose' });
    backupDb(w);
    const result = drill(w);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('drill: ok — the backup restores and matches the live state.');
    // The live side was read inside a container on the volume, and the numbers agree by name.
    expect(result.stdout).toContain('live_read=volume=book-data image=stub:1 (inside a container)');
    expect(result.stdout).toContain(`counts_backup: ${countsFor(3)}`);
    expect(result.stdout).toContain(`counts_live:   ${countsFor(3)}`);
    expect(result.stdout).toContain('identical_files=1 leftover_in_backup=0');
    const calls = callsOf(w);
    expect(calls.filter((line) => line.includes('--entrypoint node'))).toHaveLength(1);
    expect(calls.some((line) => line.includes('-v book-data:/vol'))).toBe(true);
    expect(readFileSync(w.logFile, 'utf8')).toContain('status=ok');

    // The scratch copy is removed: a drill leaves no restored database behind.
    const scratch = /restored_to=(\S+)/u.exec(result.stdout)?.[1] ?? '';
    expect(scratch).not.toBe('');
    expect(existsSync(scratch)).toBe(false);
  });

  it.skipIf(!HAS_SQLITE3 || !HAS_SHASUM)('compose: a mismatch is exit 1 and names both counts', () => {
    const w = world({ runtime: 'compose' });
    backupDb(w);
    const result = drill(w, [], { FAKE_LIVE_COUNTS: countsFor(4) });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('counts or versions disagree with the live state');
    // Both sides are printed and logged, so the operator sees which number moved.
    expect(result.stdout).toContain(`counts_backup: ${countsFor(3)}`);
    expect(result.stdout).toContain(`counts_live:   ${countsFor(4)}`);
    const log = readFileSync(w.logFile, 'utf8');
    expect(log).toContain(`counts_backup="${countsFor(3)}"`);
    expect(log).toContain(`counts_live="${countsFor(4)}"`);
    expect(log).toContain('status=fail');
  });

  it.skipIf(!HAS_SQLITE3 || !HAS_SHASUM)('compose: a snapshot the live store no longer holds is a failure', () => {
    const w = world({ runtime: 'compose' });
    backupDb(w);
    const result = drill(w, [], { FAKE_LIVE_HASHES: `${'0'.repeat(64)}  ./ch01/rev1.md` });

    expect(result.status).toBe(1);
    // Same count, different bytes: the version proof is not the file count alone.
    expect(result.stdout).toContain('versions_backup=1 versions_live=1 identical_files=0 leftover_in_backup=1');
    expect(result.stderr).toContain('counts or versions disagree with the live state');
  });

  it('refuses an argument it does not know, before reading anything', () => {
    const w = world({ runtime: 'compose' });
    const result = drill(w, ['--nope']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument: --nope');
    expect(callsOf(w)).toEqual([]);
  });
});
