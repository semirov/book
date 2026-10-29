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
 * **This module is the one place the volume's shape is described.** Two guards ask the question —
 * `bin/home-check.mjs` at deploy time and `server/src/doctor/inspect.ts` in the preflight — and
 * two lists of truth for one volume is how the live volume's marker was called a stray by the
 * doctor and accepted by the guard (BOOK-187 fix). So the allow-list, the denied paths, the
 * marker and its shapes live here, imported, never copied.
 *
 * **Pure with injectable listings** (the shape `dataDirGuard.ts` has): `readHome` is the only
 * walker that touches the filesystem, and it takes a `readdir`-like seam, so a test can drive
 * any tree — including one that is not on disk — and `site/bin/home-check.mjs` can import this
 * file from plain Node (type stripping): no `@book/shared`, no zod, no build step.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * `/data/.book-volume` — the marker that proves the directory is a book volume and not a
 * mistyped path (ADR-043 §3 row 12). `server/src/db/boot.ts` writes it; **this** module is where
 * its shape is judged, because the marker belongs to the volume and not to one caller's opinion.
 */
export const VOLUME_MARKER = '.book-volume';

/**
 * The marker's format version — the number on the `book-volume <n>` line (the shape's own
 * version, not the schema's). A different format is not this marker.
 */
export const MARKER_FORMAT = 1;

/**
 * The marker's current shape: its name and format on one line, the schema the volume was last
 * booted at on the next.
 *
 *   book-volume 1
 *   schema=28
 */
const MARKER_NAMED = new RegExp(`^book-volume ${String(MARKER_FORMAT)}\\nschema=\\d+\\n?$`, 'u');
/**
 * The shape the first image wrote (BOOK-187): the schema version alone — the same fact, before it
 * carried its name. The number is not checked against a known version on purpose: a volume booted
 * by a later image carries a later number, and that is the same fact, not a different volume.
 * Still a marker; the next boot rewrites it in the named shape.
 */
const MARKER_LEGACY = /^\d+\n?$/u;

/** `\r\n` normalised to `\n`; the content is compared, not parsed, so nothing else is touched. */
function markerText(content: string): string {
  return content.replace(/\r\n/gu, '\n');
}

/** The exact bytes `server/src/db/boot.ts` writes — the shape, in one place. */
export function volumeMarkerContent(version: number): string {
  return `book-volume ${String(MARKER_FORMAT)}\nschema=${String(version)}\n`;
}

/** Is this the legacy single-number marker — the one a boot upgrades in place, once? */
export function isLegacyVolumeMarker(content: string): boolean {
  return MARKER_LEGACY.test(markerText(content));
}

/**
 * Why this content is not a marker, or `null` when it is: the named shape, or the legacy number
 * the first image wrote. Everything else — empty, prose, a different volume's name, a random
 * string — is not a marker, and the caller names the file (a directory of that name is judged by
 * the directory rules, not here).
 */
export function volumeMarkerProblem(content: string): string | null {
  const text = markerText(content);
  if (MARKER_NAMED.test(text) || MARKER_LEGACY.test(text)) return null;
  return `is not a volume marker — ${VOLUME_MARKER} carries «book-volume ${String(MARKER_FORMAT)}» and a «schema=<n>» line (or the legacy schema number the first image wrote); an operator's file is never touched`;
}

/** The largest content a marker can legitimately have; anything bigger is not read. */
const MARKER_MAX_BYTES = 4 * 1024;

/**
 * `<dataDir>/.book-volume`, or `null` when it is not a small regular file. A FIFO, a device, a
 * directory, a file too large to be a marker and a missing file all answer `null` — the deploy
 * gate runs on a host it cannot trust to be sane, and a read that can block or a megabyte of
 * prose must not hold it; the caller then refuses the entry, because an unread marker proves
 * nothing.
 */
