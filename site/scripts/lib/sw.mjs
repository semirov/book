/**
 * scripts/lib/sw.mjs — BOOK-157: the offline shell's build-time logic, and the source of `sw.js`.
 *
 * The site is installable as an app, and an installed app opened with no network must say what
 * is true instead of showing a browser error. That is the whole job of the service worker here:
 * a **shell** for the static files that carry no prose, and a written answer when a document
 * cannot be fetched. BOOK-109 stands above all of it — no chapter, no `/api/*`, no `/healthz`, no
 * `/book.fb2` and no HTML document is ever stored, and the offline document is built from a
 * constant in `sw.js`, never from a cached page. Nothing here may be widened into "cache the
 * book for offline reading": that would be the stale-prose defect with a new coat.
 *
 * Two rules keep a release from mixing with another one:
 *
 *   · the cache name carries the build (`commit` + the build stamp), and `activate` deletes every
 *     other `book-shell-*` cache — one release's shell, never two;
 *   · only content-hashed names (`/assets/<name>-<hash>.js|css`) are cache-*first*. The unhashed
 *     files the shell needs before paint — `/theme.js`, the fonts, the icons — are
 *     network-*first*, and the cache answers only when the network does not: serving an old
 *     `theme.js` while the network is up would mix two releases in one page.
 *
 * Everything the build and the tests need is a pure function of its arguments; the `.mjs` is
 * read by `server/test/pwa.test.ts` through `sw.d.mts`. `scripts/sw-build.mjs` writes the result
 * into `web/dist/staging/sw.js`, so a publish ships the file with the release it names.
 */

/** Every cache this worker owns starts here; `activate` prunes the rest of the family. */
export const CACHE_PREFIX = 'book-shell-';

/** Paths that are the book or its transport: never cached, never answered by the worker. */
export const RULES = {
  passthrough: ['/api/', '/healthz', '/book.fb2', '/ws'],
  // The name is the hash of the bytes (`index-Bx12_3de.js`): the same URL can only be the same
  // file, in this release and in every retained one.
  cacheFirst: ['/assets/'],
  // Unhashed and needed by the shell: fetched from the network every time, the cache is the
  // offline fallback only.
  networkFirst: ['/theme.js', '/fonts/', '/icons/'],
};

/**
 * The one decision table, used by `classify` here and — as source text — by `sw.js` itself (see
 * `swSource`). It reads only its arguments, so `String(classifyWith)` is a faithful copy and the
 * worker cannot drift from the function the tests exercise.
 *
 * `mode === 'navigate'` is the document request (the page itself); `.html` is the same answer.
 * The default is `passthrough`: an unknown static file (the manifest, the favicon, a cover image)
 * is fetched by the browser untouched — the worker stores nothing it did not promise to store.
 */
export function classifyWith(rules, url, mode) {
  // A worker's `request.url` is absolute (`https://book.semirov.dev/assets/…`); a test's may be a
  // path. One resolution against a dummy origin answers both, and it is the *pathname* that
  // decides — never the query, never the host.
  let path;
  try {
    path = new URL(String(url), 'https://book.invalid').pathname;
  } catch {
    return 'passthrough';
  }
  if (mode === 'navigate' || path.endsWith('.html')) return 'document';
  for (const prefix of rules.passthrough) {
    if (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix) return 'passthrough';
  }
  for (const prefix of rules.cacheFirst) {
    if (path.startsWith(prefix)) return 'asset';
  }
  for (const prefix of rules.networkFirst) {
    if (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix) return 'unhashed';
  }
  return 'passthrough';
}

/** `classifyWith` bound to this release's table. */
export function classify(url, mode = '') {
  return classifyWith(RULES, url, mode);
}

/** Digits only: `27.10 20:52` → `27102052`. The stamp's own punctuation is not a name. */
function digitsOf(value) {
  return String(value ?? '').replace(/\D/gu, '');
}

