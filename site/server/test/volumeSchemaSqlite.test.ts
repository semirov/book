/**
 * BOOK-232 — `deploy.sh:volume_schema()` against the REAL `sqlite3`, in both states a rollback meets.
 *
 * The defect this file exists for: `deploy.sh` used to decide a rollback from a note, and the guard
 * that reads the volume reported `unknown` for a perfectly good WAL database — the state a rollback
 * exists for is exactly "cleanly closed", and a read-only open may not create the `-shm` that such a
 * database needs. `volume_schema` therefore retries the same PRAGMA with a plain open, which replays
 * the `-wal` the way the service's own open would; the fake `sqlite3` in `deployLaunchdHarness.ts`
 * answers by env var and hides that.
 *
 * So this file drives the shipped function text (sliced from `deploy.sh`, not a copy) with the box's
 * own `sqlite3`, on a database this test makes with better-sqlite3. Skipped when the tool is absent.
 *
 * Hermetic by construction: every case gets its own `mkdtempSync` directory, a database it writes with
 * a version of its own, and a guard that the path it reads really is under the OS temp dir — so no
 * leftover can masquerade as an answer and no case can ever resolve to a real volume.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { BASH, LIB } from './deployHarness.ts';
import { SITE_ROOT } from '../src/config.ts';

const hasSqlite = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;

/** Everything a case creates: dirs are removed after it, handles are closed first. */
const dirs: string[] = [];
const handles: Database.Database[] = [];

/**
 * The path guard: this class of test may only ever read throwaway files under the OS temp dir. A
 * fixture that resolved anywhere else would be a failure of the test, not of the code, so it throws.
 */
const underTemp = (path: string): string => {
  const resolved = realpathSync(path);
  expect(
    resolved.startsWith(realpathSync(tmpdir()) + sep),
    `${resolved} must live under the OS temp dir, not on a real volume`,
  ).toBe(true);
  return resolved;
};

/** A fresh empty data dir of this case's own, registered for removal and guarded before use. */
function scratchDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-232-sqlite-'));
  dirs.push(dataDir);
  return underTemp(dataDir);
}

/** A WAL `book.db` at `version` in a dir of this case's own; the handle stays open until the test closes it. */
function walDatabase(version: number): { db: Database.Database; dataDir: string } {
  const dataDir = scratchDir();
  const file = join(dataDir, 'book.db');
  const db = new Database(file);
  handles.push(db);
  db.pragma('journal_mode = WAL');
  db.pragma(`user_version = ${version}`);
  db.exec('create table if not exists t (x); insert into t values (1);');
  underTemp(file);
  return { db, dataDir };
}

afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

describe.skipIf(!hasSqlite)('BOOK-232: volume_schema with the real sqlite3', () => {
  it('answers while a handle holds the file (the state the service is in while it serves)', () => {
    const { dataDir } = walDatabase(29);
    expect(readSchema(dataDir)).toEqual({ code: 0, out: '29' });
  });

  it('answers just the same once the database is cleanly closed — the state a rollback exists for', () => {
    // Whether `sqlite3 -readonly <closed WAL db> 'PRAGMA user_version;'` answers is a property of the
    // CLI, not of our contract: the owner's mac (sqlite3 3.51) answers nothing (exit 14, "unable to
    // open database file") because a read-only open may not create the `-shm`, CI's Linux sqlite3
    // answers the version. So nothing about that premise is asserted here — the plain retry inside
    // `volume_schema`, which replays the `-wal` as the service's own open would, is what makes this
    // database answerable in both worlds.
    const { db, dataDir } = walDatabase(17);
    db.close();
    expect(readSchema(dataDir)).toEqual({ code: 0, out: '17' });
  });

  it('refuses a fixture path outside the OS temp dir — the guard fails loudly, not silently', () => {
    // The class this prevents: a future edit pointing a fixture at a real volume. The helper is the
    // only thing between "read a database" and "read the owner's data", so it is asserted here too.
    expect(() => underTemp(join(SITE_ROOT, 'deploy'))).toThrow(/must live under the OS temp dir/);
    expect(() => underTemp(join(SITE_ROOT, 'deploy', 'deploy.sh'))).toThrow(/must live under the OS temp dir/);
  });

  it('answers nothing for a missing database and never creates one', () => {
    const empty = scratchDir();
    expect(readSchema(empty)).toEqual({ code: 0, out: '' });
    expect(() => readFileSync(join(empty, 'book.db'))).toThrow();
  });

  it('answers nothing when the tool is not on PATH — a named refusal, not "the volume is broken"', () => {
    // A PATH with the two externals `volume_schema` uses and no `sqlite3`: the tool's absence is a
    // fact about the host, and the guard names it instead of recommending a restore over a good file.
    // The volume holds a file (any file — nothing here needs a readable database), so the guard gets
    // past its "is there a file at all" check and meets the missing tool, which is the branch under
    // test; an empty dir would answer nothing for the other reason and prove less.
    const bare = scratchDir();
    for (const tool of ['sed', 'head']) {
      const from = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      symlinkSync(from, join(bare, tool));
    }
    const volume = scratchDir();
    writeFileSync(join(volume, 'book.db'), 'not a database, and never opened\n', 'utf8');
    expect(readSchema(volume, bare)).toEqual({ code: 0, out: '' });
    // With the tool present the same file is still no answer, and still no crash.
    expect(readSchema(volume)).toEqual({ code: 0, out: '' });
    // A dir with no database at all answers the same way on that bare PATH: nothing to read, nothing made.
    const empty = scratchDir();
    expect(readSchema(empty, bare)).toEqual({ code: 0, out: '' });
    expect(() => readFileSync(join(empty, 'book.db'))).toThrow();
  });
});
