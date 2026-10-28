/**
 * BOOK-175 — the SQLite version is a floor, not a detail.
 *
 * 3.51.3 is the release that fixes the WAL-reset corruption bug. We run exactly the shape that
 * bug needs: four writer processes (site, engine, writer lane, admin CLI) on one `book.db`, all
 * in WAL. `better-sqlite3` bundles the amalgamation, so a driver downgrade — or a stale cached
 * native build — silently moves the engine under us.
 *
 * The version is read from the **connection** `openDatabase()` returns, never from package
 * metadata: the tarball can say one thing while a binary built from another source is what
 * actually executes. Only `sqlite_version()` answers for the amalgamation in the process.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';

/** The first SQLite that fixes the WAL-reset corruption bug. Not a version to drift from. */
const WAL_RESET_FIXED = '3.51.3';

const open: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): Db {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-sqlite-version-'));
  dirs.push(dataDir);
  const db = openDatabase(databaseFile(dataDir));
  open.push(db);
  return db;
}

/** `3.53.4` → `[3, 53, 4]`; anything else is a shape this guard refuses to guess at. */
function triple(version: string): [number, number, number] {
  const parts = version.split('-')[0]!.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`sqlite_version() returned an unparseable string: ${JSON.stringify(version)}`);
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

/** The comparison is inline on purpose: a test-only version guard must not need a dependency. */
function atLeast(version: string, floor: string): boolean {
  const [major, minor, patch] = triple(version);
  const [wantMajor, wantMinor, wantPatch] = triple(floor);
  if (major !== wantMajor) return major > wantMajor;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
}

describe('BOOK-175 — the bundled SQLite never falls below the WAL-reset fix', () => {
  it('reports a runtime sqlite_version() at or above 3.51.3', () => {
    const db = fixture();
    const version = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    expect(
      atLeast(version.version, WAL_RESET_FIXED),
      `sqlite_version() is ${version.version}, below ${WAL_RESET_FIXED}: the WAL-reset corruption fix is missing, ` +
        'so four writer processes on one book.db can corrupt it — bump better-sqlite3, do not pin it back',
    ).toBe(true);
  });

  it('runs in WAL, which is the mode that fix is about', () => {
    const db = fixture();
    // A guard whose premise is WAL is worthless if the connection is not in WAL.
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('the guard itself is honest: it rejects the versions before the fix', () => {
    expect(atLeast('3.51.2', WAL_RESET_FIXED)).toBe(false);
    expect(atLeast('3.46.1', WAL_RESET_FIXED)).toBe(false);
    expect(atLeast('2.99.99', WAL_RESET_FIXED)).toBe(false);
    expect(atLeast(WAL_RESET_FIXED, WAL_RESET_FIXED)).toBe(true);
    expect(atLeast('3.51.10', WAL_RESET_FIXED)).toBe(true);
    // The comparison is numeric per component, not lexicographic: `3.9.0` is older than `3.51.0`.
    expect(atLeast('3.9.0', '3.51.0')).toBe(false);
  });
});
