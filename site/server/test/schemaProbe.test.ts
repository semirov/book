/**
 * BOOK-232 — the volume probe's own program, run against a real database.
 *
 * The review found the class of defect this file exists for: the probe shipped
 * `const{default:D}=require("better-sqlite3")`, but that package's `module.exports` IS the
 * constructor (there is no `.default`), so `new D(...)` threw "D is not a constructor", the one-shot
 * exited 1, the deploy swallowed it and fell back to `/healthz` — the probe could never succeed. A
 * fake `docker` answers such a probe on its marker alone and hides the whole class, so this test does
 * not ask the fake anything: it extracts `SCHEMA_PROBE_JS` from the script (the exact text the
 * release passes to `node -e`) and runs it against a temporary WAL database on this box.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'book-232-probe-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The program the release runs, taken from the script itself — not a copy of it. */
const program = ((): string => {
  const script = readFileSync(join(SITE_ROOT, 'deploy', 'compose-release.sh'), 'utf8');
  const found = /^SCHEMA_PROBE_JS='([^']+)'$/mu.exec(script);
  expect(found, 'compose-release.sh defines SCHEMA_PROBE_JS as one single-quoted line').not.toBeNull();
  return found?.[1] ?? '';
})();

/** What the site image does: `node -e "$SCHEMA_PROBE_JS" /data/book.db`, here pointed at a temp file. */
const probe = (file: string): { status: number | null; out: string } => {
  const child = spawnSync(process.execPath, ['-e', program, file], { encoding: 'utf8' });
  return { status: child.status, out: `${child.stdout}${child.stderr}` };
};

describe('BOOK-232: the volume probe reads a real database', () => {
  it('prints BOOK_SCHEMA=<user_version> for a WAL database with a live writer on it', () => {
    const file = join(dir, 'live.db');
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');
    writer.pragma('user_version = 33');
    writer.exec('create table if not exists t (x); insert into t values (1);');
    // The writer stays open on purpose: this is the state the deploy meets — the stack is serving and
    // the WAL has not been checkpointed. A read-only open must still answer the file's version.
    const result = probe(file);
    expect(result.out.trim(), result.out).toBe('BOOK_SCHEMA=33');
    expect(result.status, result.out).toBe(0);
    writer.close();
  });

  it('is a failure, not a 0, when the file is not there — the caller treats that as `unknown`', () => {
    const result = probe(join(dir, 'missing.db'));
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).not.toContain('BOOK_SCHEMA=');
    expect(result.out).toContain('unable to open database file');
  });

  it('is the text the release actually passes: one variable, no copy in the caller', () => {
    const script = readFileSync(join(SITE_ROOT, 'deploy', 'compose-release.sh'), 'utf8');
    // `-e "$SCHEMA_PROBE_JS" /data/book.db` — the program and the path as one argv, so what this file
    // ran is what a deploy runs.
    expect(script).toContain('-e "$SCHEMA_PROBE_JS" /data/book.db');
    // The package exports the constructor itself; a destructured `.default` is the defect above.
    expect(program).toContain('require("better-sqlite3")');
    expect(program).not.toContain('.default');
    expect(program).toContain('readonly:true,fileMustExist:true');
  });
});