/** `2026-10-27T17:52:00.000Z` → `20261027T175200Z`; `null` when the build recorded no moment. */
function compactBuiltAt(value) {
  const parsed = new Date(String(value ?? ''));
  if (Number.isNaN(parsed.getTime())) return null;
  // The milliseconds are not part of the name: the second is the unit two builds can differ by.
  return parsed.toISOString().replace(/\.\d{3}Z$/u, 'Z').replace(/[-:]/gu, '');
}

/**
 * `book-shell-<commit>-<stamp>-<builtAt>` — unique per build.
 *
 * The stamp `build-info.json` records is minute-granular, and two builds of one commit inside one
 * minute would otherwise share a cache name — i.e. two releases in one cache, the exact mixing
 * this name exists to prevent. The build's own instant (to the second) is appended when it is
 * there; a tree without it falls back to the stamp alone.
 */
export function cacheNameOf(info) {
  const commit = String(info?.commit ?? '').trim() || 'dev';
  const stamp = digitsOf(info?.stamp) || '0';
  const builtAt = compactBuiltAt(info?.builtAt);
  return `${CACHE_PREFIX}${commit}-${stamp}${builtAt === null ? '' : `-${builtAt}`}`;
}

/**
 * The files a release may keep: its content-hashed scripts and sheets, the pre-paint theme file,
 * the fonts and the icons. Nothing else — a `/book.fb2`, an `/api/*` answer or an HTML document
 * in this list would be the stale-prose defect with a cache in front of it.
 */
const PRECACHE_RULES = [
  // The name must *be* a hash (`index-Bx12_3de.js`): Vite's `[name]-[hash]` with at least four
  // hash characters. An unhashed `/assets/*.js` keeps no promise about its bytes, so it is not
  // cache-first material and is not stored at all.
  /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{4,}\.(?:js|css)$/u,
  /^\/theme\.js$/u,
  /^\/fonts\/[^/]+\.woff2$/u,
  /^\/icons\/[^/]+\.png$/u,
];

/**
 * `web/dist/staging`'s file list (repo-relative, as a directory walk returns it) → the precache
 * list: absolute, de-duplicated, sorted. The explicit refusals stay even though the allow-list
 * above already excludes them: a reader of this function must see the rule, not infer it.
 */
export function precacheList(paths) {
  const seen = new Set();
  for (const raw of paths) {
    const path = `/${String(raw).replace(/^\.?\//u, '')}`;
    if (path === '/sw.js') continue;
    if (/\.html?$/u.test(path)) continue;
    if (path.startsWith('/api/') || path === '/healthz' || path === '/book.fb2') continue;
    if (!PRECACHE_RULES.some((rule) => rule.test(path))) continue;
    seen.add(path);
  }
  return [...seen].sort();
}

/** One absolute static path, quoted into the offline document — never a `"`, a `<` or a scheme. */
function safePath(value, what) {
  const path = String(value);
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(path)) throw new Error(`offline document: ${what} is not a static path: ${path}`);
  return path;
}

/**
 * The sentence the offline shell prints — the same words, in the same register, as
 * `web/src/components/Offline.tsx` (one fact, one verb, lowercase). Pinned against that component
 * by `web/src/components/offline.test.tsx`: the worker cannot import the SPA, so the string lives
 * in both and a test holds them together.
 */
export const OFFLINE_SENTENCE = 'сети нет — главы читаются с сервера, офлайн их нет';

/**
 * The document a navigation gets with no network — the whole of it, in `sw.js`, with no cached
 * HTML behind it: `data-offline="1"` is what makes the page render the offline register instead
 * of the app, and the shell's own hashed CSS and entry module let that register paint in the
 * book's type. No sentence of the book is in here.
 *
 * The sentence is plain text inside `#root`, with no class behind it. It is the document's only
 * content until the bundle boots, so a reader whose release was evicted from the HTTP cache — the
 * hashed `/assets/*` the module script names are gone — still gets words instead of a blank
 * page. `createRoot(...).render` clears the container, so the app never sees it.
 */
