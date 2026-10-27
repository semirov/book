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
  for (const name of ['index.html', 'assets', 'theme.js', 'favicon.svg', 'fonts']) {
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
