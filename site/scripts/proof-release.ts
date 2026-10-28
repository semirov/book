#!/usr/bin/env node
/**
 * scripts/proof-release.ts — BOOK-119: the two proofs, against real artifacts.
 *
 * `npm run proof` runs *after* a real build (`npm run build`), because both proofs are about
 * bytes a browser would receive, not about a helper's return value:
 *
 *   (a) publish release N into a temp tree, boot the real app on it, take the `/assets/…` URL
 *       the shell names, publish N+1, and fetch the old URL again — it must still be **200 and
 *       byte-identical** (sha256 compared). A missing asset must be **404 JSON**, never the
 *       shell: a module script that receives HTML cannot run. The third publish *drops* the
 *       captured asset so the answer can only come from the retained release — the cross-release
 *       lookup, not the current tree, is what keeps an open tab alive.
 *   (b) the built shell in jsdom with the entry script removed (jsdom never executes
 *       `type="module"`, exactly the broken-bundle state): after the guard's five-second wait
 *       the body must print `страница не собралась`, the build sha, the stamp and a reload link
 *       with `?r=`, not a blank document.
 *   (c) BOOK-157 — the installable shell, read from the same tree: the manifest parses and states
 *       the contract the icons rely on, every icon it declares exists and its PNG header is the
 *       size the manifest promises, and `sw.js` exists, names this build's cache, precaches no
 *       prose (no `/api`, no `/healthz`, no `/book.fb2`, no `.html`) and carries no
 *       activation-time takeover.
 *
 * Prints one `key=value`-ish line per proof and PASS/FAIL; exits non-zero on failure.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { JSDOM } from 'jsdom';

import { buildApp } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import { StateService } from '../server/src/ingest/stateService.ts';
import { createFixture } from '../server/test/helpers.ts';
import { currentReleaseId, publish } from './release.mjs';
import { cacheNameFromSource, cacheNameOf, precacheFromSource } from './lib/sw.mjs';

const SITE = resolve(import.meta.dirname, '..');
const DIST = join(SITE, 'web', 'dist');
const GUARD_SENTENCE = 'страница не собралась';

const failures: string[] = [];

function line(text: string): void {
  console.log(text);
}

function check(label: string, condition: boolean, detail = ''): void {
  line(`${label}=${condition ? 'ok' : 'FAIL'}${detail.length > 0 ? ` ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The shell to prove: the build just made (`dist/staging`), else the release `current` names.
 * Staging first is what makes the deploy honest — `proof` runs between `build` and `publish`,
 * so the bytes it checks are exactly the bytes the publish is about to serve.
 */
function shellSource(): string {
  const staging = join(DIST, 'staging');
  if (existsSync(join(staging, 'index.html'))) return staging;
  const id = currentReleaseId(DIST);
  if (id !== null) {
    const root = join(DIST, 'releases', id);
    if (existsSync(join(root, 'index.html'))) return root;
  }
  throw new Error(`no built shell at ${DIST}/staging or ${DIST}/current — run \`npm run build\` first`);
}

/** Copy a release (or the staging tree) into `target`, without a manifest: a staging tree. */
function stage(target: string, source: string, skip: string[] = []): void {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of ['index.html', 'assets', 'theme.js', 'favicon.svg', 'fonts', 'icons', 'manifest.webmanifest', 'sw.js']) {
    if (skip.includes(name)) continue;
    const from = join(source, name);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, name), { recursive: true });
  }
}

