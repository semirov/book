/**
 * One volume, two guards, one list — and this file is the guard of the guard.
 *
 * BOOK-187 shipped two allow-lists: `server/src/dataHome.ts` (read by `bin/home-check.mjs` before a
 * deploy) and a private copy in `server/src/doctor/inspect.ts` (read by `node bin/admin.mjs doctor`
 * on the host). The live volume's `.book-volume` was a marker to the first and a stray to the
 * second, so the preflight failed on a volume that was exactly right. The doctor now imports the
 * list; these tests keep it that way — behaviourally (the two answers must name the same paths on
 * one tree) and literally (no allow-list constant may reappear in the doctor's source).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';
import { DENIED_PATHS, absoluteOf, checkDataHome } from '../src/dataHome.ts';
import { inspectDataDir } from '../src/doctor/inspect.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function touch(dir: string, rel: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '', 'utf8');
}

function dirOf(dir: string, rel: string): void {
  mkdirSync(join(dir, rel), { recursive: true });
}

/**
 * One temp tree holding one entry of every family the volume knows: each allowed file, each
 * allowed directory, the marker in `marker` shape, a stray file, a dropped directory and a stray
 * nested inside one. `writer/state.json` is there too — it is `denied`, not `stray`.
 */
function volume(marker: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'book-home-shared-'));
  roots.push(root);
  const data = join(root, 'data');
  const book = join(root, 'manuscript');
  mkdirSync(data, { recursive: true });
  mkdirSync(book, { recursive: true });
  for (const name of [
    'book.db',
    'book.db-wal',
    'book.db-shm',
    'admin.token',
    'engine.token',
    'book-before-20261028T120000Z.db',
    'book-reset-20261028T120000Z.db',
    'book-reset-20261028T120000Z-1.db',
    'cover.png',
    'notes.txt',
    'logs/.keep',
    'tmp/a.json',
  ]) {
    touch(data, name);
  }
  for (const name of ['backups', 'backup', 'archive', 'versions', 'index', 'exchange']) dirOf(data, name);
  for (const name of [
    'backups/pre-v22-20261028T140210Z.db',
    'backup/pre-v21.db',
    'archive/ch01.md.old',
    'versions/ab/abcdef.md',
    'index/slices/ch08.json',
    'exchange/feedback/bat_one.jsonl',
    'writer/state.json',
  ]) {
    touch(data, name);
  }
  if (marker !== null) writeFileSync(join(data, '.book-volume'), marker, 'utf8');
  return data;
}

/** What the deploy guard refuses, as absolute paths. */
function homeRefused(data: string): string[] {
  return checkDataHome({ dataDir: data, manuscriptDir: join(data, '..', 'manuscript') })
    .problems.filter((problem) => problem.code === 'NOT_ALLOWED')
    .map((problem) => problem.path);
}

describe('the two guards agree path for path', () => {
  it('names the same stray set for a volume whose marker is the named shape', () => {
    const data = volume('book-volume 1\nschema=28\n');
    expect(homeRefused(data)).toEqual([join(data, 'logs'), join(data, 'notes.txt'), join(data, 'tmp')]);
    expect(inspectDataDir(data).stray).toEqual(homeRefused(data));
  });

  it('accepts the live legacy marker on both sides, and refuses a foreign file on both', () => {
    // The live volume's marker, and the defect: the doctor used to call it a stray.
    const legacy = volume('28\n');
    expect(homeRefused(legacy)).toEqual([join(legacy, 'logs'), join(legacy, 'notes.txt'), join(legacy, 'tmp')]);
    expect(inspectDataDir(legacy).stray).toEqual(homeRefused(legacy));

    const foreign = volume('hello\n');
    expect(homeRefused(foreign)).toEqual([
      join(foreign, '.book-volume'),
      join(foreign, 'logs'),
      join(foreign, 'notes.txt'),
      join(foreign, 'tmp'),
    ]);
    expect(inspectDataDir(foreign).stray).toEqual(homeRefused(foreign));
  });

  it('sorts and de-duplicates identically, whatever the listing found first', () => {
    const data = volume('book-volume 1\nschema=28\n');
    const stray = inspectDataDir(data).stray;
    expect(stray).toEqual([...stray].sort());
    expect(homeRefused(data).length).toBe(new Set(homeRefused(data)).size);
  });

  it('reports `writer/state.json` as denied on both sides, never as a stray', () => {
    const data = volume('book-volume 1\nschema=28\n');
    const report = checkDataHome({ dataDir: data, manuscriptDir: join(data, '..', 'manuscript') });
    const denied = DENIED_PATHS.map((rel) => absoluteOf(data, rel));
    const homeWriter = report.problems.filter((problem) => problem.code === 'WRITER_LEFTOVER').map((problem) => problem.path);
    // The doctor names the file itself in `denied`; the deploy guard also names `writer/` — an
    // entry the doctor excludes from `stray` by contract. Both agree it is not an allowed name.
    expect(homeWriter).toContain(absoluteOf(data, 'writer/state.json'));
    expect(homeWriter.filter((path) => denied.includes(path))).toEqual([absoluteOf(data, 'writer/state.json')]);
    expect(inspectDataDir(data).denied).toEqual(['writer/state.json']);
    expect(inspectDataDir(data).stray).not.toContain(absoluteOf(data, 'writer'));
  });

  it('reports an empty `writer/` as denied on both sides — the volume is not clean', () => {
    // No `writer/state.json`, none of `pre/` or `transcripts/`: the directory itself is the
    // leftover, and the doctor used to call this volume `data dir clean` while the deploy gate
    // refused it (BOOK-187 review). Both sides must now state the same fact.
    const data = volume('book-volume 1\nschema=28\n');
    rmSync(join(data, 'writer', 'state.json'));

    const report = checkDataHome({ dataDir: data, manuscriptDir: join(data, '..', 'manuscript') });
    const homeWriter = report.problems.filter((problem) => problem.code === 'WRITER_LEFTOVER').map((problem) => problem.path);
    expect(homeWriter).toEqual([absoluteOf(data, 'writer')]);

    const doctor = inspectDataDir(data);
    expect(doctor.denied).toEqual(['writer']);
    expect(doctor.stray).not.toContain(absoluteOf(data, 'writer'));
    // The two call sites on this tree: every writer path the guard names is exactly what the
    // doctor refuses, and the stray sets still agree.
    expect(homeWriter.map((path) => relative(data, path))).toEqual(doctor.denied);
    expect(doctor.stray).toEqual(homeRefused(data));
  });
});

describe('the doctor does not own a list', () => {
  const source = (): string => readFileSync(join(SITE_ROOT, 'server', 'src', 'doctor', 'inspect.ts'), 'utf8');

  it('imports the classifier and the denied paths from the one module', () => {
    const code = source();
    expect(code, 'the allow-list lives in server/src/dataHome.ts — import it, never copy it').toContain(
      "from '../dataHome.ts'",
    );
    expect(code).toContain('classifyDataEntry');
    expect(code).toContain('DENIED_PATHS');
  });

  it('carries none of the copied list names — a second copy is a red test', () => {
    const code = source();
    for (const literal of ['ALLOWED_FILES', 'ALLOWED_DIRS', 'ALLOWED_FILE_PATTERNS', 'allowedEntry']) {
      expect(code, `${literal} belongs to server/src/dataHome.ts; the doctor imports, never copies`).not.toContain(literal);
    }
  });
});
