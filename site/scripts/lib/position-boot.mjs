/**
 * scripts/lib/position-boot.mjs — a real site, from a book the run owns (BOOK-209).
 *
 * The measurement is only worth the numbers it prints if the thing measured is the thing a
 * reader gets: one origin, the real server (`node server/dist/index.js`), serving the real
 * release, over a fresh database built by the product's own one-shot import. So this module
 * does exactly what a deploy does, in the same order, and tears all of it down again —
 * including on a crash, because a harness that leaves a server holding :8099 makes the next
 * run fail for the wrong reason.
 *
 *   1. a scratch `DATA_DIR` under `$TMPDIR` (never the checkout, never a production path);
 *   2. `scripts/position-seed.ts` through `tsx` — boot + `reconcile()` against a book tree;
 *   3. `npm run build`, then `release publish` (the deploy's own step: `web/dist/current`);
 *   4. `node server/dist/index.js` with `DATA_DIR` and `PORT`, waited on through `/healthz`.
 *
 * **The book is the run's own unless one is named.** Since ADR-043 the text's home is the
 * database, so a checkout may hold no `manuscript/` at all, and a guard nobody can run is not a
 * guard: by default `seed()` writes a fixture manuscript into its own scratch directory
 * (`lib/position-fixture.mjs` — deterministic bytes, deleted with the run) and imports it through
 * the product's one-shot import. A real book is measured only when it is asked for by name:
 * `POSITION_SEED_VOLUME` (a seeded volume, copied — volume wins, it is the true book) or
 * `POSITION_BOOK_ROOT` (a book tree to import). Nothing outside the repository is discovered
 * on its own, and the record says which of the three the run measured.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromiumBinary, killTree, spawnLogged, waitForUrl } from './cdp.mjs';
import { writeFixture } from './position-fixture.mjs';

/**
 * `site/` — the npm workspace every command below runs in.
 *
 * `POSITION_SITE_ROOT` measures another tree. A before-run needs the commit as it was, and a
 * checkout another session is editing is not that: the export is built and served here, the
 * harness stays where it is.
 */
export const SITE_ROOT = resolve(process.env.POSITION_SITE_ROOT ?? join(import.meta.dirname, '..', '..'));
/** The port the brief pins: one origin, no Vite proxy, exactly as prod is served. */
export const POSITION_PORT = 8099;
/**
 * The read budget the measured server boots with (`READ_PER_MINUTE`).
 *
 * The limiter is per network and covers `/api/state`, `/api/me` and the rest of the read
 * prefixes; this harness loads a page per measured row, so the shipped 60 a minute would be
 * spent by the sweep itself and the signed-in phase would be refused with a `429` — the
 * harness starving its own assertions. The limiter is not what this measures, so it is raised
 * for the run, and the record says so.
 */
export const READ_PER_MINUTE = 100_000;
export const POSITION_ORIGIN = `http://127.0.0.1:${String(POSITION_PORT)}`;

/**
 * The book tree an explicitly named run imports (`POSITION_BOOK_ROOT`), or null. **Nothing is
 * discovered on its own**: since ADR-043 the text lives in the database, and a checkout that
 * happens to carry a `manuscript/` (or the owner's home directory) must not silently change the
 * book the default run measures. A named root that does not fit is a failure, loudly.
 */
export function bookRoot(env = process.env) {
  const named = env.POSITION_BOOK_ROOT;
  if (named === undefined || named.length === 0) return null;
  const root = resolve(named);
  if (!existsSync(join(root, 'manuscript', '00-front.md'))) {
    throw Object.assign(new Error(`${root} holds no manuscript/00-front.md`), { harness: true });
  }
  return root;
}

/**
 * The seeded volume an explicitly named run copies (`POSITION_SEED_VOLUME`), or null. A volume
 * is the real book — the one thing a run measuring prose nobody wrote cannot stand in for — so
 * it is never picked up by chance.
 */
export function seedVolume(env = process.env) {
  const named = env.POSITION_SEED_VOLUME;
  if (named === undefined || named.length === 0) return null;
  const dir = resolve(named);
  if (!existsSync(join(dir, 'book.db'))) {
    throw Object.assign(new Error(`${dir} holds no book.db`), { harness: true });
  }
  return dir;
}

/** A scratch directory the harness owns; removed by `scratch()`'s caller in `finally`. */
export function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** One child that must finish; its bounded output is kept for the failure line, never printed. */
function run(command, args, { cwd, env, timeoutMs, label }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnLogged(command, args, { cwd, env: { ...process.env, ...env } });
    const timer = setTimeout(() => {
      killTree(child);
      reject(Object.assign(new Error(`${label} did not finish in ${String(timeoutMs)} ms`), { harness: true }));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(child.output ?? '');
      else {
        const tail = String(child.output ?? '').split('\n').slice(-12).join('\n');
        reject(Object.assign(new Error(`${label} exited ${String(code)}\n${tail}`), { harness: true }));
      }
    });
  });
}

/**
 * Fill the scratch volume from the book this run measures and mint the one session the second
 * device needs. One order, and the record names which door the book came through
 * (`how`): a volume named by `POSITION_SEED_VOLUME` (the true book, and it wins over a tree),
 * else a tree named by `POSITION_BOOK_ROOT`, else a fixture manuscript written into a scratch
 * directory the run owns and deletes (`fixture` carries the counts the record prints).
 *
 * The cookie is a credential, even on a scratch volume: it is returned to the caller and never
 * logged, never written to the record.
 */
