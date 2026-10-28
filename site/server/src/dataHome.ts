/**
 * BOOK-187 AC12 — the data home: what may live in the volume, and what may never live in the
 * repository. ADR-043 §5 step 8: `/data` owns `book.db` and its dumps, logs go to stdout, and
 * «nothing else may appear».
 *
 * The guard exists because the mistakes it catches are silent: a second copy of the prose back
 * under `manuscript/`, a writer's `state.json` or its transcripts reappearing beside the
 * database, an operator's scratch file landing in the volume where a backup will copy it
 * forever. Every failure names the **absolute path**, because the operator's next act is `ls`
 * on it.
 *
 * **Pure with injectable listings** (the shape `dataDirGuard.ts` has): `readHome` is the only
 * function that touches the filesystem, and it takes a `readdir`-like seam, so a test can drive
 * any tree — including one that is not on disk — and `deploy/bin/home-check.mjs` can import this
 * file from plain Node (type stripping): no `@book/shared`, no zod, no build step.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One path found under a root, relative to it, with `/` separators and no trailing slash. */
export type HomeEntry = { rel: string; directory: boolean };

/** What a check needs: the two roots and the listings the caller read. */
export type HomeListing = { root: string; entries: readonly HomeEntry[] };

export type HomeProblemCode = 'PROSE_IN_GIT' | 'WRITER_LEFTOVER' | 'NOT_ALLOWED' | 'NO_VOLUME';

export type HomeProblem = {
  code: HomeProblemCode;
  /** The absolute path of the offending entry — the one thing the operator acts on. */
  path: string;
  message: string;
};

/** `readdir` plus `stat` of one name; injectable so a test needs no filesystem at all. */
export type ListDir = (dir: string) => Array<{ name: string; directory: boolean }>;

export const realListDir: ListDir = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

/**
 * Every file and directory under `root`, depth first, sorted — the listing the checks judge.
 * A missing root is an empty listing, not an error: the caller decides whether that is allowed
 * (a missing volume is an incident, a missing `manuscript/` is the normal state of this tree).
 */
export function readHome(root: string, list: ListDir = realListDir): HomeEntry[] {
  if (!existsSync(root)) return [];
  const entries: HomeEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of list(dir)) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      entries.push({ rel, directory: entry.directory });
      if (entry.directory) walk(join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return entries;
}

/** The absolute path of a relative entry, as the operator would type it. */
export function absoluteOf(root: string, rel: string): string {
  return resolve(root, ...rel.split('/'));
}

/** Prose is a `.md`/`.txt`/`chNN.*` file — the names the book's text used to be committed under. */
const PROSE = [/(?:^|\/)[^/]+\.md$/iu, /(?:^|\/)[^/]+\.txt$/iu, /(?:^|\/)ch\d+[^/]*$/iu];

/** The writer's own files: BOOK-187 moved them into `writer_state`/`pass_transcripts` rows. */
const WRITER_LEFTOVERS = ['writer/state.json', 'writer/pre', 'writer/transcripts', 'writer'];

/**
 * The volume's allow-list — exactly the names `book.db`'s directory may hold, each with the
 * reason it is allowed. A file that is not named here (or is not inside one of these
 * directories) is a finding: the volume is the book, and a second thing in it is a second copy
 * waiting to be backed up, restored or mistaken for the book.
 */
export const DATA_ALLOW: ReadonlyArray<{ name: string; match: RegExp; reason: string }> = [
  { name: 'book.db', match: /^book\.db$/u, reason: 'the book itself' },
  { name: 'book.db-wal', match: /^book\.db-wal$/u, reason: 'SQLite write-ahead log: part of the open database' },
  { name: 'book.db-shm', match: /^book\.db-shm$/u, reason: 'SQLite shared-memory index: part of the open database' },
  { name: '*.token', match: /^[^/]+\.token$/u, reason: 'secrets, mode 600, read by the service' },
  { name: 'book-before-*.db', match: /^book-before-[^/]+\.db$/u, reason: 'pre-migration copies of the database' },
  { name: 'cover.*', match: /^cover\.[A-Za-z0-9]+$/u, reason: 'the cover image the owner swaps without a release' },
  { name: '.book-volume', match: /^\.book-volume$/u, reason: 'the volume marker (ADR-043 §3 row 12)' },
];

/** The volume's allow-listed **directories**; everything inside one of them is that directory's business. */
export const DATA_ALLOW_DIRS: ReadonlyArray<{ name: string; reason: string }> = [
  { name: 'backups', reason: 'dumps: the pre-migration copies boot verifies (ADR-043 G9)' },
  {
    name: 'backup',
    reason: 'legacy dumps (singular, from before BOOK-187); `bin/home-migrate.mjs` folds it into `backups/`',
  },
  { name: 'archive', reason: 'retired files an operator moved aside instead of deleting' },
  { name: 'versions', reason: 'the cold backup of revisions (content-addressed snapshots)' },
  { name: 'index', reason: 'derived slices: a cache of rows, rebuilt on demand' },
  { name: 'exchange', reason: 'the feedback inbox the triage drains' },
];

