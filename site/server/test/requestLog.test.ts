/**
 * BOOK-172 — the one fact the request log owes the proxy question.
 *
 * The post-flip NAT check in the README greps the site log for the address Caddy's hop should carry
 * (`192.168.215.1`); the log never held an address, so that check could not fail. It now holds a
 * boolean instead: `peerTrusted` — was the socket peer one of `TRUSTED_PROXIES`, i.e. is
 * `X-Forwarded-For` believed for this request? No address, no PII, nothing from a header.
 *
 * The three cases are the three states the deployment can be in: behind the proxy (`true`), reached
 * directly by someone else (`false`), and reached directly by someone who *claims* a forward
 * (`false` — the claim is not the identity).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';

const appList: FastifyInstance[] = [];
const dirs: string[] = [];
const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(appList.splice(0).map((app) => app.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const fixture of fixtures.splice(0)) fixture.close();
});

type Logged = { lines: string[]; app: FastifyInstance };

/** The app with the log seam attached; `write` is what a test reads after one turn of the loop. */
async function boot(logLevel = 'info'): Promise<Logged> {
  const fixture = createFixture({ 'ch01.md': '# Глава\n\nАбзац.\n' });
  fixtures.push(fixture);
  const webDist = mkdtempSync(join(tmpdir(), 'book-log-'));
  dirs.push(webDist);
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');

  const lines: string[] = [];
  const app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: webDist,
      PORT: '8080',
      LOG_LEVEL: logLevel,
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logStream: { write: (line) => lines.push(line) },
  });
  appList.push(app);
  return { lines, app };
}

/** `onResponse` fires after the reply is sent: one turn of the loop is enough for the line. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the request log: is the peer a proxy?', () => {
  it('says true for a trusted peer (loopback is in the default TRUSTED_PROXIES)', async () => {
    const { lines, app } = await boot();
    const answer = await app.inject({ method: 'GET', url: '/api/state' });
    expect(answer.statusCode).toBe(200);
    await settle();

    const line = lines.find((entry) => entry.includes('request completed'));
    expect(line, lines.join('\n')).toBeDefined();
    expect(line).toContain('"peerTrusted":true');
    // The line stays address-free: the boolean is the whole answer.
    expect(line).not.toContain('127.0.0.1');
  });

  it('says false for a peer outside TRUSTED_PROXIES, and does not believe its X-Forwarded-For', async () => {
    const { lines, app } = await boot();
    // A direct client that names its own address in the header: the socket peer decides, not the claim.
    const answer = await app.inject({
      method: 'GET',
      url: '/api/state',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(answer.statusCode).toBe(200);
    await settle();

    const line = lines.find((entry) => entry.includes('request completed'));
    expect(line, lines.join('\n')).toBeDefined();
    expect(line).toContain('"peerTrusted":false');
    // Neither the peer nor the header hop reaches the log.
    expect(line).not.toContain('203.0.113.9');
    expect(line).not.toContain('198.51.100.7');
  });

  it('says true for a trusted peer carrying a forward, which is the normal Caddy hop', async () => {
    const { lines, app } = await boot();
    const answer = await app.inject({
      method: 'GET',
      url: '/api/state',
      remoteAddress: '192.168.1.44',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(answer.statusCode).toBe(200);
    await settle();

    const line = lines.find((entry) => entry.includes('request completed'));
    expect(line, lines.join('\n')).toBeDefined();
    // The compose default names the home-server as a proxy: its forward would be believed.
    expect(line).toContain('"peerTrusted":true');
    expect(line).not.toContain('198.51.100.7');
  });
});
