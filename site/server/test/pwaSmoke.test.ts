/**
 * BOOK-157: the PWA smoke, run the way `deploy.sh` runs it — as the CLI, spawned as a real
 * process against a real HTTP server, never as a function call.
 *
 * What is asserted is the contract `finish_green` reads: exit 0 when the manifest is a manifest
 * and the worker is a JavaScript file a cache must revalidate, exit 1 for any mismatch (a wrong
 * content type, a worker a cache may keep, an unreachable site), exit 2 for bad usage only.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SITE = resolve(import.meta.dirname, '..', '..');
const CLI = join(SITE, 'scripts', 'pwa-smoke.mjs');

type RunResult = { status: number; stdout: string; stderr: string };

/** The CLI as a real process. Asynchronous: `spawnSync` would block the stub's own event loop. */
async function run(...args: string[]): Promise<RunResult> {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

let server: Server | null = null;

type Answer = { status?: number; contentType?: string; cacheControl?: string; body?: string };

/** A loopback stub answering the two PWA surfaces, with whatever the case needs to be wrong. */
async function serve(manifest: Answer, worker: Answer): Promise<string> {
  const instance = createServer((request, response) => {
    const url = (request.url ?? '').split('?')[0];
    const answer = url === '/manifest.webmanifest' ? manifest : url === '/sw.js' ? worker : null;
    if (answer === null) {
      response.statusCode = 404;
      response.end('{"code":"NOT_FOUND"}');
      return;
    }
    const headers: Record<string, string> = {};
    if (answer.contentType !== undefined) headers['content-type'] = answer.contentType;
    if (answer.cacheControl !== undefined) headers['cache-control'] = answer.cacheControl;
    response.writeHead(answer.status ?? 200, headers);
    response.end(answer.body ?? '');
  });
  await new Promise<void>((ready) => instance.listen(0, '127.0.0.1', ready));
  server = instance;
  const address = instance.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

/** The two good answers: a JSON manifest and a worker a cache must revalidate. */
const GOOD_MANIFEST: Answer = {
  contentType: 'application/manifest+json',
  body: '{"name":"Бланк","short_name":"Бланк","icons":[{"src":"/icons/icon-192.png"}]}',
};
const GOOD_WORKER: Answer = { contentType: 'text/javascript', cacheControl: 'no-cache', body: 'self.addEventListener("install", () => {});\n' };

afterEach(() => {
  server?.close();
  server = null;
});

describe('pwa-smoke — the CLI contract (BOOK-157)', () => {
  it('passes on the two surfaces an install reads, and prints what it read', async () => {
    const base = await serve(GOOD_MANIFEST, GOOD_WORKER);
    const result = await run('--server', base);

    expect(result.stderr, result.stdout).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pwa: GET /manifest.webmanifest — ok status=200 content-type=application/manifest+json json=ok icons=1');
    expect(result.stdout).toContain('pwa: GET /sw.js — ok status=200 content-type=text/javascript cache-control=no-cache');
    expect(result.stdout).toContain('pwa: ok — 2 checks');
  });

  it('fails when the manifest is answered as a page', async () => {
    const base = await serve({ ...GOOD_MANIFEST, contentType: 'text/html' }, GOOD_WORKER);
    const result = await run('--server', base);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('pwa: GET /manifest.webmanifest — MISMATCH');
    expect(result.stdout).toContain('pwa: GET /sw.js — ok');
    expect(result.stdout).toContain('pwa: FAILED — 1 of 2 checks');
  });

  it('fails when the manifest does not parse', async () => {
    const base = await serve({ ...GOOD_MANIFEST, body: '<!doctype html>' }, GOOD_WORKER);
    const result = await run('--server', base);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/pwa: GET \/manifest\.webmanifest — MISMATCH .*json=FAIL/u);
  });

  it('fails when the worker may be kept without asking', async () => {
    // `no-store` is the other half of the same defect: a browser cannot register it at all.
    for (const cacheControl of ['public, max-age=31536000, immutable', 'no-store', '']) {
      const base = await serve(GOOD_MANIFEST, { ...GOOD_WORKER, cacheControl });
      const result = await run('--server', base);
      expect(result.status, cacheControl).toBe(1);
      expect(result.stdout, cacheControl).toContain('pwa: GET /sw.js — MISMATCH');
      expect(result.stdout, cacheControl).toContain('pwa: GET /manifest.webmanifest — ok');
    }
  });

  it('fails when the worker is not JavaScript', async () => {
    const base = await serve(GOOD_MANIFEST, { ...GOOD_WORKER, contentType: 'text/html; charset=utf-8' });
    const result = await run('--server', base);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('pwa: GET /sw.js — MISMATCH status=200 content-type=text/html; charset=utf-8');
  });

  it('reports a non-200 as a mismatch, not a crash', async () => {
    const base = await serve({ ...GOOD_MANIFEST, status: 503, body: '{"code":"UI_NOT_BUILT"}' }, GOOD_WORKER);
    const result = await run('--server', base);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('pwa: GET /manifest.webmanifest — MISMATCH status=503');
  });

  it('reports an unreachable site as a mismatch with the reason', async () => {
    const result = await run('--server', 'http://127.0.0.1:1');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('pwa: GET /manifest.webmanifest — MISMATCH unreachable:');
    expect(result.stdout).toContain('pwa: FAILED — 2 of 2 checks');
  });

  it('exits 2 on bad usage only', async () => {
    expect((await run()).status).toBe(2);
    expect((await run('--nope')).status).toBe(2);
    expect((await run('--server')).status).toBe(2);
    expect((await run('--server=')).status).toBe(2);
  });

  it('accepts the `--url=` form and a trailing slash', async () => {
    const base = await serve(GOOD_MANIFEST, GOOD_WORKER);
    const result = await run(`--url=${base}/`);
    expect(result.status, result.stdout).toBe(0);
  });
});

describe('the deploy runs it where it can still refuse', () => {
  const deploy = readFileSync(join(SITE, 'deploy', 'deploy.sh'), 'utf8');

  it('is called from finish_green, before last-good is written', () => {
    expect(deploy).toContain('node "$ROOT/site/scripts/pwa-smoke.mjs" --server "$(site_url)"');
    const start = deploy.indexOf('finish_green() {');
    expect(start).toBeGreaterThan(-1);
    const body = deploy.slice(start, deploy.indexOf('\n}\n', start));
    const call = body.indexOf('pwa_check');
    expect(call).toBeGreaterThan(-1);
    // A red smoke must not record the build as good: the call comes before the `last-good` write.
    expect(call).toBeLessThan(body.indexOf('last-good'));
  });

  it('takes the red path on a red smoke, before any rollback is considered', () => {
    const refusal = deploy.indexOf('if [ "$PWA" = "fail" ]');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(deploy.indexOf('rollback_allowed "$HEALTH_MS"'));
    // And the audit line names the check, so a green record says what was verified.
    expect(deploy).toContain('health=$HEALTH frame=ok pwa=$PWA restart=');
  });
});
