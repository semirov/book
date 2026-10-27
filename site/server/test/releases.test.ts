/**
 * BOOK-119 — the server's side of versioned releases.
 *
 * What is asserted is what a browser gets: `current` is the root when it exists, an `/assets/*`
 * URL from the previous shell still answers 200 with the **same bytes** after a newer release
 * is current, and a miss under `/assets/` is 404 JSON — never the shell, whose HTML would be
 * parsed as a module and leave the page blank. The path guard (one segment, Vite's charset) and
 * the re-entry flag are exercised through `inject`, because they exist to stop a request, not
 * to return a value.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { listReleases, servedRoot } from '../src/http/releases.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';

const SHELL = '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/assets/new-2.js"></script></body></html>';
const OLD_ASSET = 'console.log("old release");\n';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let root: string | null = null;

/** A release directory: `index.html` plus one asset. */
function release(webDist: string, id: string, assets: Record<string, string>, shell = SHELL): string {
  const dir = join(webDist, 'releases', id);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), shell, 'utf8');
  for (const [name, content] of Object.entries(assets)) writeFileSync(join(dir, 'assets', name), content, 'utf8');
  return dir;
}

async function boot(webDist: string): Promise<void> {
  fixture = createFixture({});
  app = await buildApp({
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: webDist, PORT: '8080' }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
  });
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

function tempDist(): string {
  root = mkdtempSync(join(tmpdir(), 'book-releases-'));
  return root;
}

describe('servedRoot', () => {
  it('picks `current` when it names a shell, and the flat dist otherwise (Docker, fixtures, dev)', () => {
    const webDist = tempDist();
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'index.html'), SHELL, 'utf8');
    expect(servedRoot(webDist)).toBe(webDist);

    release(webDist, 'aaaaaaa-20260101T000000Z', { 'new-2.js': OLD_ASSET });
    symlinkSync(join('releases', 'aaaaaaa-20260101T000000Z'), join(webDist, 'current'), 'dir');
    expect(servedRoot(webDist)).toBe(join(webDist, 'current'));

    // A dangling symlink is not a shell: fall back to the flat tree rather than a 404 site.
    rmSync(join(webDist, 'current'), { force: true });
    symlinkSync(join('releases', 'gone'), join(webDist, 'current'), 'dir');
    expect(servedRoot(webDist)).toBe(webDist);
  });
});

