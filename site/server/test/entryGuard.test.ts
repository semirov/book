import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { entryState } from '../../bin/lib/entry.mjs';

/**
 * BOOK-236 — the entry guard, decided by **real** paths.
 *
 * Measured on prod after the deploy: `~/book-deploy/site/deploy/admin.sh admin doctor` printed
 * nothing and exited 0. `~/book-deploy` is a symlink (BOOK-DOC-46), Node resolves `import.meta.url`
 * to the real file, `process.argv[1]` keeps the typed path — so
 * `import.meta.url === pathToFileURL(argv[1]).href` was false, `main()` never ran, and the exit code
 * stayed 0. The worst failure shape a CLI has: «success, did nothing». Same class for
 * `bin/backup.mjs`.
 *
 * The process cases below are the ones the operator hits; the unit cases cover the branch a spawn
 * cannot reach — a typed path whose realpath throws, which must answer `unknown` (exit 2) when the
 * name is this CLI's own, and `imported` otherwise.
 */

const SITE = resolve(import.meta.dirname, '..', '..');
const BIN = join(SITE, 'bin');
const ENTRY_URL = pathToFileURL(join(BIN, 'lib', 'entry.mjs')).href;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-entry-'));
  dirs.push(dir);
  return dir;
}

type CliResult = { status: number; stdout: string; stderr: string };

function runNode(script: string, args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((done) => {
    child.on('close', (code) => {
      done({ status: code ?? 1, stdout, stderr });
    });
  });
}

describe('entryState — real paths, and a refusal instead of silence', () => {
  it('is `entry` for the file itself and for a symlinked alias of it', () => {
    const real = join(SITE, 'bin', 'lib', 'entry.mjs');
    expect(entryState(real, ENTRY_URL)).toBe('entry');

    const dir = scratch();
    const alias = join(dir, 'lib-link');
    symlinkSync(join(BIN, 'lib'), alias, 'dir');
    expect(entryState(join(alias, 'entry.mjs'), ENTRY_URL)).toBe('entry');
  });

  it('is `imported` for another file, for no argv[1], and for a path whose name is not ours', () => {
    expect(entryState(join(SITE, 'bin', 'admin.mjs'), ENTRY_URL)).toBe('imported');
    expect(entryState(undefined, ENTRY_URL)).toBe('imported');
    expect(entryState('', ENTRY_URL)).toBe('imported');
    // A path that does not exist and is not this CLI: nothing to run, nothing to refuse.
    expect(entryState(join(tmpdir(), 'book-entry-absent', 'other.mjs'), ENTRY_URL)).toBe('imported');
  });

  it('is `unknown` when the operator typed our own name and the real path cannot be read', () => {
    // The one branch a spawn cannot reach: the file would fail to load before the guard runs.
    expect(entryState(join(tmpdir(), 'book-entry-absent', 'entry.mjs'), ENTRY_URL)).toBe('unknown');
  });
});

describe('the shipped CLIs answer through a symlinked deploy root', () => {
  it('runs `admin.mjs --help` when the bin directory is reached through a symlink', async () => {
    const dir = scratch();
    const alias = join(dir, 'bin');
    symlinkSync(BIN, alias, 'dir');

    const result = await runNode(join(alias, 'admin.mjs'), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node bin/admin.mjs doctor [--json] [--url <url>]');
    expect(result.stderr).toBe('');
  });

  it('runs `backup.mjs --help` the same way', async () => {
    const dir = scratch();
    const alias = join(dir, 'bin');
    symlinkSync(BIN, alias, 'dir');

    const result = await runNode(join(alias, 'backup.mjs'), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node bin/backup.mjs [--data DIR]');
    expect(result.stderr).toBe('');
  });

  it('keeps the direct path working, and refuses unknown junk as before', async () => {
    const direct = await runNode(join(BIN, 'backup.mjs'), ['--nope']);
    expect(direct.status).toBe(2);
    expect(direct.stderr).toContain('reason=USAGE');
  });
});
