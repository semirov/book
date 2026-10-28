/**
 * BOOK-187 AC12 — the guard that names the path.
 *
 * Three rules, and the failure mode each one catches is silent: a second copy of the prose back
 * under `manuscript/`, the writer's state or its transcripts reappearing beside the database, a
 * scratch file landing in the volume where every backup will copy it forever. So every test here
 * asserts the **absolute path** in the message, not just that something failed.
 *
 * The checks are pure over injectable listings (`dataHomeProblems`), so most cases need no
 * filesystem; the walker and the CLI's own answer are proven on a real temp tree.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';

import {
  DATA_ALLOW,
  DATA_ALLOW_DIRS,
  checkDataHome,
  dataHomeProblems,
  readHome,
  type HomeEntry,
} from '../src/dataHome.ts';

const DATA = '/data';
const BOOK = '/repo/manuscript';

/** A listing from paths: anything ending in `/` is a directory. */
function listing(paths: string[]): HomeEntry[] {
  return paths.map((path) =>
    path.endsWith('/') ? { rel: path.slice(0, -1), directory: true } : { rel: path, directory: false },
  );
}

function problems(data: string[], manuscript: string[] = []) {
  return dataHomeProblems({
    dataDir: DATA,
    manuscriptDir: BOOK,
    data: listing(data),
    manuscript: listing(manuscript),
  });
}

describe('rule a — manuscript/ holds no prose', () => {
  it('fails on a chapter, a markdown file and a text file, naming each absolute path', () => {
    const found = problems([], ['ch08.md', 'notes.md', 'draft.txt']);
    expect(found.map((problem) => problem.code)).toEqual(['PROSE_IN_GIT', 'PROSE_IN_GIT', 'PROSE_IN_GIT']);
    expect(found.map((problem) => problem.path)).toEqual([
      `${BOOK}/ch08.md`,
      `${BOOK}/draft.txt`,
      `${BOOK}/notes.md`,
    ]);
    for (const problem of found) expect(problem.message).toContain(problem.path);
  });

  it('names a `chNN.*` file whatever its extension, and a nested one by its own path', () => {
    const found = problems([], ['ch12.bak', 'archive/ch05.md']);
    expect(found.map((problem) => problem.path)).toEqual([`${BOOK}/archive/ch05.md`, `${BOOK}/ch12.bak`]);
  });

  it('passes an absent or empty directory, and leaves non-prose files alone', () => {
    expect(problems([], [])).toEqual([]);
    expect(problems([], ['.DS_Store', 'archive/'])).toEqual([]);
  });
});

describe('rule b — the writer owns no file', () => {
  it('fails on state.json, pre/ and transcripts/, naming the path', () => {
    const found = problems([
      'book.db',
      'writer/state.json',
      'writer/pre/ch08-old.md',
      'writer/transcripts/stp_one.json',
    ]);
    expect(found.map((problem) => problem.code)).toEqual([
      'WRITER_LEFTOVER',
      'WRITER_LEFTOVER',
      'WRITER_LEFTOVER',
    ]);
    expect(found.map((problem) => problem.path)).toEqual([
      `${DATA}/writer/pre/ch08-old.md`,
      `${DATA}/writer/state.json`,
      `${DATA}/writer/transcripts/stp_one.json`,
    ]);
    expect(found[0]?.message).toContain('writer/pre');
    // BOOK-187 review: the message is a remedy, not just a verdict — the operator reads one line
    // and knows what to run.
    for (const problem of found) expect(problem.message).toContain('bin/home-migrate.mjs --apply');
  });

  it('names `writer/` itself, so a leftover of an older lane is one specific line', () => {
    const found = problems(['writer/unknown.txt']);
    expect(found.map((problem) => problem.code)).toEqual(['WRITER_LEFTOVER']);
    expect(found[0]?.path).toBe(`${DATA}/writer/unknown.txt`);
    expect(found[0]?.message).toContain(`${DATA}/writer/unknown.txt`);
    expect(found[0]?.message).toContain('run bin/home-migrate.mjs --apply once');
  });

  it('fails on the directories themselves, even empty', () => {
    const found = problems(['writer/pre/', 'writer/transcripts/']);
    expect(found.map((problem) => problem.path)).toEqual([`${DATA}/writer/pre`, `${DATA}/writer/transcripts`]);
  });
});