/** Is this relative path inside (or exactly) one of the allow-listed directories? */
function inAllowedDir(rel: string): boolean {
  const top = rel.split('/')[0] ?? '';
  return DATA_ALLOW_DIRS.some((entry) => entry.name === top);
}

/** Is this depth-one entry one of the allow-listed files? */
function allowedFile(rel: string): boolean {
  if (rel.includes('/')) return false;
  return DATA_ALLOW.some((entry) => entry.match.test(rel));
}

function proseProblem(root: string, entry: HomeEntry): HomeProblem | null {
  if (entry.directory) return null;
  const name = entry.rel.split('/').pop() ?? '';
  if (!PROSE.some((pattern) => pattern.test(name))) return null;
  const path = absoluteOf(root, entry.rel);
  return {
    code: 'PROSE_IN_GIT',
    path,
    message: `${path} is prose under manuscript/ — the book's text lives in the database (BOOK-187); nothing under manuscript/ may be committed`,
  };
}

function writerProblem(root: string, entry: HomeEntry): HomeProblem | null {
  const leftover = WRITER_LEFTOVERS.find((prefix) => entry.rel === prefix || entry.rel.startsWith(`${prefix}/`));
  if (leftover === undefined) return null;
  const path = absoluteOf(root, entry.rel);
  return {
    code: 'WRITER_LEFTOVER',
    path,
    message: `${path} is the writer's own file — the lane's state and its transcripts are rows (BOOK-187); ${leftover} may not exist — run bin/home-migrate.mjs --apply once`,
  };
}

function allowedProblem(root: string, entry: HomeEntry, files: ReadonlySet<string>): HomeProblem | null {
  if (entry.directory) {
    // A stray directory with nothing in it is still a second thing in the volume; one that holds
    // files is reported by those files, so the operator sees the path they actually created.
    if (inAllowedDir(entry.rel)) return null;
    const holdsFiles = [...files].some((rel) => rel.startsWith(`${entry.rel}/`));
    if (entry.rel.includes('/') || holdsFiles) return null;
  } else if (inAllowedDir(entry.rel) || allowedFile(entry.rel)) {
    return null;
  }
  const path = absoluteOf(root, entry.rel);
  return {
    code: 'NOT_ALLOWED',
    path,
    message: `${path} is not in the volume's allow-list — /data holds the book and its dumps and nothing else (${DATA_ALLOW.map((entry) => entry.name).concat(DATA_ALLOW_DIRS.map((entry) => `${entry.name}/`)).join(', ')}); a leftover of the old writer is removed by bin/home-migrate.mjs --apply once`,
  };
}

/**
 * The three rules, over listings the caller read. One problem per offending path, sorted by
 * path; an empty answer is a home that holds what it may.
 *
 *   a. `manuscript/` holds no prose (an absent or empty directory passes);
 *   b. the data dir holds no writer file (`writer/` itself, `writer/state.json`,
 *      `writer/pre/`, `writer/transcripts/`) — `bin/home-migrate.mjs` removes them once;
 *   c. every entry under the data dir is in the allow-list.
 */
export function dataHomeProblems(input: {
  dataDir: string;
  manuscriptDir: string;
  data: readonly HomeEntry[];
  manuscript: readonly HomeEntry[];
}): HomeProblem[] {
  const problems: HomeProblem[] = [];
  for (const entry of input.manuscript) {
    const problem = proseProblem(input.manuscriptDir, entry);
    if (problem !== null) problems.push(problem);
  }
  const files = new Set(input.data.filter((entry) => !entry.directory).map((entry) => entry.rel));
  for (const entry of input.data) {
    const writer = writerProblem(input.dataDir, entry);
    if (writer !== null) {
      problems.push(writer);
      continue;
    }
    const allowed = allowedProblem(input.dataDir, entry, files);
    if (allowed !== null) problems.push(allowed);
  }
  return problems.sort((left, right) => left.path.localeCompare(right.path));
}

export type DataHomeReport = {
  ok: boolean;
  dataDir: string;
  manuscriptDir: string;
  problems: HomeProblem[];
};

/**
 * The whole check for one pair of roots. A missing data dir is the caller's `exit 1` (a deploy
 * with no volume is an incident), so it is reported as a problem of its own; a missing
 * `manuscript/` is the normal state of this tree and passes.
 */
export function checkDataHome(options: {
  dataDir: string;
  manuscriptDir: string;
  list?: ListDir;
}): DataHomeReport {
  const dataDir = resolve(options.dataDir);
  const manuscriptDir = resolve(options.manuscriptDir);
  const list = options.list ?? realListDir;
  const problems = existsSync(dataDir)
    ? dataHomeProblems({
        dataDir,
        manuscriptDir,
        data: readHome(dataDir, list),
        manuscript: readHome(manuscriptDir, list),
      })
    : [
        {
          code: 'NO_VOLUME' as const,
          path: dataDir,
          message: `${dataDir} is not there — a deploy with no volume is an incident, not an empty book`,
        },
      ];
  return { ok: problems.length === 0, dataDir, manuscriptDir, problems };
}
