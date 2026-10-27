/**
 * BOOK-119 hotfix — the harness the deploy tests share: real processes, a real HTTP server, fake
 * `launchctl`/`sysctl` on `PATH`. Not a test file (vitest collects `*.test.ts`): it exists so each
 * test file stays under the 500-line arch limit while using the same primitives.
 *
 * Everything is asynchronous on purpose where a server is involved: the test's own server lives in
 * this process, and `spawnSync` would block the event loop that has to answer the `curl` under test.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEPLOY = resolve(import.meta.dirname, '..', '..', 'deploy', 'deploy.sh');
export const LIB = resolve(import.meta.dirname, '..', '..', 'deploy', 'lib.sh');

/** Nothing listens there: a read that cannot be made. */
export const SILENT = 'http://127.0.0.1:9/healthz';

const dirs: string[] = [];
const servers: Server[] = [];

export async function closeAll(): Promise<void> {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => {
            done();
          });
        }),
    ),
  );
}

export function temp(prefix = 'book-deploy-hotfix-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A directory of executables that stand in for the box's `launchctl`/`sysctl`/`uptime`. */
export function fakes(scripts: Record<string, string>): string {
  const dir = temp('book-deploy-bin-');
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { encoding: 'utf8', mode: 0o755 });
  }
  return dir;
}

/** A lock directory as a holder leaves it: its pid and the second it started. */
export function holdLock(stateDir: string, pid: number, since: number): string {
  const lock = join(stateDir, 'deploy.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), `${pid}\n`, 'utf8');
  writeFileSync(join(lock, 'since'), `${since}\n`, 'utf8');
  return lock;
}

/** A root with no clone: whatever happens after the lock, it fails before npm or git can work. */
export function emptyRoot(): string {
  return temp('book-deploy-root-');
}

/** The script as the workflow runs it: a real process, its own state dir, nothing ambient. */
export function deploy(args: string[], env: Record<string, string> = {}): { code: number | null; out: string } {
  const merged: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Nothing ambient may reach the run: a test must never meet the real state dir, the real clone
  // or the real service label.
  delete merged.BOOK_PROBE;
  delete merged.BOOK_DEPLOY_ROOT;
  delete merged.BOOK_LOCK_STALE_S;
  delete merged.BOOK_STATE_DIR;
  Object.assign(merged, env);
  const result = spawnSync('/bin/bash', [DEPLOY, ...args], { encoding: 'utf8', env: merged, timeout: 30_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The lib's functions, driven by bash exactly the way `deploy.sh` drives them. */
export function lib(body: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const script = `set -euo pipefail\n. "${LIB}"\n${body}\n`;
  return new Promise((done) => {
    const child = spawn('/bin/bash', ['-c', script], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.on('close', (code: number | null) => {
      done({ code, out });
    });
  });
}

/**
 * A taker's script for the lock race: take the lock (a refusal exits 3 and prints why), say when it
 * held it, hold for `holdS` seconds, release. Transcript lines are `acquired|released <label> …`.
 */
export function taker(stateDir: string, label: string, holdS = 0.6): string {
  return [
    `STATE_DIR="${stateDir}"`,
    'LOCK_DIR="$STATE_DIR/deploy.lock"',
    'lock_acquire',
    `printf "acquired ${label} pid=%s at=%s\\n" "$$" "$(now_ms)"`,
    `sleep ${holdS}`,
    `printf "released ${label} pid=%s at=%s\\n" "$$" "$(now_ms)"`,
    'lock_release',
  ].join('\n');
}

/** The window one taker's transcript says it held the lock, or null when it never held it. */
export function heldWindow(out: string, label: string): { pid: number; start: number; end: number } | null {
  const got = new RegExp(`acquired ${label} pid=(\\d+) at=(\\d+)`, 'u').exec(out);
  if (got === null) return null;
  const gone = new RegExp(`released ${label} pid=(\\d+) at=(\\d+)`, 'u').exec(out);
  return { pid: Number(got[1]), start: Number(got[2]), end: Number(gone?.[2] ?? '0') };
}

export type Answer = { status: number; body: unknown };

/** A real server on a random port; `/healthz` answers with whatever the handler returns. */
export async function serve(answer: (count: number) => Answer): Promise<string> {
  let count = 0;
  const server = createServer((_request, response) => {
    count += 1;
    const reply = answer(count);
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server has no port');
  return `http://127.0.0.1:${address.port}/healthz`;
}

/** A `/healthz` answer for a commit. */
export const OK = (commit: string): Answer => ({ status: 200, body: { ok: true, commit } });