/** Proof (a): a captured asset URL survives a publish, and a miss is never the shell. */
async function proofAsset(): Promise<void> {
  const source = shellSource();
  const tree = mkdtempSync(join(tmpdir(), 'book-proof-assets-'));
  const stateDir = join(tree, 'state');
  const webDist = join(tree, 'web');
  mkdirSync(join(webDist, 'releases'), { recursive: true });
  const first = 'proof0001';
  cpSync(source, join(webDist, 'releases', first), { recursive: true });
  // Nothing to strip: a manifest lives in `releases/.manifests/`, never inside a release.
  symlinkSync(join('releases', first), join(webDist, 'current'), 'dir');
  line(`proof a: release1=${first}`);

  const fixture = createFixture({});
  const app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: webDist,
      PORT: '8091',
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'proof',
    logger: false,
  });

  try {
    const page = await app.inject({ method: 'GET', url: '/' });
    const asset = /\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*/u.exec(page.body)?.[0];
    if (asset === undefined) throw new Error('the shell names no /assets/… URL — is this a real build?');
    const name = asset.slice('/assets/'.length);
    const original = readFileSync(join(webDist, 'releases', first, 'assets', name));
    line(`proof a: asset=${asset} bytes=${original.length}`);

    // Same bytes, a new id: the deploy the owner's open tab lived through.
    stage(join(webDist, 'staging'), source);
    const second = publish({ webDist, stateDir, sha: 'proof0002', now: new Date(Date.now() + 1000), log: () => {} });
    line(`proof a: release2=${second.id}`);
    const again = await app.inject({ method: 'GET', url: asset });
    check(
      'proof a: old-asset',
      again.statusCode === 200 && sha256(again.rawPayload) === sha256(original),
      `status=${again.statusCode} sha256_match=${sha256(again.rawPayload) === sha256(original) ? 1 : 0}`,
    );

    // A third publish without the asset: only the retained release can answer now.
    stage(join(webDist, 'staging'), source);
    unlinkSync(join(webDist, 'staging', 'assets', name));
    writeFileSync(join(webDist, 'staging', 'assets', 'index-proof00.js'), 'console.log("proof");\n', 'utf8');
    const third = publish({ webDist, stateDir, sha: 'proof0003', now: new Date(Date.now() + 2000), log: () => {} });
    line(`proof a: release3=${third.id} dropped=${name}`);
    const retained = await app.inject({ method: 'GET', url: asset });
    check(
      'proof a: cross-release',
      retained.statusCode === 200 && sha256(retained.rawPayload) === sha256(original),
      `status=${retained.statusCode}`,
    );

    const miss = await app.inject({ method: 'GET', url: '/assets/does-not-exist.js' });
    const contentType = String(miss.headers['content-type'] ?? '');
    check(
      'proof a: asset-miss',
      miss.statusCode === 404 && contentType.includes('application/json') && !miss.body.includes('<html'),
      `status=${miss.statusCode} content-type=${contentType} html=${miss.body.includes('<html') ? 1 : 0}`,
    );
  } finally {
    await app.close();
    fixture.close();
    rmSync(tree, { recursive: true, force: true });
  }
}

/** Proof (b): the built shell, bundle gone, prints the guard sentence with its identity. */
async function proofGuard(): Promise<void> {
  const source = shellSource();
  const html = readFileSync(join(source, 'index.html'), 'utf8');
  const info = JSON.parse(readFileSync(join(SITE, 'build-info.json'), 'utf8')) as { commit?: string; stamp?: string };
  // The guard prints the seven-character build (BOOK-119 review): `BOOK_BUILD_COMMIT` may be a
  // full sha, and the guard's bytes are budgeted — so the proof compares the same short form.
  const commit = (info.commit ?? 'dev').slice(0, 7);
  const stamp = info.stamp ?? '00.00 00:00';

  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://book.semirov.dev/' });
  const { window } = dom;
  try {
    // The broken state: the entry module is not there (and jsdom would not run it anyway).
    for (const script of window.document.querySelectorAll('script[type="module"]')) script.remove();
    window.dispatchEvent(new window.Event('load'));
    // The guard waits five seconds on `load` before deciding the app never booted.
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_400));
    const body = window.document.body.textContent ?? '';
    const link = window.document.querySelector('a');
    check('proof b: guard-sentence', body.includes(GUARD_SENTENCE), `sha=${body.includes(commit) ? 1 : 0} stamp=${body.includes(stamp) ? 1 : 0}`);
    check('proof b: identity', body.includes(commit) && body.includes(stamp), `commit=${commit} stamp=${stamp}`);
    check(
      'proof b: reload-link',
      link !== null && link.textContent === 'перезагрузить' && (link.getAttribute('href') ?? '').includes('?r='),
      `href=${link?.getAttribute('href') ?? 'none'}`,
    );
  } finally {
    window.close();
  }
}

/**
 * The PNG's own size, read from the IHDR chunk: the header a browser believes, not the file name.
 * `null` when the bytes are not a PNG — a mismatch the caller reports, never a crash.
 */
