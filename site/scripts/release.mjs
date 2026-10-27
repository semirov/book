#!/usr/bin/env node
/**
 * scripts/release.mjs — BOOK-119: every build becomes an immutable release, `current` names one.
 *
 * The white screen the owner hit after a deploy was a stale shell asking for a bundle the
 * build had already replaced: the file was gone, the SPA fallback answered HTML, the module
 * never ran. The fix is structural: a build lands in `web/dist/staging`, this script renames
 * it to `web/dist/releases/<sha7>-<YYYYMMDDTHHMMSSZ>/`, and `web/dist/current` is a **relative
 * symlink** to one of them. The timestamp makes a publish immutable even when it is a rebuild
 * of the same commit (a rollback writes a new directory instead of over a live one), so a
 * browser holding the previous shell can still fetch its `/assets/*` from the release that
 * produced it (`server/src/http/releases.ts` looks across the retained ones).
 *
 * The swap is `symlink(tmp)` + `renameSync(tmp, current)`: rename replaces the link itself and
 * never follows it, so there is no moment where `current` is missing or half-built. Publishing
 * happens *after* a green build and *before* the restart, so a failed build never touches
 * `current`, and the seconds between swap and restart are the old process serving the new
 * shell's API (compatible by construction).
 *
 * Retention is a disk fact, not an HTTP surface: roots are `current`, `releases/**` is not
 * addressable. `--keep 3` (oldest by `publishedAt` beyond three) bounds it; the release
 * `current` names and the one `.state/last-good-release` records are never pruned, so a
 * rollback target and the shell in the wild survive a busy week.
 *
 * A release's manifest does **not** live inside the release: `releases/.manifests/<id>.json`
 * keeps `GET /release.json` from answering a full sha, a file count and a byte count on a URL
 * a served root would make addressable. `list` and `prune` read them from there; the served tree
 * stays exactly what Vite emitted.
 *
 * First run on the flat layout (`dist/index.html`, `dist/assets`, …) **adopts** it into
 * `releases/legacy-<mtime>` before swapping: the unguarded shell already in a reader's browser
 * keeps its assets through this deploy too.
 *
 * No secrets, no network. The sha comes from the tree when it has one, else from
 * `build-info.json` — the Docker image is built without `.git` and carries only the manifest.
 *
 *   node scripts/release.mjs publish [--keep 3] [--web-dist DIR] [--state DIR] [--sha SHA]
 *   node scripts/release.mjs swap --id ID [--web-dist DIR]
 *   node scripts/release.mjs list    [--web-dist DIR]
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_WEB_DIST = join(SITE, 'web', 'dist');
export const DEFAULT_STATE_DIR = resolve(homedir(), '.local', 'state', 'book-deploy');
export const DEFAULT_KEEP = 3;

/** Layout entries this script owns; everything else in a flat `dist` is adopted. */
const OWNED = new Set(['releases', 'staging', 'current']);

/**
 * Where manifests live: a sibling of the release directories, **never inside one** (a served
 * root is `releases/<id>`, so a manifest in there answers `GET /release.json` with a full sha,
 * a file count and a byte count). The name starts with a dot so it is obviously not a release.
 */
export const MANIFESTS = '.manifests';

/** `web/dist/releases/.manifests/<id>.json` — the one place a manifest is written. */
export function manifestPath(webDist, id) {
  return join(webDist, 'releases', MANIFESTS, `${id}.json`);
}