export function readVolumeMarker(dataDir: string): string | null {
  const path = join(dataDir, VOLUME_MARKER);
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MARKER_MAX_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The three paths the launch forbids in the data dir: prose never lives next to the rows. */
export const DENIED_PATHS: readonly string[] = ['writer/state.json', 'writer/pre', 'writer/transcripts'];

/** Prose is a `.md`/`.txt`/`chNN.*` file — the names the book's text used to be committed under. */
const PROSE = [/(?:^|\/)[^/]+\.md$/iu, /(?:^|\/)[^/]+\.txt$/iu, /(?:^|\/)ch\d+[^/]*$/iu];

/** The writer's own files: BOOK-187 moved them into `writer_state`/`pass_transcripts` rows. */
const WRITER_LEFTOVERS = ['writer/state.json', 'writer/pre', 'writer/transcripts', 'writer'];

/**
 * The volume's file allow-list — exactly the names `book.db`'s directory may hold, each with the
 * reason it is allowed. A file that is not named here (or is not inside one of the directories
 * below) is a finding: the volume is the book, and a second thing in it is a second copy waiting
 * to be backed up, restored or mistaken for the book.
 *
 * The reset's own copies are named because `server/src/reset/backup.ts` writes them here; the
 * dumps a migration leaves (`pre-v*.db`) are **not** here on purpose — they live only inside
 * `backups/`, and the directory rule covers them.
 */
export const DATA_ALLOW: ReadonlyArray<{ name: string; match: RegExp; reason: string }> = [
  { name: 'book.db', match: /^book\.db$/u, reason: 'the book itself' },
  { name: 'book.db-wal', match: /^book\.db-wal$/u, reason: 'SQLite write-ahead log: part of the open database' },
  { name: 'book.db-shm', match: /^book\.db-shm$/u, reason: 'SQLite shared-memory index: part of the open database' },
  { name: '*.token', match: /^[^/]+\.token$/u, reason: 'secrets, mode 600, read by the service' },
  { name: 'book-before-*.db', match: /^book-before-[^/]+\.db$/u, reason: 'pre-migration copies of the database' },
  { name: 'book-reset-*.db', match: /^book-reset-[^/]+\.db$/u, reason: "the reset's last copy of the book, written beside it" },
  { name: 'cover.*', match: /^cover\.[A-Za-z0-9]+$/u, reason: 'the cover image the owner swaps without a release' },
];

/**
 * Files allowed by their **content**, not by their name — the marker is the one entry a regex
 * cannot judge, so it carries no `match` that nobody would consult. Kept beside `DATA_ALLOW` so a
 * refusal still prints every allowed name, and judged only by `classifyDataEntry`.
 */
export const DATA_ALLOW_CONTENT: ReadonlyArray<{ name: string; reason: string }> = [
  { name: VOLUME_MARKER, reason: 'the volume marker, judged by content (ADR-043 §3 row 12)' },
];

/**
 * The volume's allow-listed **directories**; everything inside one of them is that directory's
 * business. `logs/` and `locks/` are not here: the service logs to stdout (the supervisor keeps
 * the files) and its locks live in `/locks` (`BOOK_LOCKS_DIR`), so a `logs/` or a `locks/` in the
 * volume is a second thing nobody wrote, and refusing it is the honest answer.
 */
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

/** The one sentence a refusal prints, between the absolute path and the end of the line. */
const NOT_ALLOWED_REASON =
  `is not in the volume's allow-list — /data holds the book and its dumps and nothing else (` +
  `${DATA_ALLOW.map((entry) => entry.name)
    .concat(DATA_ALLOW_CONTENT.map((entry) => entry.name))
    .concat(DATA_ALLOW_DIRS.map((entry) => `${entry.name}/`))
    .join(', ')}); ` +
  // Not every refused name is a writer leftover — `logs/`, `notes.txt` and the like are not the
  // migrate tool's business, so the sentence names the route that works for them too.
  'remove it by hand, or — when it is a leftover of the old writer — run bin/home-migrate.mjs --apply once';

/** One depth-one entry judged: allowed, or the reason it is refused — the text printed after its path. */
export type DataEntryVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The one classifier of a depth-one data-dir entry — the only place a name is allowed or refused,
 * so the deploy guard and the doctor cannot disagree about the same volume.
 *
 *   * a directory is allowed only by name (`DATA_ALLOW_DIRS`), whatever it holds;
 *   * `.book-volume` is a file whose **content** decides (`volumeMarkerProblem`): the named shape
 *     and the legacy number are markers, everything else is not;
 *   * every other file is allowed only by the file rules.
 *
 * `markerContent` is the content read once by the caller (`readVolumeMarker`); `null` means the
 * marker could not be read, and an unreadable marker is refused.
 */
export function classifyDataEntry(input: {
  name: string;
  directory: boolean;
  markerContent: string | null;
}): DataEntryVerdict {
  if (input.directory) {
    return DATA_ALLOW_DIRS.some((entry) => entry.name === input.name)
      ? { ok: true }
      : { ok: false, reason: NOT_ALLOWED_REASON };
  }
  if (input.name === VOLUME_MARKER) {
    const problem = volumeMarkerProblem(input.markerContent ?? '');
    return problem === null ? { ok: true } : { ok: false, reason: problem };
  }
  return DATA_ALLOW.some((entry) => entry.match.test(input.name))
    ? { ok: true }
    : { ok: false, reason: NOT_ALLOWED_REASON };
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

function notAllowedProblem(root: string, rel: string, reason: string): HomeProblem {
  const path = absoluteOf(root, rel);
  return { code: 'NOT_ALLOWED', path, message: `${path} ${reason}` };
}

/**
 * The three rules, over listings the caller read. One problem per offending path, sorted by
 * path; an empty answer is a home that holds what it may.
 *
 *   a. `manuscript/` holds no prose (an absent or empty directory passes);
 *   b. the data dir holds no writer file (`writer/` itself, `writer/state.json`,
 *      `writer/pre/`, `writer/transcripts/`) — `bin/home-migrate.mjs` removes them once;
 *   c. every depth-one entry under the data dir is allowed by `classifyDataEntry` — the same
 *      classifier the doctor calls, so the two guards cannot disagree about one volume.
 *
 * Rule c judges depth-one entries. A path inside an allowed directory is that directory's
 * business; a path inside a refused one is reported **as the directory**, because a nested name
 * is not a separate thing in the volume and the doctor (which lists one level, read-only) cannot
 * see it. One refused entry is therefore one line, whichever listing found it.
 */
export function dataHomeProblems(input: {
  dataDir: string;
  manuscriptDir: string;
  data: readonly HomeEntry[];
  manuscript: readonly HomeEntry[];
  /** Test seam: the marker's content. Default reads `<dataDir>/.book-volume`, `null` when absent. */
  readMarker?: () => string | null;
}): HomeProblem[] {
  const problems: HomeProblem[] = [];
  for (const entry of input.manuscript) {
    const problem = proseProblem(input.manuscriptDir, entry);
    if (problem !== null) problems.push(problem);
  }
  const readMarker = input.readMarker ?? ((): string | null => readVolumeMarker(input.dataDir));
  const markerContent = readMarker();
  const refused = new Set<string>();
  for (const entry of input.data) {
    const writer = writerProblem(input.dataDir, entry);
    if (writer !== null) {
      problems.push(writer);
      continue;
    }
    // A depth-one entry is judged as itself; anything deeper is judged by the entry it lives in
    // (a path with a slash implies a directory at the top, whether or not the listing has it).
    const name = entry.rel.includes('/') ? (entry.rel.split('/')[0] ?? entry.rel) : entry.rel;
    const directory = entry.rel.includes('/') ? true : entry.directory;
    const verdict = classifyDataEntry({ name, directory, markerContent });
    if (verdict.ok || refused.has(name)) continue;
    refused.add(name);
    problems.push(notAllowedProblem(input.dataDir, name, verdict.reason));
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
  /** Test seam: the marker's content. Default reads `<dataDir>/.book-volume`, `null` when absent. */
  readMarker?: () => string | null;
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
        readMarker: options.readMarker,
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