describe('rule c — the volume is the book and nothing else', () => {
  it('passes every allow-listed name', () => {
    const allowed = [
      'book.db',
      'book.db-wal',
      'book.db-shm',
      'admin.token',
      'engine.token',
      'book-before-20261028.db',
      'cover.png',
      'cover.jpg',
      '.book-volume',
      'backups/',
      'backups/pre-v22-20261028T140210Z.db',
      'archive/',
      'archive/ch01.md.old',
      'versions/',
      'versions/ab/abcdef.md',
      'index/',
      'index/slices/ch08.json',
      'exchange/',
      'exchange/feedback/bat_one.jsonl',
    ];
    expect(problems(allowed)).toEqual([]);
  });

  it('fails on a single new file, naming it', () => {
    const found = problems(['book.db', 'notes.txt']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'NOT_ALLOWED', path: `${DATA}/notes.txt` });
    expect(found[0]?.message).toContain(`${DATA}/notes.txt`);
    // The remedy travels in the message: a leftover of the old writer is one command away.
    expect(found[0]?.message).toContain('bin/home-migrate.mjs --apply once');
  });

  it('keeps the legacy singular `backup/` allowed, with the reason the cutover exists', () => {
    const legacy = DATA_ALLOW_DIRS.find((entry) => entry.name === 'backup');
    expect(legacy?.reason).toContain('legacy');
    expect(legacy?.reason).toContain('bin/home-migrate.mjs');
  });

  it('fails on a new nested file by the deepest path, and on a stray empty directory', () => {
    expect(problems(['tmp/a']).map((problem) => problem.path)).toEqual([`${DATA}/tmp/a`]);
    expect(problems(['tmp/']).map((problem) => problem.path)).toEqual([`${DATA}/tmp`]);
  });

  it('names a depth-1 directory that holds nothing, and a file no allowed directory contains', () => {
    // M: an empty directory is still a second thing in the volume — the walker sees it and the
    // message names it, not its (absent) contents.
    const empty = problems(['book.db', 'tmp/']);
    expect(empty.map((problem) => problem.code)).toEqual(['NOT_ALLOWED']);
    expect(empty[0]?.path).toBe(`${DATA}/tmp`);
    expect(empty[0]?.message).toContain(`${DATA}/tmp`);

    // A file below the top level is a finding unless an allow-listed directory holds it — and
    // then the deepest path is what an operator can act on.
    expect(problems(['nested/deep/x.txt']).map((problem) => problem.path)).toEqual([`${DATA}/nested/deep/x.txt`]);
    expect(problems(['archive/nested/x.txt'])).toEqual([]);
    expect(problems(['index/slices/ch08.json'])).toEqual([]);
  });

  it('names the whole allow-list, so a failure says what would have passed', () => {
    const found = problems(['stray.json']);
    const message = found[0]?.message ?? '';
    for (const entry of DATA_ALLOW) expect(message).toContain(entry.name);
    for (const entry of DATA_ALLOW_DIRS) expect(message).toContain(`${entry.name}/`);
    // Every allowed name carries a reason of its own — an entry without one is a name nobody
    // can defend in a review.
    for (const entry of [...DATA_ALLOW, ...DATA_ALLOW_DIRS]) expect(entry.reason.length).toBeGreaterThan(10);
  });
});

