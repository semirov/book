/**
 * BOOK-107 (m4): the two operator CLIs that touch `book.db` use the same wall as the boot.
 * `feedback.mjs` opens the file writable (and migrates it); `restore.mjs` reads it and can copy a
 * snapshot over a chapter. A dev shell that exported the production data dir must be refused
 * *before* either opens anything — which is what these tests spawn for, with an environment whose
 * `NODE_ENV` is not production. Nothing is written: the guard fires before `openDatabase`, and the
 * write-capable case runs against a temp dir, so a regression cannot reach the live data.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PRODUCTION_DATA_DIR } from '../src/dataDirGuard.ts';

const SITE = resolve(import.meta.dirname, '..', '..');
const CLI = {
  restore: join(SITE, 'bin', 'restore.mjs'),
  feedback: join(SITE, 'bin', 'feedback.mjs'),
} as const;
/** The verbatim part every refusal carries. */
const MESSAGE = 'refusing to run non-production against the production data dir';

type RunResult = { status: number; stdout: string; stderr: string };

const tmpDirs: string[] = [];
function tmpDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
}

/** The shell's own environment minus every data-dir variable, plus what a case needs. */
function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['NODE_ENV', 'DATA_DIR', 'FEEDBACK_DIR', 'PRODUCTION_DATA_DIR']) delete env[name];
  return { ...env, ...extra };
}

async function runCli(cli: keyof typeof CLI, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  const child = spawn(process.execPath, [CLI[cli], ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const status = await new Promise<number>((done) => child.on('close', (code) => done(code ?? 1)));
  return { status, stdout, stderr };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('operator CLIs refuse the production data dir in a dev shell (BOOK-107 m4)', () => {
  it('restore.mjs refuses the live production data dir, and opens nothing', async () => {
    const result = await runCli(
      'restore',
      ['--chapter', '1', '--list'],
      envWith({ DATA_DIR: DEFAULT_PRODUCTION_DATA_DIR }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${MESSAGE} (${DEFAULT_PRODUCTION_DATA_DIR})`);
  });

  it('feedback.mjs refuses a production data dir before it creates or migrates a database', async () => {
    const prod = tmpDir('book-cli-prod-');
    const result = await runCli(
      'feedback',
      ['inbox'],
      envWith({ DATA_DIR: prod, PRODUCTION_DATA_DIR: prod, FEEDBACK_DIR: prod }),
    );
    expect(result.status).toBe(1);
    // The guard prints resolved paths, and `/var/…` on macOS is a link to `/private/var/…`.
    expect(result.stderr).toContain(`${MESSAGE} (${realpathSync.native(prod)})`);
    // The proof that the guard ran first: the writable CLI left the dir exactly as it was.
    expect(readdirSync(prod)).toEqual([]);
  });

  it('restore.mjs refuses the same way, before it reads the database', async () => {
    const prod = tmpDir('book-cli-prod-');
    const result = await runCli(
      'restore',
      ['--chapter', '1', '--list'],
      envWith({ DATA_DIR: prod, PRODUCTION_DATA_DIR: prod }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${MESSAGE} (${realpathSync.native(prod)})`);
    expect(readdirSync(prod)).toEqual([]);
  });

  it('still runs on a scratch dir — the guard is not a blanket refusal', async () => {
    const scratch = tmpDir('book-cli-scratch-');
    const result = await runCli('restore', ['--chapter', '1', '--list'], envWith({ DATA_DIR: scratch }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no database at');
    expect(result.stderr).not.toContain(MESSAGE);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
