/**
 * The data-dir isolation guard (BOOK-107). The production data dir is the book: the canon, the
 * readers' comments, the ledger. The mistake that costs is silent — a test or a local server
 * pointed at `$HOME/book-site-data` writes prod rows and nothing complains — so the guard is a
 * wall in **both** directions, not a comment:
 *
 *   * a boot that is not production may not touch a production data dir;
 *   * a production boot may not keep its data inside the checkout.
 *
 * `NODE_ENV=production` is the only thing that makes a prod dir legitimate: it is the flag every
 * other invariant already keys on (invariant 30).
 *
 * No `@book/shared`, no zod: `scripts/frame-check.mjs` imports this file from plain Node (type
 * stripping), so the guard that script asserts is the guard the server runs.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Where the launchd job and `deploy/backup.sh` keep the live database by default. */
export const DEFAULT_PRODUCTION_DATA_DIR = resolve(homedir(), 'book-site-data');

/**
 * The checkout root, for a caller that does not pass one: `site/server/src/` and
 * `site/server/dist/` both sit three levels under it.
 */
export const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** The same test `loadConfig` makes, for the operator CLIs that open `book.db` themselves. */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

/**
 * Every directory that is production data: the default under `home`, plus whatever
 * `PRODUCTION_DATA_DIR` names — a `:`-separated list, so one environment can name the live
 * volume and a restored copy next to it.
 */
export function productionDataDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const declared = (env.PRODUCTION_DATA_DIR ?? '')
    .split(':')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => resolve(part));
  return [...new Set([resolve(home, 'book-site-data'), ...declared])];
}

export type DataDirPaths = {
  dataDir: string;
  adminTokenFile: string;
  engineTokenFile: string;
  feedbackDir: string;
};

/** The variable behind each guarded path, for the message: the operator has to know where to look. */
const GUARDED: ReadonlyArray<readonly [keyof DataDirPaths, string]> = [
  ['dataDir', 'DATA_DIR'],
  ['adminTokenFile', 'ADMIN_TOKEN_FILE'],
  ['engineTokenFile', 'ENGINE_TOKEN_FILE'],
  ['feedbackDir', 'FEEDBACK_DIR'],
];

/**
 * The path as the filesystem sees it, so a symlink to the prod dir and a `..` detour land on
 * the same string. A path that does not exist yet is resolved through its deepest existing
 * parent: the prod dir itself always exists, and a scratch dir under it may not.
 */
function realPath(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch {
      const parent = dirname(current);
      // Nothing above the root exists either: the absolute path is the best answer there is.
      if (parent === current) return absolute;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function covers(dir: string, candidate: string): boolean {
  return candidate === dir || candidate.startsWith(`${dir}${sep}`);
}

export type GuardOptions = {
  /** Directories that are production data; defaults to `productionDataDirs()`. */
  prodDirs?: string[];
  /** The checkout root; a production `DATA_DIR` inside it is refused. */
  repoRoot?: string;
};

/**
 * The production direction on its own: a data dir inside the checkout is refused. It is
 * exported because a second caller needs the same rule without a boot — the operator's launch
 * reset (`reset/book.ts`, BOOK-137) refuses to wipe a book whose database sits in the tree it
 * was built from. Both callers print this one message, so an operator learns one sentence.
 */
export function assertDataDirOutsideRepo(dataDir: string, repoRoot: string = DEFAULT_REPO_ROOT): void {
  const candidate = realPath(dataDir);
  if (!covers(realPath(repoRoot), candidate)) return;
  throw new Error(
    `invalid configuration: refusing to boot production with DATA_DIR inside the repository (${candidate}); ` +
      'production data lives outside the checkout',
  );
}

/**
 * One wall, two directions, and one message per direction — a refusal an operator can act on
 * without reading this file. Paths only: no value that could be a secret reaches this function.
 *
 *   * not production → the guarded paths may not be, or lie inside, a production data dir;
 *   * production → only `DATA_DIR` is judged, and it may not be inside the checkout (the
 *     default `ADMIN_TOKEN_FILE`/`FEEDBACK_DIR` live under `site/` and a real boot keeps them).
 */
export function assertDataDirIsolation(
  paths: DataDirPaths,
  production: boolean,
  options: GuardOptions = {},
): void {
  if (production) {
    // An empty `DATA_DIR` resolves to the working directory, which for a deployed boot is the
    // checkout: it is judged like any other path, not skipped.
    assertDataDirOutsideRepo(paths.dataDir, options.repoRoot ?? DEFAULT_REPO_ROOT);
    return;
  }

  const roots = (options.prodDirs ?? productionDataDirs()).map((dir) => realPath(dir));
  for (const [key, name] of GUARDED) {
    const value = paths[key];
    // An empty path is not a path: a disabled token file is `''` and is not a prod write.
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const candidate = realPath(value);
    for (const root of roots) {
      if (!covers(root, candidate)) continue;
      throw new Error(
        `invalid configuration: refusing to run non-production against the production data dir (${candidate}); ` +
          `point ${name} at a scratch directory`,
      );
    }
  }
}