function pngSize(file: string): { width: number; height: number } | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return null;
  }
  if (bytes.length < 24 || bytes.toString('latin1', 1, 4) !== 'PNG' || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The manifest's contract: what an install shows (name, paper) and what it points at (icons). */
const MANIFEST_FIELDS: Array<[string, string]> = [
  ['name', 'Бланк'],
  ['short_name', 'Бланк'],
  ['lang', 'ru'],
  ['display', 'standalone'],
  ['scope', '/'],
  ['start_url', '/'],
  ['id', '/'],
  ['background_color', '#CFD3D2'],
  ['theme_color', '#CFD3D2'],
];

/** `192x192` → `{ width: 192, height: 192 }`; `null` for anything a browser would reject. */
function declaredSize(value: unknown): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/u.exec(String(value ?? ''));
  if (match === null) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Proof (c): the installable shell — the manifest, the icons it names and the worker. */
function proofPwa(): void {
  const source = shellSource();
  const info = JSON.parse(readFileSync(join(SITE, 'build-info.json'), 'utf8')) as {
    commit?: string;
    stamp?: string;
    builtAt?: string;
  };

  let manifest: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(source, 'manifest.webmanifest'), 'utf8'));
    manifest = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    manifest = null;
  }
  line(`proof c: shell=${source}`);
  const wrongFields = MANIFEST_FIELDS.filter(([key, value]) => manifest?.[key] !== value).map(([key]) => key);
  check('proof c: manifest', manifest !== null && wrongFields.length === 0, `fields=${wrongFields.join(',') || 'ok'}`);

  const icons = Array.isArray(manifest?.icons) ? (manifest.icons as Array<Record<string, unknown>>) : [];
  const declared = icons.map((icon) => ({
    src: String(icon.src ?? ''),
    size: declaredSize(icon.sizes),
    purpose: String(icon.purpose ?? ''),
  }));
  check(
    'proof c: manifest-icons',
    declared.length === 3 &&
      declared.filter((icon) => icon.purpose === 'any').length === 2 &&
      declared.filter((icon) => icon.purpose === 'maskable').length === 1,
    declared.map((icon) => `${icon.src}:${icon.purpose}`).join(' '),
  );

  for (const icon of declared) {
    const file = join(source, icon.src.replace(/^\//u, ''));
    const actual = pngSize(file);
    check(
      `proof c: icon ${icon.src}`,
      icon.size !== null &&
        actual !== null &&
        actual.width === icon.size.width &&
        actual.height === icon.size.height,
      `declared=${icon.size === null ? 'none' : `${String(icon.size.width)}x${String(icon.size.height)}`} actual=${actual === null ? 'none' : `${String(actual.width)}x${String(actual.height)}`}`,
    );
  }

  let sw = '';
  try {
    sw = readFileSync(join(source, 'sw.js'), 'utf8');
  } catch {
    sw = '';
  }
  check('proof c: sw', sw.length > 0, `bytes=${String(sw.length)}`);

  const precache = precacheFromSource(sw) ?? [];
  const refused = precache.filter((path) => path.startsWith('/api') || path === '/healthz' || path === '/book.fb2' || /\.html?$/u.test(path));
  const has = (pattern: RegExp): boolean => precache.some((path) => pattern.test(path));
  check(
    'proof c: sw-precache',
    precache.length > 0 &&
      refused.length === 0 &&
      precache.includes('/theme.js') &&
      has(/^\/assets\/.+\.js$/u) &&
      has(/^\/assets\/.+\.css$/u) &&
      has(/^\/fonts\/.+\.woff2$/u) &&
      has(/^\/icons\/.+\.png$/u),
    `files=${String(precache.length)} refused=${refused.join(',') || 'none'}`,
  );

  const expected = cacheNameOf(info);
  const declaredCache = cacheNameFromSource(sw);
  check('proof c: sw-version', declaredCache === expected, `cache=${declaredCache ?? 'none'} expected=${expected}`);

  // The worker must not take over an open page: a new build may install, never swap under a reader.
  check('proof c: sw-no-takeover', !sw.includes('skipWaiting') && !sw.includes('registration.waiting'), 'activation takeover absent');
}

async function main(): Promise<number> {
  const built =
    existsSync(join(DIST, 'staging', 'index.html')) ||
    existsSync(join(DIST, 'current', 'index.html')) ||
    existsSync(join(DIST, 'index.html'));
  if (!built) {
    console.error('proof: no build — run `npm run build` first');
    return 1;
  }
  try {
    await proofAsset();
    await proofGuard();
    proofPwa();
  } catch (error) {
    console.error(`proof: FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (failures.length > 0) {
    console.error(`proof: FAIL (${failures.length}) — ${failures.join(', ')}`);
    return 1;
  }
  console.log('proof: PASS');
  return 0;
}

process.exitCode = await main();
