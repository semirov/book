/**
 * BOOK-109 — the build stamp, made the way a build makes it.
 *
 * `scripts/build-info.mjs` runs as `prebuild` in `npm run build`, so this test spawns the CLI
 * as a real process (`frameCheck.test.ts` does the same for its contract) into a temp output
 * file: what is asserted is the file a deploy ships, not a helper's return value.
 *
 * The commit precedence is the part that must not be guessed (BOOK-109 review): a tree in hand
 * outranks `GITHUB_SHA`, because the workflow runs `deploy.sh` inside an Actions step and
 * `GITHUB_SHA` is then the *trigger* commit — after a rollback, naming it would point at a
 * commit that is not deployed. `GITHUB_SHA` is the git-less fallback (the Docker image), and
 * the stamp is Moscow time by construction: the run below sets `TZ` to another zone and the
 * answer cannot move.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readBuildCommit } from '../src/build.ts';

const SITE = resolve(import.meta.dirname, '..', '..');
const CLI = join(SITE, 'scripts', 'build-info.mjs');
/** 40 hex characters, the shape of an Actions `GITHUB_SHA`. */
const TRIGGER_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const T0 = '2026-10-27T17:52:00Z';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-build-info-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type BuildInfo = { commit: string; builtAt: string; stamp: string };

function run(env: Record<string, string>, cli: string = CLI): { status: number | null; stdout: string; stderr: string; out: string } {
  const out = join(tempDir(), 'build-info.json');
  const result = spawnSync(process.execPath, [cli], {
    encoding: 'utf8',
    env: { ...process.env, BOOK_BUILD_COMMIT: '', BOOK_BUILD_OUT: out, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out };
}

/** The sha of the tree the CLI must obey — the same command, run by the test itself. */
function treeSha(): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SITE, encoding: 'utf8' }).trim();
}

/** A copy of the CLI outside any repository: the git-less build an image is. */
function gitlessCli(): string {
  const root = tempDir();
  mkdirSync(join(root, 'scripts'), { recursive: true });
  const cli = join(root, 'scripts', 'build-info.mjs');
  copyFileSync(CLI, cli);
  return cli;
}

function infoOf(out: string): BuildInfo {
  return JSON.parse(readFileSync(out, 'utf8')) as BuildInfo;
}

describe('scripts/build-info.mjs — which commit a build names (BOOK-109)', () => {
  it('names the tree it is building, even when GITHUB_SHA names the triggering commit', () => {
    const result = run({ GITHUB_SHA: TRIGGER_SHA, BOOK_BUILD_TIME: T0, TZ: 'UTC' });
    expect(result.status).toBe(0);
    const info = infoOf(result.out);
    // The tree wins: a rollback checks out a different ref than the one that triggered the run.
    expect(info.commit).toBe(treeSha());
    expect(info.commit).not.toBe('deadbee');
  });

  it('lets an explicit BOOK_BUILD_COMMIT override the tree', () => {
    const result = run({ BOOK_BUILD_COMMIT: 'cafe123', GITHUB_SHA: TRIGGER_SHA, BOOK_BUILD_TIME: T0 });
    expect(result.status).toBe(0);
    expect(infoOf(result.out).commit).toBe('cafe123');
  });

  it('falls back to GITHUB_SHA when there is no tree to read (the image build)', () => {
    const result = run({ GITHUB_SHA: TRIGGER_SHA, BOOK_BUILD_TIME: T0 }, gitlessCli());
    expect(result.status).toBe(0);
    expect(infoOf(result.out).commit).toBe('deadbee');
  });

  it('answers `dev` when there is neither a tree nor a sha', () => {
    const result = run({ GITHUB_SHA: '', BOOK_BUILD_TIME: T0 }, gitlessCli());
    expect(result.status).toBe(0);
    expect(infoOf(result.out).commit).toBe('dev');
  });
});

describe('scripts/build-info.mjs — the stamp a build ships (BOOK-109)', () => {
  it('writes commit, builtAt and a Moscow stamp, whichever zone the build machine is in', () => {
    const result = run({
      BOOK_BUILD_COMMIT: '5558449',
      BOOK_BUILD_TIME: T0,
      // A CI runner is UTC and a laptop is wherever the owner is: neither may move the stamp.
      TZ: 'America/New_York',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const info = infoOf(result.out);
    expect(info.commit).toBe('5558449');
    expect(info.builtAt).toBe('2026-10-27T17:52:00.000Z');
    expect(info.stamp).toBe('27.10 20:52');
    // One line, greppable in a CI log, naming both the build and where the stamp went.
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toContain('5558449 · 27.10 20:52');
    expect(result.stdout).toContain(result.out);
  });

  it('reads the Moscow day, and prints midnight as 00:xx', () => {
    const result = run({ BOOK_BUILD_COMMIT: '5558449', BOOK_BUILD_TIME: '2026-10-27T21:30:00Z' });
    // 21:30Z is already the next day in Moscow (00:30).
    expect(infoOf(result.out).stamp).toBe('28.10 00:30');
  });
});

describe('readBuildCommit — the server reads what the build wrote (BOOK-109)', () => {
  it('returns the commit the manifest carries', () => {
    const file = join(tempDir(), 'build-info.json');
    writeFileSync(file, `${JSON.stringify({ commit: '5558449', builtAt: T0, stamp: '27.10 20:52' })}\n`, 'utf8');
    expect(readBuildCommit(file)).toBe('5558449');
  });

  it('answers `dev` for a missing or corrupt file instead of failing the boot', () => {
    expect(readBuildCommit(join(tempDir(), 'nope.json'))).toBe('dev');

    const corrupt = join(tempDir(), 'build-info.json');
    writeFileSync(corrupt, '{ not json', 'utf8');
    expect(readBuildCommit(corrupt)).toBe('dev');

    const empty = join(tempDir(), 'empty.json');
    writeFileSync(empty, '{"commit":""}', 'utf8');
    expect(readBuildCommit(empty)).toBe('dev');
  });
});
