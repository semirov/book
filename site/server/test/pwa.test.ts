/**
 * BOOK-157 — the installable shell, asserted on the files a browser is served.
 *
 * Two promises are under test, and both are about bytes:
 *
 *   · **an install is possible.** The manifest parses, states the field contract, and every icon
 *     it declares exists with the size the header really carries (read from the PNG's IHDR, not
 *     from the file name). `sw.js` is a file the server answers as JavaScript with
 *     `cache-control: no-cache` — storable (a `no-store` worker cannot be registered) and
 *     revalidated before every use (or a release outlives itself) — and never answers `304`.
 *   · **no prose is kept.** BOOK-109 stands: the precache list holds content-hashed assets, the
 *     pre-paint theme file, fonts and icons, and nothing else — no `/api`, no `/healthz`, no
 *     `/book.fb2`, no `.html`. The offline document is a constant in the worker, and the worker
 *     never takes an open page over.
 *
 * The two files an install reads are also the two files that must never fall through to the SPA
 * shell: an HTML body parsed as a service worker is a silent dead end, so a miss is 404 JSON.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANY_SIZES,
  BAND,
  COVER_WIDTH,
  MASKABLE_BAND,
  MASKABLE_CANVAS,
  MASKABLE_INSET,
  SAFE_RADIUS,
  maskableGeometry,
} from '../../scripts/lib/icons.mjs';
import {
  OFFLINE_SENTENCE,
  RULES,
  cacheNameFromSource,
  cacheNameOf,
  classify,
  offlineDocument,
  precacheFromSource,
  precacheList,
  swSource,
} from '../../scripts/lib/sw.mjs';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { buildCsp } from '../src/http/csp.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';

const SITE = resolve(import.meta.dirname, '..', '..');
const WEB = join(SITE, 'web');
const PUBLIC = join(WEB, 'public');
const MANIFEST = readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8');
const SHELL = readFileSync(join(WEB, 'index.html'), 'utf8');

/** A PNG's own size, from the IHDR chunk — the header a browser believes. */
function pngSize(file: string): { width: number; height: number } | null {
  const bytes = readFileSync(file);
  if (bytes.length < 24 || bytes.toString('latin1', 1, 4) !== 'PNG' || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const manifest = JSON.parse(MANIFEST) as {
  name: string;
  short_name: string;
  lang: string;
  display: string;
  scope: string;
  start_url: string;
  id: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
};

describe('the manifest an install reads', () => {
  it('names the book, in Russian, standalone, from the root', () => {
    expect(manifest).toEqual({
      name: 'Бланк',
      short_name: 'Бланк',
      lang: 'ru',
      display: 'standalone',
      scope: '/',
      start_url: '/',
      id: '/',
      // The day paper the served `<meta name="theme-color">` already carries: a manifest file
      // cannot vary by `prefers-color-scheme`, and `/theme.js` sets the night bar after paint.
      background_color: '#CFD3D2',
      theme_color: '#CFD3D2',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  });

  it('declares icons that exist and carry the size the manifest promises', () => {
    for (const icon of manifest.icons) {
      expect(icon.type, icon.src).toBe('image/png');
      const actual = pngSize(join(PUBLIC, icon.src.replace(/^\//u, '')));
      expect(actual, `${icon.src} is not a PNG`).not.toBeNull();
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(actual?.width, `${icon.src} width`).toBe(width);
      expect(actual?.height, `${icon.src} height`).toBe(height);
    }
    // A maskable plate is a square 512 with the drawing inside the field, so it is the only
    // `purpose: maskable`, and the two `any` plates are the two sizes launchers ask for.
    expect(manifest.icons.filter((icon) => icon.purpose === 'maskable')).toHaveLength(1);
    expect(manifest.icons.filter((icon) => icon.purpose === 'any').map((icon) => icon.sizes)).toEqual([
      '192x192',
      '512x512',
    ]);
    expect(ANY_SIZES.map((px) => `${String(px)}x${String(px)}`)).toEqual(
      manifest.icons.filter((icon) => icon.purpose === 'any').map((icon) => icon.sizes),
    );
    expect(manifest.icons.find((icon) => icon.purpose === 'maskable')?.sizes).toBe(
      `${String(MASKABLE_CANVAS)}x${String(MASKABLE_CANVAS)}`,
    );
  });

  it('keeps the whole painted maskable band inside the safe circle', () => {
    // The maskable spec's safe zone is a circle of 40 % of the canvas. A square band survives a
    // circular mask only if its *corners* do: `band · √2 / 2 ≤ 0.4 · 512` ⇒ band ≤ 289. The first
    // plate used 420, whose corners sat 296 px from the centre — 91 px inside the circle, so a
    // mask clipped the painted frame. These numbers are `scripts/icons.mjs`'s, asserted as
    // arithmetic: a plate that is too large cannot pass on a comment alone.
    const geometry = maskableGeometry();
    expect(geometry.canvas).toBe(MASKABLE_CANVAS);
    expect(MASKABLE_CANVAS).toBe(512);
    expect(geometry.band).toBe(MASKABLE_BAND);
    expect(geometry.band).toBeLessThanOrEqual(289);
    expect(geometry.inset).toBe(MASKABLE_INSET);
    expect(geometry.inset).toBeGreaterThanOrEqual(111);
    expect(geometry.band + 2 * geometry.inset).toBe(MASKABLE_CANVAS);
    expect(geometry.safeRadius).toBe(SAFE_RADIUS);
    expect(geometry.safeRadius).toBe(0.4 * MASKABLE_CANVAS);
    expect(geometry.halfDiagonal).toBeLessThanOrEqual(geometry.safeRadius);
    expect(geometry.fits).toBe(true);
    // The band is the cover's own width, uncropped: the door post and the figures keep the edges.
    expect(BAND).toBe(COVER_WIDTH);
    expect(BAND).toBe(1024);
  });
});

describe('the worker keeps no prose (BOOK-109)', () => {
  it('precaches the hashed assets, the theme file, the fonts and the icons — and nothing else', () => {
    const files = [
      'index.html',
      'manifest.webmanifest',
      'sw.js',
      'theme.js',
      'favicon.svg',
      'assets/index-Bx12_3de.js',
      'assets/index-Bx12_3de.css',
      'assets/chapter-Bq91x2.js',
      'assets/notes.js',
      'assets/app-a.js',
      'fonts/ptserif-400-cyrillic.woff2',
      'fonts/LICENSE.md',
      'icons/icon-192.png',
      'icons/maskable-512.png',
      'icons/notes.svg',
      'cover/cover.png',
      'book.fb2',
      'api/state.json',
      'ch-8.html',
    ];
    expect(precacheList(files)).toEqual([
      '/assets/chapter-Bq91x2.js',
      '/assets/index-Bx12_3de.css',
      '/assets/index-Bx12_3de.js',
      '/fonts/ptserif-400-cyrillic.woff2',
      '/icons/icon-192.png',
      '/icons/maskable-512.png',
      '/theme.js',
    ]);
    // `assets/notes.js` has no hash in its name and `assets/app-a.js` a one-character one: a name
    // that is not a hash keeps no promise about its bytes, so neither is cache-first material.
    expect(precacheList(['assets/notes.js', 'assets/app-a.js'])).toEqual([]);
  });

  it('refuses the book, the API and every document even when they are offered', () => {
    const paths = precacheList(['/api/chapters/1', '/healthz', '/book.fb2', '/index.html', '/privacy.html', '/sw.js']);
    expect(paths).toEqual([]);
    expect(paths.join(' ')).not.toMatch(/\/api|\/healthz|\/book\.fb2|\.html/u);
  });

  it('routes every class the way the module comment says', () => {
    // The document: network only, and the constant when there is no network.
    expect(classify('https://book.semirov.dev/', 'navigate')).toBe('document');
    expect(classify('https://book.semirov.dev/ch-8.html')).toBe('document');
    // The book and its transport: untouched.
    for (const url of ['/api/state', '/api/chapters/1?at=5', '/healthz', '/book.fb2', '/ws']) {
      expect(classify(url), url).toBe('passthrough');
    }
    // Nothing promised: fetched by the browser, never stored by the worker.
    for (const url of ['/manifest.webmanifest', '/sw.js', '/favicon.svg', '/cover/cover.png']) {
      expect(classify(url), url).toBe('passthrough');
    }
    // Names are hashes: cache first. Everything else the shell needs: network first.
    expect(classify('/assets/index-Bx12_3de.js')).toBe('asset');
    for (const url of ['/theme.js', '/fonts/ptserif-400-cyrillic.woff2', '/icons/icon-192.png']) {
      expect(classify(url), url).toBe('unhashed');
    }
    // A worker sees *absolute* URLs (`request.url`), so the pathname is what decides: a table
    // that compared the whole string against `/assets/` would miss every hashed file.
    expect(classify('https://book.semirov.dev/assets/index-Bx12_3de.js')).toBe('asset');
    expect(classify('https://book.semirov.dev/api/chapters/1?at=5')).toBe('passthrough');
    expect(classify('https://book.semirov.dev/theme.js')).toBe('unhashed');
    expect(classify('https://book.semirov.dev/ch-8.html')).toBe('document');
    // The lists the source is generated from are the same ones classify reads.
    expect(RULES.passthrough).toContain('/api/');
  });
});

describe('the generated sw.js', () => {
  const info = { commit: 'abc1234', stamp: '27.10 20:52', builtAt: '2026-10-27T17:52:00.000Z' };
  const cacheName = cacheNameOf(info);
  const precache = ['/assets/index-Bx12_3de.js', '/theme.js', '/icons/icon-192.png'];
  const offline = offlineDocument({ js: '/assets/index-Bx12_3de.js', css: '/assets/index-Bx12_3de.css' });
  const source = swSource({ cacheName, precache, offline });

  it('versions the cache by the build, so two releases never share one', () => {
    expect(cacheName).toBe('book-shell-abc1234-27102052-20261027T175200Z');
    // The stamp alone is minute-granular: the build's own second is what makes it unique.
    expect(cacheNameOf({ ...info, builtAt: '2026-10-27T17:52:41.000Z' })).not.toBe(cacheName);
    expect(cacheNameOf({ commit: 'dev' })).toBe('book-shell-dev-0');
    expect(cacheNameFromSource(source)).toBe(cacheName);
    expect(precacheFromSource(source)).toEqual(precache);
  });

  it('carries the offline document as a constant, and it is a shell, not a page of the book', () => {
    expect(offline.startsWith('<!doctype html>')).toBe(true);
    expect(offline).toContain('<html lang="ru" data-theme="day" data-offline="1">');
    expect(offline).toContain('viewport-fit=cover');
    expect(offline).toContain('<meta name="theme-color" content="#CFD3D2" />');
    expect(offline).toContain('<script src="/theme.js"></script>');
    expect(offline).toContain('<link rel="stylesheet" href="/assets/index-Bx12_3de.css" />');
    expect(offline).toContain('<script type="module" src="/assets/index-Bx12_3de.js" data-critical></script>');
    // The sentence is the document's content, with no class behind it: a reader whose hashed
    // `/assets/*` were evicted from the HTTP cache still gets words, not a blank page. Safe to
    // sit in `#root` because `createRoot(...).render` clears the container on mount.
    expect(offline).toMatch(/<div id="root">\s*<p>[^<]+<\/p>\s*<\/div>/u);
    expect(offline).toContain(`<p>${OFFLINE_SENTENCE}</p>`);
    expect(OFFLINE_SENTENCE).toBe('сети нет — главы читаются с сервера, офлайн их нет');
    // No class dependency, no book text: the paragraph carries no attribute at all.
    expect(offline).not.toContain('<p class=');
    expect(offline).toContain('<noscript>');
    // Served as a document that is never stored, and it holds no prose of its own.
    expect(source).toContain("'cache-control': 'no-store'");
    expect(source).toContain('const OFFLINE = ');
    // A path that is not a static path cannot be quoted into the document.
    expect(() => offlineDocument({ js: '/a" onload="x' })).toThrow(/not a static path/u);
  });

  it('deletes every other shell cache on activate, and never takes an open page over', () => {
    // `skipWaiting(` and a waiting-worker takeover are the two ways a new build swaps code under
    // a reader mid-sentence: neither is called anywhere in the generated file.
    expect(source).not.toContain('skipWaiting');
    expect(source).not.toMatch(/registration\.waiting/u);
    expect(source).toContain('self.clients.claim()');
    expect(source).toMatch(/name\.indexOf\(PREFIX\) === 0 && name !== CACHE/u);
    expect(source).toContain('caches.delete(name)');
    expect(source).toContain('caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))');
  });

  it('lets a new build take over on the next navigation: a document never comes from a cache', () => {
    // BOOK-157 §4 — the stale-bundle defect the deploy crashed into twice: a phone that kept the
    // old bundle after a new release. The rule that makes it impossible is here, in the worker:
    // a navigation is a **document** (network, `no-store` from `http/cache.ts`, the constant only
    // when the network fails), and the one cache-first class is `/assets/`, whose file names *are*
    // their bytes. So the next navigation's `index.html` names the new hashes and the old cache
    // cannot answer for them.
    expect(classify('/', 'navigate')).toBe('document');
    expect(classify('/ch/3', 'navigate')).toBe('document');
    expect(classify('/index.html', '')).toBe('document');
    expect(classify('/assets/index-Bx12_3de.js', '')).toBe('asset');
    expect(classify('/theme.js', '')).toBe('unhashed');

    // The generated worker's document answer is a fetch with the constant as its fallback: no
    // `caches` in that path at all — a cached HTML would be the stale bundle with a new coat.
    const documentAnswer = /async function documentAnswer\(request\) \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? '';
    expect(documentAnswer).toContain('await fetch(request)');
    expect(documentAnswer).not.toContain('caches');
    expect(documentAnswer).toContain('offlineAnswer()');

    // A new build stamp is a new cache with its own name, and activation deletes every other
    // `book-shell-*`: two releases never share one cache, and the old one cannot keep answering.
    const next = cacheNameOf({ ...info, stamp: '28.10 09:41', builtAt: '2026-10-28T06:41:12.000Z' });
    expect(next).not.toBe(cacheName);
    const nextSource = swSource({ cacheName: next, precache, offline });
    expect(cacheNameFromSource(nextSource)).toBe(next);
    expect(nextSource).toMatch(/name\.indexOf\(PREFIX\) === 0 && name !== CACHE/u);
    // And the worker itself is `no-cache` on the wire (BOOK-157), so a browser revalidates it
    // before every use and never runs an older release's worker (`cache.ts`).
  });

  it('is valid JavaScript a worker can parse', () => {
    // Compiled, not run: the file calls `self.addEventListener` at the top level, which only a
    // worker has. A syntax error here would ship a worker that never installs.
    expect(() => new Script(source)).not.toThrow();
  });
});

describe('the shell keeps its one inline script', () => {
  it('links the manifest and the touch icon, and leaves the boot guard alone', () => {
    expect(SHELL).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(SHELL).toContain('<link rel="apple-touch-icon" href="/icons/icon-192.png" />');
    // The guard's bytes are the CSP hash: still exactly one inline script, still first, and the
    // entry still carries `data-critical` so a broken bundle is reported at once (BOOK-119).
    const inline = [...SHELL.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu)];
    expect(inline).toHaveLength(1);
    expect(SHELL).toContain('<script id="boot-guard">');
    expect(inline[0]?.[1]).toContain('страница не собралась');
    expect(SHELL).toMatch(/<script type="module" src="\/src\/main\.tsx" data-critical><\/script>/u);
    // The installed app keeps its safe areas, and `/theme.js` stays a file (one hash, one policy).
    expect(SHELL).toContain('viewport-fit=cover');
    expect(SHELL).toContain('<script src="/theme.js"></script>');
  });
});

describe('the CSP names the worker', () => {
  const base = { publicOrigin: 'https://book.semirov.dev', metrikaId: '' };

  it('allows only a same-origin worker, and still hashes the guard rather than widening', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'none' });
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    // The hash behaviour is unchanged: a caller's digest is the only inline script allowed.
    expect(buildCsp({ ...base, captchaProvider: 'none' }, ['abc'])).toContain("script-src 'self' 'sha256-abc'");
  });
});

// --- at the wire ---------------------------------------------------------------------------------

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

const SW_SOURCE = 'self.addEventListener("install", () => {});\n';

async function boot(options: { files?: boolean } = {}): Promise<void> {
  fixture = createFixture({});
  webDist = mkdtempSync(join(tmpdir(), 'book-pwa-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');
  if (options.files !== false) {
    writeFileSync(join(webDist, 'sw.js'), SW_SOURCE, 'utf8');
    writeFileSync(join(webDist, 'manifest.webmanifest'), MANIFEST, 'utf8');
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'assets', 'index-Bx12_3de.js'), 'console.log("книга");', 'utf8');
  }
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
  if (webDist !== null) rmSync(webDist, { recursive: true, force: true });
  webDist = null;
});

describe('the two files an install reads, on a temp webDist', () => {
  it('serves sw.js as JavaScript that may be kept but must be revalidated', async () => {
    await boot();
    for (const url of ['/sw.js', '/sw.js?build=1']) {
      const response = await app!.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(String(response.headers['content-type']), url).toContain('text/javascript');
      // `no-cache`, not `no-store`: a browser cannot register a worker it may not keep, and a
      // worker it may keep without asking would outlive its release.
      expect(response.headers['cache-control'], url).toBe('no-cache');
      expect(response.body, url).toBe(SW_SOURCE);
    }
  });

  it('answers a conditional request for sw.js with the worker, never a 304', async () => {
    await boot();
    const first = await app!.inject({ method: 'GET', url: '/sw.js' });
    const etag = String(first.headers.etag);
    expect(etag).not.toBe('undefined');
    const again = await app!.inject({
      method: 'GET',
      url: '/sw.js',
      headers: { 'if-none-match': etag, 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT' },
    });
    // `/sw.js` is not in `REVALIDATABLE`: the header is dropped and the bytes of *this* release
    // are sent, so no browser keeps running the previous worker.
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe(SW_SOURCE);
    expect(again.headers['cache-control']).toBe('no-cache');
  });

  it('serves the manifest as a manifest', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('application/manifest+json');
    // The book's name is public by design; what must not happen is the SPA shell answering here.
    expect(response.body).not.toContain('<html');
    expect(JSON.parse(response.body).name).toBe('Бланк');
  });

  it('answers a missing sw.js, manifest or icon with 404 JSON, never the shell', async () => {
    await boot({ files: false });
    for (const url of ['/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/maskable-512.png']) {
      const response = await app!.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      expect(String(response.headers['content-type']), url).toContain('application/json');
      expect(response.body, url).not.toContain('<html');
      expect(response.json(), url).toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});