/** `2026-10-27T18:31:45.123Z` → `20261027T183145Z`. */
export function compactStamp(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** `build-info.json` — `{commit, builtAt, stamp}` — or `{}` when there is no build behind us. */
export function readBuildInfo(siteRoot = SITE) {
  try {
    return JSON.parse(readFileSync(join(siteRoot, 'build-info.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The commit this release is. The tree outranks the manifest (it names what was actually
 * built); the manifest is the Docker image's only identity — its context has no `.git`.
 */
export function buildIdentity({ siteRoot = SITE, sha } = {}) {
  if (typeof sha === 'string' && sha.length > 0) return { sha, short: sha.slice(0, 7) };
  try {
    const full = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: siteRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (full.length > 0) return { sha: full, short: full.slice(0, 7) };
  } catch {
    /* no repository here: the Docker image, a tarball */
  }
  const info = readBuildInfo(siteRoot);
  const commit = typeof info.commit === 'string' && info.commit.length > 0 ? info.commit : 'dev';
  return { sha: commit, short: commit.slice(0, 7) };
}

/** Every file under `dir`, sorted — a directory walk a release and a staging tree can share. */
export function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, base, out);
    else out.push(relative(base, path));
  }
  return out.sort();
}

/**
 * The tree as one digest. Counts are what the manifest records; the digest is what "same bytes"
 * means in the proof. A tree can hold no manifest: those live outside the release.
 */
export function treeDigest(dir) {
  const hash = createHash('sha256');
  let bytes = 0;
  let files = 0;
  for (const rel of walkFiles(dir)) {
    const content = readFileSync(join(dir, rel));
    bytes += content.length;
    files += 1;
    hash.update(rel);
    hash.update('\0');
    hash.update(createHash('sha256').update(content).digest('hex'));
    hash.update('\n');
  }
  return { files, bytes, digest: hash.digest('hex') };
}

/** The release `current` names, or `null` when there is none (first publish, Docker-less dev). */
export function currentReleaseId(webDist = DEFAULT_WEB_DIST) {
  const link = join(webDist, 'current');
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const target = readlinkSync(link);
  if (target === null) return null;
  const name = target.replace(/\/+$/u, '').split('/').pop();
  return name === undefined || name.length === 0 ? null : name;
}

/** A release's manifest, read from `releases/.manifests/<id>.json`, or `null` (a legacy adoption). */
export function releaseManifest(webDist, id) {
  try {
    return JSON.parse(readFileSync(manifestPath(webDist, id), 'utf8'));
  } catch {
    return null;
  }
}

/** Write `releases/.manifests/<id>.json` — the only copy of the manifest, outside the served tree. */
export function writeManifest(webDist, id, manifest) {
  mkdirSync(join(webDist, 'releases', MANIFESTS), { recursive: true });
  writeFileSync(manifestPath(webDist, id), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Directories under `releases/`, newest first by `publishedAt` (the directory's mtime for an
 * adopted legacy tree). `Array.prototype.sort` is stable, and equal timestamps fall back to
 * the id's fixed-width timestamp: deterministic on every filesystem. Dot entries (`.manifests`)
 * are the index, not releases.
 */
export function listReleases(webDist = DEFAULT_WEB_DIST) {
  const releasesDir = join(webDist, 'releases');
  if (!existsSync(releasesDir)) return [];
  const found = [];
  for (const name of readdirSync(releasesDir)) {
    if (name.startsWith('.')) continue;
    const root = join(releasesDir, name);
    let stats;
    try {
      stats = statSync(root);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    const manifest = releaseManifest(webDist, name);
    const publishedAt =
      typeof manifest?.publishedAt === 'string' ? manifest.publishedAt : new Date(stats.mtimeMs).toISOString();
    const ms = Date.parse(publishedAt);
    found.push({ id: name, root, publishedAt, ms: Number.isFinite(ms) ? ms : stats.mtimeMs });
  }
  found.sort((a, b) => b.ms - a.ms || (a.id < b.id ? 1 : -1));
  return found.map((entry) => ({ id: entry.id, root: entry.root, publishedAt: entry.publishedAt }));
}

/** The id `.state/last-good-release` records, or `null`. One line, no JSON, no secret. */
export function readLastGoodRelease(stateDir = DEFAULT_STATE_DIR) {
  try {
    const value = readFileSync(join(stateDir, 'last-good-release'), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeLastGoodRelease(id, stateDir = DEFAULT_STATE_DIR) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'last-good-release'), `${id}\n`, 'utf8');
}

/**
 * Move a flat `dist` into `releases/legacy-<mtime>`. This is the one-way transition: the shell
 * already open in a reader's browser has no guard and a URL list that assumes `dist/assets`
 * exists, so its files must stay reachable through `current` plus the retained lookup.
 */
export function adoptLegacy(webDist = DEFAULT_WEB_DIST, date = new Date()) {
  const index = join(webDist, 'index.html');
  if (!existsSync(index)) return null;
  if (lstatSync(index).isSymbolicLink()) return null; // already a release through `current`
  const id = `legacy-${compactStamp(date)}`;
  const target = join(webDist, 'releases', id);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(webDist)) {
    if (OWNED.has(name) || name.startsWith('.')) continue;
    renameSync(join(webDist, name), join(target, name));
  }
  writeManifest(webDist, id, { id, sha: 'legacy', builtAt: null, stamp: null, publishedAt: date.toISOString() });
  return id;
}

/** `symlink` to a temp name, then `rename` over `current`: atomic, and rename never follows. */
export function swapCurrent(webDist, id) {
  const link = join(webDist, 'current');
  const tmp = join(webDist, `.current-${process.pid}-${Date.now()}`);
  symlinkSync(join('releases', id), tmp, 'dir');
  try {
    renameSync(tmp, link);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Point `current` at a release that is already on disk, refusing one that is not.
 *
 * The deploy's red path uses this: after a publish, `current` names the release that then failed
 * to come up, while the process still serves the previous commit. Disk and process must agree
 * before `last-good` is written, or the next restart serves the red shell (BOOK-119 review).
 */
export function swap({ webDist = DEFAULT_WEB_DIST, id }) {
  if (typeof id !== 'string' || id.length === 0) throw new UsageError('swap needs --id');
  const root = join(webDist, 'releases', id);
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(`no release ${id} under ${join(webDist, 'releases')} — current is untouched`);
  }
  swapCurrent(webDist, id);
  return { id };
}

/**
 * Keep `keep` newest releases; never `current`, never `last-good-release`. A protected release
 * beyond the window stays (the count is a bound, not a promise to delete a live tree).
 */
export function prune({
  webDist = DEFAULT_WEB_DIST,
  keep = DEFAULT_KEEP,
  stateDir = DEFAULT_STATE_DIR,
  log = () => {},
} = {}) {
  const protectedIds = new Set();
  const currentId = currentReleaseId(webDist);
  if (currentId !== null) protectedIds.add(currentId);
  const lastGood = readLastGoodRelease(stateDir);
  if (lastGood !== null) protectedIds.add(lastGood);

  const releases = listReleases(webDist);
  const kept = new Set(releases.slice(0, Math.max(0, keep)).map((release) => release.id));
  const removed = [];
  for (const release of [...releases].reverse()) {
    if (kept.has(release.id)) continue;
    if (protectedIds.has(release.id)) {
      log(`prune: kept ${release.id} (protected — current or last good)`);
      continue;
    }
    rmSync(release.root, { recursive: true, force: true });
    rmSync(manifestPath(webDist, release.id), { force: true });
    removed.push(release.id);
    log(`prune: removed ${release.id} (publishedAt ${release.publishedAt})`);
  }
  return removed;
}

/**
 * Publish `dist/staging` under a new id, swap `current`, prune. A missing staging tree is a
 * failed build: nothing is touched. With no staging and a `current` already in place the call
 * is a no-op — re-running a publish that already succeeded must not invent a release.
 */
export function publish({
  webDist = DEFAULT_WEB_DIST,
  siteRoot = SITE,
  stateDir = DEFAULT_STATE_DIR,
  keep = DEFAULT_KEEP,
  sha,
  now = new Date(),
  log = () => {},
} = {}) {
  mkdirSync(join(webDist, 'releases'), { recursive: true });
  const adopted = adoptLegacy(webDist, now);
  if (adopted !== null) log(`publish: adopted the flat dist as ${adopted}`);

  const staging = join(webDist, 'staging');
  if (!existsSync(join(staging, 'index.html'))) {
    const current = currentReleaseId(webDist);
    if (current !== null) {
      log(`publish: no staging tree — current ${current} stays`);
      return { id: current, created: false, pruned: [] };
    }
    throw new Error(`no build at ${staging}: run \`npm run build\` before publishing`);
  }

  const identity = buildIdentity({ siteRoot, sha });
  const info = readBuildInfo(siteRoot);
  const tree = treeDigest(staging);

  let date = now;
  let id = `${identity.short}-${compactStamp(date)}`;
  // A second publish in the same second must not write over a live release: move the clock.
  for (let attempt = 0; attempt < 60 && existsSync(join(webDist, 'releases', id)); attempt += 1) {
    date = new Date(date.getTime() + 1000);
    id = `${identity.short}-${compactStamp(date)}`;
  }

  const manifest = {
    id,
    sha: identity.sha,
    builtAt: typeof info.builtAt === 'string' ? info.builtAt : date.toISOString(),
    stamp: typeof info.stamp === 'string' ? info.stamp : '00.00 00:00',
    publishedAt: date.toISOString(),
    files: tree.files,
    bytes: tree.bytes,
  };

  const target = join(webDist, 'releases', id);
  renameSync(staging, target);
  // The manifest is written beside the releases, never inside one: `releases/<id>` is a served
  // root, and a `release.json` in there answers `GET /release.json` with the full sha and counts.
  writeManifest(webDist, id, manifest);
  swapCurrent(webDist, id);
  const pruned = prune({ webDist, keep, stateDir, log });
  log(`publish: ${id} (${tree.files} files, ${tree.bytes} bytes) — current -> releases/${id}`);
  return { id, created: true, pruned, files: tree.files, bytes: tree.bytes };
}

// --- CLI ---------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/release.mjs <publish|swap|list> [options]

  publish  rename web/dist/staging into web/dist/releases/<id>, swap current, prune
             --web-dist DIR   (default ${DEFAULT_WEB_DIST})
             --state DIR      (default ${DEFAULT_STATE_DIR}) — reads last-good-release
             --keep N         (default ${DEFAULT_KEEP})
             --sha SHA        (default: the tree, else build-info.json)
  swap     point current at a release already on disk, refusing one that is not there
             --id ID          (required)
             --web-dist DIR   (default ${DEFAULT_WEB_DIST})
  list     print the retained releases, newest first
             --web-dist DIR`;

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith('--')) throw new UsageError(`unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
    index += 1;
  }
  return flags;
}

class UsageError extends Error {}

export function main(argv) {
  const [command, ...rest] = argv;
  const log = (line) => console.log(line);
  if (command === 'publish') {
    const flags = parseFlags(rest);
    const keep = flags.keep === undefined ? DEFAULT_KEEP : Number(flags.keep);
    if (!Number.isInteger(keep) || keep < 1) throw new UsageError(`--keep must be a positive integer, got ${flags.keep}`);
    const webDist = flags['web-dist'] === undefined ? DEFAULT_WEB_DIST : resolve(flags['web-dist']);
    const stateDir = flags.state === undefined ? DEFAULT_STATE_DIR : resolve(flags.state);
    publish({ webDist, stateDir, keep, ...(flags.sha === undefined ? {} : { sha: flags.sha }), log });
    return 0;
  }
  if (command === 'swap') {
    const flags = parseFlags(rest);
    if (flags.id === undefined) throw new UsageError('swap needs --id');
    const webDist = flags['web-dist'] === undefined ? DEFAULT_WEB_DIST : resolve(flags['web-dist']);
    swap({ webDist, id: flags.id });
    log(`swap: current -> releases/${flags.id}`);
    return 0;
  }
  if (command === 'list') {
    const flags = parseFlags(rest);
    const webDist = flags['web-dist'] === undefined ? DEFAULT_WEB_DIST : resolve(flags['web-dist']);
    const current = currentReleaseId(webDist);
    for (const release of listReleases(webDist)) {
      console.log(`${release.id === current ? '*' : ' '} ${release.id} ${release.publishedAt}`);
    }
    return 0;
  }
  throw new UsageError(command === undefined ? 'no command' : `unknown command: ${command}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) console.error(USAGE);
    process.exitCode = 2;
  }
}