describe('an old release keeps answering its assets', () => {
  it('serves the previous shell asset with the same bytes and the immutable policy', async () => {
    const webDist = tempDist();
    release(webDist, 'aaaaaaa-20260101T000000Z', { 'old-1.js': OLD_ASSET }, '<!doctype html><title>old</title>');
    release(webDist, 'bbbbbbb-20260102T000000Z', { 'new-2.js': 'console.log("new release");\n' });
    symlinkSync(join('releases', 'bbbbbbb-20260102T000000Z'), join(webDist, 'current'), 'dir');
    await boot(webDist);

    const old = await app!.inject({ method: 'GET', url: '/assets/old-1.js' });
    expect(old.statusCode).toBe(200);
    expect(old.body).toBe(OLD_ASSET);
    // The name is the hash of the bytes: a year is the honest policy, across releases too.
    expect(old.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const current = await app!.inject({ method: 'GET', url: '/assets/new-2.js' });
    expect(current.statusCode).toBe(200);

    // The shell and the SPA fallback are unchanged.
    for (const url of ['/', '/privacy', '/rules', '/ch-8']) {
      const page = await app!.inject({ method: 'GET', url });
      expect(page.statusCode, url).toBe(200);
      expect(String(page.headers['content-type']), url).toContain('text/html');
      expect(page.body, url).toContain('id="root"');
    }
    expect(listReleases(webDist).map((entry) => entry.id)).toEqual([
      'bbbbbbb-20260102T000000Z',
      'aaaaaaa-20260101T000000Z',
    ]);
  });
});

describe('an asset miss is JSON, never the shell', () => {
  it('answers 404 JSON for a name no retained release holds', async () => {
    const webDist = tempDist();
    release(webDist, 'aaaaaaa-20260101T000000Z', { 'old-1.js': OLD_ASSET });
    symlinkSync(join('releases', 'aaaaaaa-20260101T000000Z'), join(webDist, 'current'), 'dir');
    await boot(webDist);

    const miss = await app!.inject({ method: 'GET', url: '/assets/does-not-exist.js' });
    expect(miss.statusCode).toBe(404);
    expect(String(miss.headers['content-type'])).toContain('application/json');
    expect(miss.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(miss.body).not.toContain('<html');
    // A miss is not an asset: it must not be pinned for a year.
    expect(miss.headers['cache-control']).toBe('no-store');
  });

  it('rejects escapes, nested names and an empty name, and leaks no file outside assets', async () => {
    const webDist = tempDist();
    const dir = release(webDist, 'aaaaaaa-20260101T000000Z', { 'old-1.js': OLD_ASSET });
    writeFileSync(join(dir, 'secret.js'), 'SECRET', 'utf8');
    symlinkSync(join('releases', 'aaaaaaa-20260101T000000Z'), join(webDist, 'current'), 'dir');
    await boot(webDist);

    const attempts = [
      '/assets/..%2Fsecret.js',
      '/assets/..%2fsecret.js',
      '/assets/a/b.js',
      '/assets/',
      '/assets/%2e%2e%2fsecret.js',
    ];
    for (const url of attempts) {
      const response = await app!.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      expect(String(response.headers['content-type']), url).toContain('application/json');
      expect(response.body, url).not.toContain('SECRET');
      expect(response.body, url).not.toContain('<html');
    }
  });

  it('answers 503 instead of recursing when the served shell disappears mid-swap', async () => {
    const webDist = tempDist();
    const dir = release(webDist, 'aaaaaaa-20260101T000000Z', { 'old-1.js': OLD_ASSET });
    symlinkSync(join('releases', 'aaaaaaa-20260101T000000Z'), join(webDist, 'current'), 'dir');
    await boot(webDist);

    // The first BOOK-119 publish adopts a flat `dist` and moves its `index.html` away before
    // the restart: for seconds the process's root has no shell. `sendFile` would call
    // `callNotFound` again — the answer must be a 503, not a loop.
    rmSync(join(dir, 'index.html'));
    const response = await app!.inject({ method: 'GET', url: '/ch-8' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'UI_NOT_BUILT' });
    expect(response.headers['cache-control']).toBe('no-store');

    // The asset lookup is marked the same way: a retained release's file is served, and a
    // real miss inside that release still ends as JSON.
    const asset = await app!.inject({ method: 'GET', url: '/assets/old-1.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe(OLD_ASSET);
  });

  it('does not recurse when a "release" only holds a directory under that name', async () => {
    const webDist = tempDist();
    const dir = release(webDist, 'aaaaaaa-20260101T000000Z', {});
    mkdirSync(join(dir, 'assets', 'ghost.js'), { recursive: true });
    symlinkSync(join('releases', 'aaaaaaa-20260101T000000Z'), join(webDist, 'current'), 'dir');
    await boot(webDist);

    // `statSync` says "not a file", so `sendFile` is never asked and `callNotFound` is never
    // re-entered. Repeating the request pins that there is no loop.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app!.inject({ method: 'GET', url: '/assets/ghost.js' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});

describe('a release manifest is never served', () => {
  it('keeps the manifest bytes out of every URL a reader can reach', async () => {
    const webDist = tempDist();
    const id = 'aaaaaaa-20260101T000000Z';
    const sha = 'f00df00df00df00df00df00df00df00df00df00d';
    release(webDist, id, { 'old-1.js': OLD_ASSET });
    // The layout `scripts/release.mjs` writes: the manifest beside the releases, outside the
    // served root (`current` → `releases/<id>`), so no URL under it can hand out a full sha,
    // a file count or a byte count.
    mkdirSync(join(webDist, 'releases', '.manifests'), { recursive: true });
    writeFileSync(
      join(webDist, 'releases', '.manifests', `${id}.json`),
      `${JSON.stringify({ id, sha, files: 3, bytes: 12_345 }, null, 2)}\n`,
      'utf8',
    );
    symlinkSync(join('releases', id), join(webDist, 'current'), 'dir');
    await boot(webDist);

    for (const url of ['/release.json', `/.manifests/${id}.json`, `/releases/.manifests/${id}.json`]) {
      const response = await app!.inject({ method: 'GET', url });
      expect(response.body, url).not.toContain(sha);
      expect(response.body, url).not.toContain('12345');
      expect(String(response.headers['content-type']), url).not.toContain('application/json');
    }
    // The index is not a release either: an `/assets/*` miss never looks inside it.
    expect(listReleases(webDist).map((entry) => entry.id)).toEqual([id]);
  });
});

describe('the retained-release lookup is memoised by the store', () => {
  it('sees a publish without a restart — the directory’s mtime is the key', async () => {
    const webDist = tempDist();
    release(webDist, 'aaaaaaa-20260101T000000Z', { 'old-1.js': OLD_ASSET });
    symlinkSync(join('releases', 'aaaaaaa-20260101T000000Z'), join(webDist, 'current'), 'dir');
    await boot(webDist);

    const before = await app!.inject({ method: 'GET', url: '/assets/late-9.js' });
    expect(before.statusCode).toBe(404);

    // A publish renames a new directory into `releases/`, which moves the store's own mtime.
    // (The pause keeps the two stamps distinguishable on a filesystem with coarse mtimes.)
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(webDist, 'bbbbbbb-20260102T000000Z', { 'late-9.js': 'LATE\n' });

    const after = await app!.inject({ method: 'GET', url: '/assets/late-9.js' });
    expect(after.statusCode).toBe(200);
    expect(after.body).toBe('LATE\n');
  });
});
