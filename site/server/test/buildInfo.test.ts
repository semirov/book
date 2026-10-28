/**
 * BOOK-109 / BOOK-187 — the build stamp, made the way a build makes it.
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
 *
 * BOOK-187 adds the two digests the git-less host cannot re-derive: `promptBundleSha` (hashed
 * from the prompt and canon files, recomputed here by an independent implementation of the same
 * recipe) and `imageDigest` (the build arg). `BOOK_BUILD_NO_GIT=1` proves the image build does
 * not consult a repository: the tree exists, and its sha is still not the answer.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readBuildCommit } from '../src/build.ts';
import { NO_BUILD_STAMP, readBuildStamp } from '../src/buildStamp.ts';

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

type BuildInfo = {
  commit: string;
  builtAt: string;
  stamp: string;
  promptBundleSha: string;
  imageDigest: string | null;
};

/** The five files of the bundle, in the order the digest names them (ADR-043 G3). */
const PROMPT_FILES = [
  'process/ROLE_PROMPTS.md',
  'concept/CONCEPT.md',
  'concept/CLIMAX.md',
  'style/VOICE.md',
  'config/pipeline.json',
];

/**
 * The recipe, implemented a second time on purpose: `<relpath>:<sha256(file)>` per line, in
 * order, hashed as one UTF-8 string. If the script and this disagree, the recorded bundle cannot
 * name the rules a pass ran under.
 */
