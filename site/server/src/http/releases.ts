/**
 * BOOK-119 — what this server serves, and what it can still find.
 *
 * `web/dist` is no longer a build output but a small release store: `releases/<id>/` holds
 * every file Vite emitted, `current` is a relative symlink to one of them, and a publish is
 * immutable (see `scripts/release.mjs`). Two consequences live here:
 *
 * 1. **The root is `current` when it exists.** A Docker image, a fixture and `vite dev` have
 *    no symlink and keep the flat `dist` they always had, so the fallback is not a second
 *    behaviour — it is the same directory the static plugin was pointed at before.
 * 2. **A stale shell's `/assets/*` must still answer.** A browser holding the previous
 *    `index.html` asks for a hashed bundle the newer build no longer has under `current`; the
 *    plugin misses, and this module asks the retained releases newest→oldest. Only Vite's
 *    charset, one segment, `statSync` before `sendFile` — a miss is a **404 JSON**, never the
 *    SPA shell (a 200 `text/html` under `/assets/` is exactly the second half of the white
 *    screen: the module parses HTML, throws, the page stays blank).
 *
 * The re-entry flag is the trap in this path: `reply.sendFile` on a file that vanished between
 * the stat and the read calls `callNotFound` again, which is this same handler. A marked
 * request answers 404 instead of recursing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyReply, FastifyRequest } from 'fastify';

export type Release = { id: string; root: string; publishedAt: string };

/** Vite's output charset, one segment: a name, never a path, never an escape. */
const ASSET_NAME = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u;

/** Where `scripts/release.mjs` keeps the manifests — beside the releases, never inside one. */
const MANIFESTS = '.manifests';

/**
 * The last `listReleases` answer, keyed by the `releases/` directory's own `mtimeMs`.
 *
 * Every unknown `/assets/*` on an unauthenticated URL asks this lookup, and an uncached answer is
 * a `readdir` plus a `stat` and a `readFile` per retained release. A publish renames a new
 * directory into `releases/` (and a prune removes one), which moves that directory's mtime, so
 * the key changes exactly when the answer can change — no TTL, no staleness for a reader.
 */
let releasesCache: { dir: string; mtimeMs: number; releases: Release[] } | null = null;

/** Where the site's files are: the release `current` names, else the flat `dist`. */
export function servedRoot(webDist: string): string {
  const current = join(webDist, 'current');
  return existsSync(join(current, 'index.html')) ? current : webDist;
}

/** The hashed asset name a guarded `/assets/…` URL asks for, or `null` (a miss, by policy). */
export function assetName(url: string): string | null {
  const pathname = url.split('?')[0] ?? '';
  return ASSET_NAME.exec(pathname)?.[1] ?? null;
}

/** Retained releases, newest first by `publishedAt` (the directory's mtime without one). */
export function listReleases(webDist: string): Release[] {
  const releasesDir = join(webDist, 'releases');
  let dirStats;
  try {
    dirStats = statSync(releasesDir);
  } catch {
    return [];
  }
  if (releasesCache !== null && releasesCache.dir === releasesDir && releasesCache.mtimeMs === dirStats.mtimeMs) {
    return releasesCache.releases;
  }
  const found: Array<Release & { ms: number }> = [];
  for (const name of readdirSync(releasesDir)) {
    if (name.startsWith('.')) continue; // `.manifests` is the index, not a release
    const root = join(releasesDir, name);
    let stats;
    try {
      stats = statSync(root);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    let publishedAt = new Date(stats.mtimeMs).toISOString();
    let ms = stats.mtimeMs;
    try {
      const manifest = JSON.parse(readFileSync(join(releasesDir, MANIFESTS, `${name}.json`), 'utf8')) as {
        publishedAt?: unknown;
      };
      const parsed = typeof manifest.publishedAt === 'string' ? Date.parse(manifest.publishedAt) : Number.NaN;
      if (Number.isFinite(parsed)) {
        publishedAt = new Date(parsed).toISOString();
        ms = parsed;
      }
    } catch {
      /* a release adopted from the flat layout may carry no manifest yet */
    }
    found.push({ id: name, root, publishedAt, ms });
  }
  found.sort((a, b) => b.ms - a.ms || (a.id < b.id ? 1 : -1));
  const releases = found.map((entry) => ({ id: entry.id, root: entry.root, publishedAt: entry.publishedAt }));
  releasesCache = { dir: releasesDir, mtimeMs: dirStats.mtimeMs, releases };
  return releases;
}

/**
 * The first retained release that still holds this asset. `statSync` before `sendFile`: the
 * plugin must never be asked to send a path that does not exist, or the miss becomes a
 * recursion instead of an answer.
 */
export function retainedAsset(webDist: string, name: string): { root: string; file: string } | null {
  for (const release of listReleases(webDist)) {
    const file = join(release.root, 'assets', name);
    try {
      if (statSync(file).isFile()) return { root: release.root, file };
    } catch {
      /* not in this release — try the next one */
    }
  }
  return null;
}

/** Marks a request that already re-entered the not-found handler (see the module comment). */
const RETRIED = Symbol('book.notFoundRetried');

type RetryMark = { [RETRIED]?: true };

/**
 * True on the first pass only. The flag is the recursion trap from the module header: both the
 * retained-asset lookup and the shell fallback delegate to a second `sendFile`, and a file that
 * vanished (a publish that emptied the flat `dist`, a pruned release) makes the plugin call
 * `callNotFound` again — which is this same handler. The second pass answers instead of looping.
 */
export function firstNotFoundPass(request: FastifyRequest): boolean {
  const mark = request as unknown as RetryMark;
  if (mark[RETRIED] === true) return false;
  mark[RETRIED] = true;
  return true;
}

/**
 * Answer an `/assets/…` miss: a retained release's copy when one holds it, else 404 JSON.
 * The shell is never an answer here — a module script that receives HTML cannot run.
 */
export function answerAssetMiss(request: FastifyRequest, reply: FastifyReply, webDist: string): FastifyReply {
  const name = assetName(request.url);
  if (name !== null && firstNotFoundPass(request)) {
    const hit = retainedAsset(webDist, name);
    // The path is relative to the *release root* the plugin is pointed at — not to the
    // package root — so the answer is `assets/<name>` under that release's directory.
    if (hit !== null) return reply.sendFile(join('assets', name), hit.root);
  }
  return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such asset' });
}
