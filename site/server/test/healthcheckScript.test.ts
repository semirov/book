/**
 * BOOK-172 — `deploy/healthcheck.mjs`, the thing Docker asks about health.
 *
 * A healthcheck that only proves "something accepted a socket" cannot tell a stale build from a
 * served one, so the site's check compares `/healthz.commit` with the commit stamped into the image
 * (`/app/build-info.json`, overridable for a test) and the engine's check uses the same bearer the
 * process reads. These cases pin both, plus the one thing that must never happen: a token in the
 * output.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '..', '..', 'deploy', 'healthcheck.mjs');

// The server under test lives in this process: the child has to be asynchronous, or `spawnSync`
// blocks the event loop that must answer the child's own `fetch` (deployHarness.ts says the same).
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const servers: Server[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
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
});

/** A stamp as the build writes it; the healthcheck reads `commit` and nothing else. */
function stamp(commit: string): string {
  const dir = temp('book-172-stamp-');
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ commit, stamp: '01.01 00:00' }), 'utf8');
  return join(dir, 'build-info.json');
}

type Reply = { status: number; body: string; type?: string };

/** A server that answers every request the same way, and records the authorization it was given. */
async function serve(reply: Reply, seen?: string[]): Promise<string> {
  const server = createServer((request, response) => {
    seen?.push(request.headers.authorization ?? '');
    response.writeHead(reply.status, { 'content-type': reply.type ?? 'application/json' });
    response.end(reply.body);
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function check(role: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('BOOK_') || key.startsWith('ENGINE_')) continue;
    if (value !== undefined) merged[key] = value;
  }
  Object.assign(merged, env);
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, role], { env: merged });
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

describe('the site healthcheck', () => {
  it('is healthy only when /healthz names the commit the image carries', async () => {
    const url = await serve({ status: 200, body: JSON.stringify({ ok: true, commit: 'abc1234' }) });
    const good = await check('site', { BOOK_HEALTH_URL: `${url}/healthz`, BOOK_BUILD_INFO_FILE: stamp('abc1234') });
    expect(good.code, good.out).toBe(0);
    expect(good.out).toBe('');
  });

  it('is unhealthy when the answer is another build (a stale container)', async () => {
    const url = await serve({ status: 200, body: JSON.stringify({ ok: true, commit: 'abc1234' }) });
    const stale = await check('site', { BOOK_HEALTH_URL: `${url}/healthz`, BOOK_BUILD_INFO_FILE: stamp('fffffff') });
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('commit mismatch');
  });

  it('is unhealthy on a non-200, a missing ok, or a body that is not JSON', async () => {
    const five = await serve({ status: 500, body: '{"ok":true,"commit":"abc1234"}' });
    expect((await check('site', { BOOK_HEALTH_URL: `${five}/healthz`, BOOK_BUILD_INFO_FILE: stamp('abc1234') })).code).toBe(1);

    const notOk = await serve({ status: 200, body: JSON.stringify({ ok: false, commit: 'abc1234' }) });
    expect((await check('site', { BOOK_HEALTH_URL: `${notOk}/healthz`, BOOK_BUILD_INFO_FILE: stamp('abc1234') })).code).toBe(1);

    const html = await serve({ status: 200, body: '<html></html>', type: 'text/html' });
    expect((await check('site', { BOOK_HEALTH_URL: `${html}/healthz`, BOOK_BUILD_INFO_FILE: stamp('abc1234') })).code).toBe(1);
  });
});

describe('the engine healthcheck', () => {
  it('is healthy only with the bearer the process itself reads', async () => {
    const seen: string[] = [];
    const token = 'not-a-real-token-0123456789';
    const dir = temp('book-172-token-');
    const file = join(dir, 'engine.token');
    writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    const url = await serve({ status: 200, body: JSON.stringify({ ok: true, state: { status: 'running' } }) }, seen);

    const good = await check('engine', { BOOK_ENGINE_URL: `${url}/internal/health`, ENGINE_TOKEN_FILE: file });
    expect(good.code, good.out).toBe(0);
    expect(seen[0]).toBe(`Bearer ${token}`);
    // The token is read by the process, never printed.
    expect(good.out).not.toContain(token);
  });

  it('is unhealthy on 401 and when the token file is missing', async () => {
    const url = await serve({ status: 401, body: JSON.stringify({ code: 'UNAUTHORIZED' }) });
    const dir = temp('book-172-token-');
    const file = join(dir, 'engine.token');
    writeFileSync(file, 'not-a-real-token\n', { encoding: 'utf8', mode: 0o600 });
    expect((await check('engine', { BOOK_ENGINE_URL: `${url}/internal/health`, ENGINE_TOKEN_FILE: file })).code).toBe(1);

    const missing = await check('engine', { BOOK_ENGINE_URL: `${url}/internal/health`, ENGINE_TOKEN_FILE: join(dir, 'absent') });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('no engine token');
  });
});