export function offlineDocument({ js, css = null }) {
  const script = safePath(js, 'the entry script');
  const styles = css === null ? '' : `    <link rel="stylesheet" href="${safePath(css, 'the stylesheet')}" />\n`;
  return [
    '<!doctype html>',
    '<html lang="ru" data-theme="day" data-offline="1">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    '    <meta name="theme-color" content="#CFD3D2" />',
    '    <title>Бланк — Филипп Семиров</title>',
    styles.trimEnd(),
    '    <script src="/theme.js"></script>',
    '  </head>',
    '  <body>',
    '    <div id="root">',
    `      <p>${OFFLINE_SENTENCE}</p>`,
    '    </div>',
    '    <noscript>',
    '      <div class="noscript">',
    '        <p>для чтения нужен браузер с JavaScript</p>',
    '      </div>',
    '    </noscript>',
    `    <script type="module" src="${script}" data-critical></script>`,
    '  </body>',
    '</html>',
    '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * The whole of `sw.js`.
 *
 * There is no activation-time takeover call and no waiting override anywhere in the generated
 * file: a new build must not swap code under a reader mid-sentence. `clients.claim()` on
 * `activate` is the only thing a new worker does to open pages, and only for the offline shell.
 * The fetch handler is one dispatch through `classifyWith` — see the module comment for why each
 * class is answered the way it is.
 */
export function swSource({ cacheName, precache, offline }) {
  return `/*
 * sw.js — the offline shell (BOOK-157). Generated by scripts/sw-build.mjs from
 * scripts/lib/sw.mjs; do not edit this file, edit the builder and re-run \`npm run build\`.
 *
 * Release ${cacheName}. It stores the files whose names are their bytes, plus the unhashed files
 * the shell needs before paint (/theme.js, the fonts, the icons) — and nothing else: no chapter,
 * no /api answer, no /book.fb2, no HTML document (BOOK-109). A navigation with no network is
 * answered with the constant below.
 */
'use strict';

const CACHE = ${JSON.stringify(cacheName)};
const PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const PRECACHE = ${JSON.stringify(precache)};
const RULES = ${JSON.stringify(RULES)};
const OFFLINE = ${JSON.stringify(offline)};

/* The same decision table the build tests: keep this function's body in sync with
 * scripts/lib/sw.mjs \`classifyWith\` — the builder copies it, so it cannot drift silently. */
${String(classifyWith)}

function offlineAnswer() {
  return new Response(OFFLINE, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* A document is never cached: the network's answer when it comes, the constant when it does not. */
async function documentAnswer(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineAnswer();
  }
}

/* The name is the hash of the bytes, so the stored copy can only be this release's file. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit !== undefined && hit !== null) return hit;
  return fetch(request);
}

/* Network first: an old theme.js or font must never be served while the network is up. */
async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    if (hit !== undefined && hit !== null) return hit;
    throw error;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const stale = names.filter((name) => name.indexOf(PREFIX) === 0 && name !== CACHE);
      await Promise.all(stale.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const kind = classifyWith(RULES, request.url, request.mode);
  if (kind === 'document') event.respondWith(documentAnswer(request));
  else if (kind === 'asset') event.respondWith(cacheFirst(request));
  else if (kind === 'unhashed') event.respondWith(networkFirst(request));
});
`;
}

/** The precache list a built `sw.js` names, or `null` when there is none to read. */
export function precacheFromSource(source) {
  const raw = /const PRECACHE = (\[[\s\S]*?\]);/u.exec(String(source))?.[1];
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : null;
  } catch {
    return null;
  }
}

/** The cache name a built `sw.js` declares, or `null`. */
export function cacheNameFromSource(source) {
  return /const CACHE = "([^"]+)";/u.exec(String(source))?.[1] ?? null;
}
