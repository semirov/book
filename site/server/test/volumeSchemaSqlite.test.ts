/**
 * BOOK-232 — `deploy.sh:volume_schema()` against the REAL `sqlite3`, in both states a rollback meets.
 *
 * The re-review measured the defect this file exists for: `sqlite3 -readonly book.db 'PRAGMA
 * user_version;'` answers 33 while a process holds the file, and answers NOTHING (`Error: stepping,
 * unable to open database file (14)`, exit 14) once the database is cleanly closed — a read-only open
 * may not create the `-shm` a WAL database needs. That is exactly the state a rollback exists for (the
 * service is down), so the guard reported `unknown` for a perfectly good volume and its message pointed
 * at restoring a dump. The fake `sqlite3` in `deployLaunchdHarness.ts` answers by env var and hid it.
 *
 * So this file drives the shipped function text (sliced from `deploy.sh`, not a copy) with the box's
 * own `sqlite3`, on a database this test makes with better-sqlite3. Skipped when the tool is absent.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import { BASH, LIB } from './deployHarness.ts';
import { SITE_ROOT } from '../src/config.ts';

const hasSqlite = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;

const dir = mkdtempSync(join(tmpdir(), 'book-232-sqlite-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The shipped function, exactly as `deploy.sh` defines it — read from the script, not retyped. */
const functions = ((): string => {
  const script = readFileSync(join(SITE_ROOT, 'deploy', 'deploy.sh'), 'utf8');
  const start = script.indexOf('sqlite3_tool() {');
  const end = script.indexOf('# The guard `--rollback` runs before anything');
  expect(start, 'deploy.sh defines sqlite3_tool and volume_schema').toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
})();

/** One run of `volume_schema <dir>` in bash with the lib sourced; `path` overrides PATH. */
const readSchema = (dataDir: string, path?: string): { code: number | null; out: string } => {
  const script = `set -euo pipefail\n. "${LIB}"\n${functions}\nvolume_schema "$1"\n`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  if (path !== undefined) env.PATH = path;
  const child = spawnSync(BASH, ['-c', script, 'probe', dataDir], { encoding: 'utf8', env });
  return { code: child.status, out: child.stdout.trim() };
};

/** A v33 WAL `book.db` in its own data dir, as the writer lane leaves it; the handle stays open. */
function walDatabase(name: string): { db: Database.Database; dataDir: string } {
  const dataDir = join(dir, name);
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'book.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('user_version = 33');
  db.exec('create table if not exists t (x); insert into t values (1);');
  return { db, dataDir };
}

describe.skipIf(!hasSqlite)('BOOK-232: volume_schema with the real sqlite3', () => {
  it('answers while a handle holds the file (the state the service is in while it serves)', () => {
    const { db, dataDir } = walDatabase('held');
    expect(readSchema(dataDir)).toEqual({ code: 0, out: '33' });
    db.close();
  });

  it('answers just the same once the database is cleanly closed — the state a rollback exists for', () => {
    // The measured defect: `sqlite3 -readonly` answers nothing here (exit 14). The plain retry, which
    // replays the WAL as the service's own open would, is what makes this 33 and not `unknown`.
    const { db, dataDir } = walDatabase('closed');
    const file = join(dataDir, 'book.db');
    db.close();
    // The tool really cannot do it read-only: the test's premise, stated rather than assumed.
    const readonly = spawnSync('sqlite3', ['-readonly', file, 'PRAGMA user_version;'], { encoding: 'utf8' });
    expect(readonly.stdout.trim(), `readonly answered ${readonly.stdout} / ${readonly.stderr}`).toBe('');
    expect(readonly.status).not.toBe(0);

    expect(readSchema(dataDir)).toEqual({ code: 0, out: '33' });
    // A plain open leaves the empty `-wal`/`-shm` the next boot expects; neither is an error.
    expect(existsSync(join(dataDir, 'book.db-wal'))).toBe(true);
  });

  it('answers nothing for a missing database and never creates one', () => {
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    expect(readSchema(empty)).toEqual({ code: 0, out: '' });
    expect(existsSync(join(empty, 'book.db'))).toBe(false);
  });

  it('answers nothing when the tool is not on PATH — a named refusal, not "the volume is broken"', () => {
    // A PATH with the two externals `volume_schema` uses and no `sqlite3`: the tool's absence is a
    // fact about the host, and the guard names it instead of recommending a restore over a good file.
    const bare = join(dir, 'bare-bin');
    mkdirSync(bare);
    for (const tool of ['sed', 'head']) {
      const from = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      symlinkSync(from, join(bare, tool));
    }
    const { db, dataDir } = walDatabase('no-tool');
    db.close();
    expect(readSchema(dataDir, bare)).toEqual({ code: 0, out: '' });
  });
});