export async function seed({ dataDir, log, env = process.env }) {
  const volume = seedVolume(env);
  let root = volume === null ? bookRoot(env) : null;
  let how = volume === null ? 'book' : 'volume';
  let source = volume ?? root;
  let fixture = null;
  let tempDir = null;
  if (root === null && volume === null) {
    tempDir = scratch('position-fixture-');
    fixture = await writeFixture(tempDir);
    root = tempDir;
    how = 'fixture';
    source = tempDir;
    log(`fixture: ${tempDir} — ${String(fixture.files)} files, ${String(fixture.blocks)} blocks`);
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const args = ['tsx', join(SITE_ROOT, 'scripts', 'position-seed.ts'), '--data', dataDir, '--session'];
  if (root === null) args.push('--volume', volume);
  else args.push('--book', root);
  log(`seed: ${dataDir} from ${source ?? '?'} (${how})`);
  const output = await run('npx', args, { cwd: SITE_ROOT, timeoutMs: 180_000, label: 'position-seed' });
  const line = output.split('\n').find((text) => text.startsWith('position-seed:')) ?? 'position-seed: (no summary)';
  const sessionLine = output.split('\n').find((text) => text.startsWith('position-session:')) ?? '';
  let session = null;
  try {
    const raw = sessionLine.slice('position-session:'.length).trim();
    if (raw.length > 0) session = JSON.parse(raw);
  } catch {
    session = null;
  }
  log(line);
  log(session === null ? 'session: none' : `session: ${session.identityId} (cookie kept out of every log)`);
  return { line, how, source, session, fixture, tempDir };
}

/** Build the three packages, then publish the release the server serves (`web/dist/current`). */
export async function build({ log }) {
  log('build: npm run build');
  await run('npm', ['run', 'build'], { cwd: SITE_ROOT, timeoutMs: 600_000, label: 'npm run build' });
  log('build: release publish');
  await run('node', [join(SITE_ROOT, 'scripts', 'release.mjs'), 'publish'], {
    cwd: SITE_ROOT,
    timeoutMs: 120_000,
    label: 'release publish',
  });
}

/** Is a built release already on disk (a debug rerun with `--no-build`)? */
export function releaseReady() {
  return existsSync(join(SITE_ROOT, 'web', 'dist', 'current', 'index.html'));
}

/**
 * Is something holding the port? A TCP connect, not an HTTP probe: a squatter that accepts and
 * never answers would pass an HTTP check and then cost the run its whole boot timeout.
 */
function portBusy(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(600);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('error', () => resolvePromise(false));
  });
}

/** The real server, on the pinned port, over the scratch volume. */
export async function serve({ dataDir, log }) {
  if (await portBusy(POSITION_PORT)) {
    throw Object.assign(new Error(`port ${String(POSITION_PORT)} is already in use`), { harness: true });
  }
  const child = spawnLogged('node', [join(SITE_ROOT, 'server', 'dist', 'index.js')], {
    cwd: SITE_ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(POSITION_PORT),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      NODE_ENV: 'development',
      READ_PER_MINUTE: process.env.READ_PER_MINUTE ?? String(READ_PER_MINUTE),
    },
  });
  try {
    await waitForUrl(`${POSITION_ORIGIN}/healthz`, 60_000, 'the site');
  } catch (error) {
    killTree(child);
    const tail = String(child.output ?? '').split('\n').slice(-8).join('\n');
    throw Object.assign(new Error(`${error.message}\n${tail}`), { harness: true });
  }
  log(`serve: ${POSITION_ORIGIN}`);
  return child;
}

/**
 * The browser: `$POSITION_CHROME` first (a pinned build), then the Playwright cache, then a
 * system Chrome. A missing browser is a harness failure (exit 2), named as such.
 */
export function browserBinary(env = process.env) {
  const explicit = env.POSITION_CHROME;
  if (explicit !== undefined && explicit.length > 0 && existsSync(explicit)) return explicit;
  try {
    return chromiumBinary();
  } catch {
    /* not in the Playwright cache: try the machine's own browser */
  }
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw Object.assign(new Error('no browser: set POSITION_CHROME, or install Chromium'), { harness: true });
}

/** A synchronous pause, for the one place that has no event loop left: the run's teardown. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove what the harness owns; a failure to clean up is not a reason to keep the run's result.
 * A killed Chromium writes its profile for a moment after the signal, so a removal that meets a
 * directory still being written is retried — three attempts, ~360 ms at worst, and then the OS
 * reaps what is left in `$TMPDIR`. A volume, a fixture manuscript and a browser profile all go
 * through here: the run owns them and nothing of it may outlive it.
 */
export function dispose(paths) {
  for (const path of paths) {
    if (path === undefined || path === null) continue;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        rmSync(path, { recursive: true, force: true });
        break;
      } catch {
        pause(120);
      }
    }
  }
}

/** Kill a child and anything it spawned (npm runs a tree, not one process). */
export function stop(child) {
  killTree(child);
}