describe('the walker and the whole check', () => {
  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), 'book-home-'));
    mkdirSync(join(root, 'data', 'backups'), { recursive: true });
    mkdirSync(join(root, 'manuscript'), { recursive: true });
    writeFileSync(join(root, 'data', 'book.db'), 'rows', 'utf8');
    writeFileSync(join(root, 'data', 'backups', 'pre-v22.db'), 'dump', 'utf8');
    return root;
  }

  it('reads a real tree, and a clean home passes', () => {
    const root = tree();
    try {
      const listingOf = readHome(join(root, 'data'));
      expect(listingOf.map((entry) => entry.rel)).toEqual(['backups', 'backups/pre-v22.db', 'book.db']);
      const report = checkDataHome({ dataDir: join(root, 'data'), manuscriptDir: join(root, 'manuscript') });
      expect(report).toMatchObject({ ok: true, problems: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a missing data dir (an incident) and passes a missing manuscript dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-home-'));
    try {
      const missingVolume = checkDataHome({
        dataDir: join(root, 'nowhere'),
        manuscriptDir: join(root, 'gone'),
      });
      expect(missingVolume.ok).toBe(false);
      expect(missingVolume.problems[0]?.path).toBe(join(root, 'nowhere'));

      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(join(root, 'data', 'book.db'), 'rows', 'utf8');
      expect(
        checkDataHome({ dataDir: join(root, 'data'), manuscriptDir: join(root, 'gone') }),
      ).toMatchObject({ ok: true, problems: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a real tree that holds prose and a writer file, naming both', () => {
    const root = tree();
    try {
      writeFileSync(join(root, 'manuscript', 'ch03.md'), 'текст', 'utf8');
      mkdirSync(join(root, 'data', 'writer'), { recursive: true });
      writeFileSync(join(root, 'data', 'writer', 'state.json'), '{"passes":3}', 'utf8');
      const report = checkDataHome({ dataDir: join(root, 'data'), manuscriptDir: join(root, 'manuscript') });
      expect(report.ok).toBe(false);
      // BOOK-187: the writer's directory itself is named too — a volume with `writer/` in it is
      // not a volume the cutover has finished with, whatever the directory happens to hold.
      expect(report.problems.map((problem) => problem.path)).toEqual([
        join(root, 'data', 'writer'),
        join(root, 'data', 'writer', 'state.json'),
        join(root, 'manuscript', 'ch03.md'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The CLI the deploy runs (`node bin/home-check.mjs --data-dir …`), as a real process: the exit
 * codes and the one line per failure are the contract `deploy.sh` reads.
 */
describe('bin/home-check.mjs', () => {
  const exec = promisify(execFile);

  async function homeCheck(args: string[]): Promise<{ code: number; out: string }> {
    const env = { ...process.env };
    delete env.NODE_V8_COVERAGE;
    try {
      const { stdout, stderr } = await exec('node', ['bin/home-check.mjs', ...args], { cwd: SITE_ROOT, env });
      return { code: 0, out: `${stdout}${stderr}` };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  }

  it('passes a volume that holds only allow-listed names, and says where it looked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-home-cli-'));
    try {
      mkdirSync(join(root, 'data', 'versions'), { recursive: true });
      writeFileSync(join(root, 'data', 'book.db'), 'rows', 'utf8');
      writeFileSync(join(root, 'data', 'admin.token'), 'token', 'utf8');
      const result = await homeCheck(['--data-dir', join(root, 'data'), '--manuscript', join(root, 'manuscript')]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain(join(root, 'data'));
      expect(result.out).toContain('ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every offending path and exits 1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-home-cli-'));
    try {
      mkdirSync(join(root, 'manuscript'), { recursive: true });
      mkdirSync(join(root, 'data', 'writer'), { recursive: true });
      writeFileSync(join(root, 'manuscript', 'ch04.md'), 'текст', 'utf8');
      writeFileSync(join(root, 'data', 'writer', 'state.json'), '{}', 'utf8');
      writeFileSync(join(root, 'data', 'book.db'), 'rows', 'utf8');
      const result = await homeCheck(['--data-dir', join(root, 'data'), '--manuscript', join(root, 'manuscript')]);
      expect(result.code).toBe(1);
      expect(result.out).toContain(join(root, 'data', 'writer', 'state.json'));
      expect(result.out).toContain(join(root, 'manuscript', 'ch04.md'));
      // Three: the writer's directory, the file inside it, and the prose.
      expect(result.out).toContain('3 problem(s)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints the whole report for a machine and refuses a missing volume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-home-cli-'));
    try {
      const absent = await homeCheck(['--data-dir', join(root, 'nowhere'), '--json']);
      expect(absent.code).toBe(1);
      const parsed = JSON.parse(absent.out) as { ok: boolean; problems: Array<{ path: string }> };
      expect(parsed.ok).toBe(false);
      expect(parsed.problems[0]?.path).toBe(join(root, 'nowhere'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a run with no volume named, and an unknown flag', async () => {
    expect((await homeCheck([])).code).toBe(2);
    expect((await homeCheck(['--data-dir=/x', '--frobnicate'])).code).toBe(2);
  });
});