function expectedBundle(root: string): string {
  const lines = PROMPT_FILES.map((relpath) => {
    // The pipeline pin ships under `site/` in this tree; the canon lives at the root. The
    // script's own lookup order is asserted by the digest matching, not restated.
    let body: string;
    try {
      body = readFileSync(join(root, relpath), 'utf8');
    } catch {
      body = readFileSync(join(root, 'site', relpath), 'utf8');
    }
    return `${relpath}:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  });
  return createHash('sha256').update(`${lines.join('\n')}\n`, 'utf8').digest('hex');
}

/** The five bundle files, written under `root` at their logical paths. */
function writePromptTree(root: string, skip?: string): void {
  const bodies: Record<string, string> = {
    'process/ROLE_PROMPTS.md': '# Роли\n\nРоль писателя.\n',
    'concept/CONCEPT.md': '# Замысел\n',
    'concept/CLIMAX.md': '# Кульминация\n',
    'style/VOICE.md': '# Голос\n',
    'config/pipeline.json': '{ "model": "test" }\n',
  };
  for (const [relpath, body] of Object.entries(bodies)) {
    if (relpath === skip) continue;
    mkdirSync(join(root, relpath, '..'), { recursive: true });
    writeFileSync(join(root, relpath), body, 'utf8');
  }
}

function run(env: Record<string, string>, cli: string = CLI): { status: number | null; stdout: string; stderr: string; out: string } {
  const out = join(tempDir(), 'build-info.json');
  const result = spawnSync(process.execPath, [cli], {
    encoding: 'utf8',
    env: { ...process.env, BOOK_BUILD_COMMIT: '', BOOK_BUILD_NO_GIT: '', BOOK_IMAGE_DIGEST: '', BOOK_BUILD_OUT: out, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out };
}

/** The sha of the tree the CLI must obey — the same command, run by the test itself. */
function treeSha(): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SITE, encoding: 'utf8' }).trim();
}

/**
 * A copy of the CLI outside any repository, with the prompt tree beside it: the git-less build an
 * image is. `site/scripts/build-info.mjs` resolves the bundle from `site/..`, so the copy is laid
 * out the same way and `skip` removes one file the build must refuse to hash.
 */
function gitlessCli(skip?: string): { cli: string; root: string } {
  const root = tempDir();
  mkdirSync(join(root, 'site', 'scripts'), { recursive: true });
  const cli = join(root, 'site', 'scripts', 'build-info.mjs');
  copyFileSync(CLI, cli);
  writePromptTree(root, skip);
  return { cli, root };
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
    const result = run({ GITHUB_SHA: TRIGGER_SHA, BOOK_BUILD_TIME: T0 }, gitlessCli().cli);
    expect(result.status).toBe(0);
    expect(infoOf(result.out).commit).toBe('deadbee');
  });

  it('answers `dev` when there is neither a tree nor a sha', () => {
    const result = run({ GITHUB_SHA: '', BOOK_BUILD_TIME: T0 }, gitlessCli().cli);
    expect(result.status).toBe(0);
    expect(infoOf(result.out).commit).toBe('dev');
  });

  it('never asks git when the image build sets BOOK_BUILD_NO_GIT=1', () => {
    // The tree is right here and would answer with a real sha — the image build must not look.
    const result = run({ BOOK_BUILD_NO_GIT: '1', GITHUB_SHA: TRIGGER_SHA, BOOK_BUILD_TIME: T0 });
    expect(result.status).toBe(0);
    expect(infoOf(result.out).commit).toBe('deadbee');
    expect(infoOf(result.out).commit).not.toBe(treeSha());
  });
});

describe('scripts/build-info.mjs — the stamp a build ships (BOOK-109)', () => {
  it('bakes the prompt bundle and the image digest (BOOK-187, ADR-043 G3/G8)', () => {
    const result = run({
      BOOK_BUILD_COMMIT: '5558449',
      BOOK_BUILD_TIME: T0,
      BOOK_IMAGE_DIGEST: 'sha256:0123456789abcdef',
    });
    expect(result.status).toBe(0);
    const info = infoOf(result.out);
    // The test's own recipe over the repository's real files: one digest, computed twice.
    expect(info.promptBundleSha).toBe(expectedBundle(resolve(SITE, '..')));
    expect(info.promptBundleSha).toMatch(/^[0-9a-f]{64}$/u);
    expect(info.imageDigest).toBe('sha256:0123456789abcdef');
    // The grep line names the bundle too, so a CI log says which rules shipped.
    expect(result.stdout).toContain(info.promptBundleSha.slice(0, 12));
  });

  it('writes a null image digest when the build was not an image', () => {
    const result = run({ BOOK_BUILD_COMMIT: '5558449', BOOK_BUILD_TIME: T0 });
    expect(infoOf(result.out).imageDigest).toBeNull();
  });

  it('refuses to build when one file of the bundle is missing', () => {
    // A bundle that cannot be hashed is not a bundle: no stamp, non-zero exit.
    const { cli } = gitlessCli('concept/CLIMAX.md');
    const result = run({ BOOK_BUILD_COMMIT: '5558449', BOOK_BUILD_TIME: T0 }, cli);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('concept/CLIMAX.md');
    expect(result.stderr).toContain('a bundle that cannot be hashed is not a bundle');
    expect(() => readFileSync(result.out)).toThrow();
  });

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

describe('readBuildStamp — the stamp the boot trusts (BOOK-187)', () => {
  it('reads every field, and answers safe defaults for a missing or partial file', () => {
    const file = join(tempDir(), 'build-info.json');
    writeFileSync(
      file,
      JSON.stringify({
        commit: '5558449',
        builtAt: T0,
        stamp: '27.10 20:52',
        promptBundleSha: 'f'.repeat(64),
        imageDigest: 'sha256:abc',
      }),
      'utf8',
    );
    expect(readBuildStamp(file)).toEqual({
      commit: '5558449',
      builtAt: T0,
      stamp: '27.10 20:52',
      promptBundleSha: 'f'.repeat(64),
      imageDigest: 'sha256:abc',
    });

    // The boot after a rollback may meet an older stamp: absent fields are absent, not invented.
    const old = join(tempDir(), 'old.json');
    writeFileSync(old, JSON.stringify({ commit: 'abc1234' }), 'utf8');
    expect(readBuildStamp(old)).toEqual({
      commit: 'abc1234',
      builtAt: null,
      stamp: null,
      promptBundleSha: null,
      imageDigest: null,
    });

    expect(readBuildStamp(join(tempDir(), 'nope.json'))).toEqual(NO_BUILD_STAMP);
    const corrupt = join(tempDir(), 'corrupt.json');
    writeFileSync(corrupt, '{ nope', 'utf8');
    expect(readBuildStamp(corrupt)).toEqual(NO_BUILD_STAMP);
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
