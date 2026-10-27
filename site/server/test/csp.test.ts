import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { SITE_ROOT, loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { buildCsp, socketOrigin } from '../src/http/csp.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * F028 / invariant 27 (§15.3): the header names exactly what the page loads, no
 * `unsafe-inline` ever, and a deployment without a Metrika id has no Yandex origin.
 * BOOK-64: no challenge origin — `challenges.cloudflare.com` is gone from script-src,
 * frame-src and connect-src even when a Turnstile provider is named.
 * BOOK-119: the shell's one inline script (the boot guard) is allowed by its own sha256, on
 * HTML responses only.
 */

const base = { publicOrigin: 'https://book.semirov.dev', metrikaId: '' };

const apps: FastifyInstance[] = [];
const fixtures: Fixture[] = [];
const webDists: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of webDists.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the generated CSP', () => {
  it('keeps the challenge origin out of every directive, even with Turnstile named (BOOK-64)', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'turnstile' });
    expect(csp).not.toContain('challenges.cloudflare.com');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain('connect-src');
    expect(csp).toContain('wss://book.semirov.dev');
    expect(csp).not.toContain('hcaptcha');
    expect(csp).not.toContain('mc.yandex.ru');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('has no challenge origin for any provider (the header the page is served)', () => {
    for (const provider of ['none', 'turnstile', 'hcaptcha'] as const) {
      const csp = buildCsp({ ...base, captchaProvider: provider, metrikaId: '113820311' });
      for (const directive of csp.split('; ')) {
        expect(directive, `${provider} · ${directive}`).not.toContain('challenges.cloudflare.com');
        expect(directive, `${provider} · ${directive}`).not.toContain('turnstile');
      }
    }
  });

  it('names exactly the hCaptcha origins when that provider is configured', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'hcaptcha' });
    expect(csp).toContain('https://hcaptcha.com');
    expect(csp).toContain('https://*.hcaptcha.com');
    expect(csp).not.toContain('challenges.cloudflare.com');
    expect(csp).not.toContain('unsafe-inline');
  });

  it('adds Metrika only when a counter id exists', () => {
    const without = buildCsp({ ...base, captchaProvider: 'turnstile' });
    const withCounter = buildCsp({ ...base, captchaProvider: 'turnstile', metrikaId: '12345678' });
    expect(without).not.toContain('mc.yandex.ru');
    expect(withCounter).toContain('https://mc.yandex.ru');
  });

  it('opens the counter in script-src, connect-src and img-src — and nowhere else (BOOK-63)', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'none', metrikaId: '113820311' });
    const directives = new Map(csp.split('; ').map((directive) => [directive.split(' ')[0] ?? '', directive]));
    for (const name of ['script-src', 'connect-src', 'img-src']) {
      expect(directives.get(name), name).toContain('https://mc.yandex.ru');
    }
    // The loader needs no frame, no font and no object from Yandex.
    for (const name of ['frame-src', 'font-src', 'object-src', 'form-action']) {
      expect(directives.get(name), name).not.toContain('mc.yandex.ru');
    }
    for (const directive of csp.split(';')) expect(directive).not.toContain('unsafe-inline');
  });

  it('opens no third-party origin when no provider is configured', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'none' });
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain('cloudflare');
    expect(csp).not.toContain('hcaptcha');
    expect(csp).toContain("object-src 'none'");
  });

  it('keeps inline styles out of the header: no `unsafe-inline`, no `style-src-attr` (BOOK-30)', () => {
    for (const provider of ['none', 'turnstile', 'hcaptcha'] as const) {
      const csp = buildCsp({ ...base, captchaProvider: provider, metrikaId: '12345678' });
      // Every directive is checked: `unsafe-inline` in any of them would re-open styles.
      for (const directive of csp.split(';')) expect(directive).not.toContain('unsafe-inline');
      expect(csp).not.toContain('style-src-attr');
      expect(csp).not.toContain('style-src-elem');
      // The author ink is a class and the DOM-known geometry is a CSSOM write, so the
      // style directive never needs widening beyond the site's own sheet.
      expect(csp).toContain("style-src 'self'");
    }
  });

  it('derives the socket origin from the public origin', () => {
    expect(socketOrigin('https://book.semirov.dev')).toBe('wss://book.semirov.dev');
    expect(socketOrigin('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080');
    expect(socketOrigin('not a url')).toBe('wss://book.semirov.dev');
  });

  it('ships exactly one inline script in the shell: the boot guard (BOOK-119)', () => {
    const html = readFileSync(join(SITE_ROOT, 'web', 'index.html'), 'utf8');
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu)];
    // Inverted, not deleted (BOOK-119): the shell used to be "no inline script at all"; the
    // guard must run before any file, so it is one — and the server hashes exactly its bytes.
    expect(inline).toHaveLength(1);
    expect(html).toContain('<script id="boot-guard">');
    expect(inline[0]?.[1]).toContain('страница не собралась');
    expect(Buffer.byteLength(inline[0]?.[1] ?? '', 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('hashes the guard into script-src on the shell, and only there (BOOK-119)', async () => {
    const guard = 'window.__guard = 1;';
    const shell = `<!doctype html><html><head><script id="boot-guard">${guard}</script></head><body><div id="root"></div></body></html>`;
    const fixture = createFixture({});
    const webDist = mkdtempSync(join(tmpdir(), 'book-csp-'));
    webDists.push(webDist);
    writeFileSync(join(webDist, 'index.html'), shell, 'utf8');
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'assets', 'app-1.js'), 'console.log(1);', 'utf8');

    const app = await buildApp({
      config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: webDist, PORT: '8080' }),
      db: fixture.db,
      state: new StateService(fixture.db),
      version: 'test',
      logger: false,
    });
    apps.push(app);
    fixtures.push(fixture);

    const digest = createHash('sha256').update(guard, 'utf8').digest('base64');
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    const header = String(page.headers['content-security-policy'] ?? '');
    expect(header).toContain(`'sha256-${digest}'`);
    expect(header).toContain("script-src 'self' 'sha256-");
    expect(header).not.toContain('unsafe-inline');

    // A non-HTML response carries the base header with no hash — nothing to allow inline.
    const api = await app.inject({ method: 'GET', url: '/api/state' });
    expect(String(api.headers['content-security-policy'] ?? '')).not.toContain('sha256-');
    const asset = await app.inject({ method: 'GET', url: '/assets/app-1.js' });
    expect(String(asset.headers['content-security-policy'] ?? '')).not.toContain('sha256-');
  });

  it('hashes the real shell’s guard exactly as it is served (hash and bytes cannot drift)', async () => {
    const html = readFileSync(join(SITE_ROOT, 'web', 'index.html'), 'utf8');
    const body = /<script id="boot-guard">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(typeof body).toBe('string');

    const fixture = createFixture({});
    const webDist = mkdtempSync(join(tmpdir(), 'book-csp-real-'));
    webDists.push(webDist);
    writeFileSync(join(webDist, 'index.html'), html, 'utf8');
    const app = await buildApp({
      config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: webDist, PORT: '8080' }),
      db: fixture.db,
      state: new StateService(fixture.db),
      version: 'test',
      logger: false,
    });
    apps.push(app);
    fixtures.push(fixture);

    const digest = createHash('sha256').update(body ?? '', 'utf8').digest('base64');
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(String(page.headers['content-security-policy'])).toContain(`'sha256-${digest}'`);
  });

  it('adds no hash for an unparsable shell, and says so once (guard inert, policy never widened)', async () => {
    const fixture = createFixture({});
    const webDist = mkdtempSync(join(tmpdir(), 'book-csp-broken-'));
    webDists.push(webDist);
    // A `<script` with no closing tag: the shell cannot be split into scripts, so no hash.
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><html><head><script>oops</head></html>', 'utf8');
    const logStream = { lines: [] as string[], write(line: string) { this.lines.push(line); } };

    const app = await buildApp({
      config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: webDist, PORT: '8080' }),
      db: fixture.db,
      state: new StateService(fixture.db),
      version: 'test',
      logStream,
    });
    apps.push(app);
    fixtures.push(fixture);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const page = await app.inject({ method: 'GET', url: '/' });
      expect(String(page.headers['content-security-policy'] ?? '')).not.toContain('sha256-');
    }
    const warns = logStream.lines.filter((line) => line.includes('unparsable inline script'));
    expect(warns).toHaveLength(1);
  });
});
