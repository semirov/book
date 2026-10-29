/**
 * BOOK-188 — the database and filesystem facts the launch preflight reads, and nothing else.
 *
 * The doctor itself is a host CLI (`bin/admin.mjs doctor`), because part of its rows are host
 * facts (docker, mountinfo, host backups, the drill log) and none needs a checkout since BOOK-187.
 * It must never open `book.db` from the host while the stack runs (BOOK-183: two kernels on one
 * WAL file), so its DB facts come through `GET /api/admin/doctor` and are read by the process
 * that already holds the connection. This module is that reading half: pure functions over a
 * `Db` and the data dir.
 *
 * Every function is read-only, and every answer is a count, a path, a boolean or a digest:
 *
 *   * no row, no text, no token value, no address ever leaves this module — the frame is
 *     reported by its sha256 (`inspectFrame`), the tokens by their presence (`inspectDataDir`);
 *   * the dumps are opened `{readonly: true, fileMustExist: true}`, so a check creates no file
 *     and migrates nothing; a file that is not a database is a fact (`unreadable:<code>`), not
 *     a throw;
 *   * nothing here decides «ready» or «not ready» — that is the CLI's verdict, and a module that
 *     guessed it would be a second place for the rule to live.
 *
 * `book_frame` is the frame's home since v28 (BOOK-187): the rows ship with the schema and are
 * the text the site serves, so the module reads them. Stage 3's `fact_dependency` (BOOK-185) is
 * still not shipped on this branch and is detected by its presence, never required: an absent
 * table is a reported state, and the route answers instead of failing.
 */

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { OPENING_CHAPTER, TOTAL_CHAPTERS } from '@book/shared';
import Database from 'better-sqlite3';

import { absoluteOf, classifyDataEntry, DENIED_PATHS, readVolumeMarker } from '../dataHome.ts';
import type { Db } from '../db/db.ts';
import { SCHEMA_VERSION } from '../db/schema.ts';

/** The migration the running image expects, next to the one the file carries (ahead = FUTURE). */
export type SchemaInspection = { userVersion: number; expected: number };

/** One pre-migration dump, as the operator reads it: where, how old, how big, and does it open. */
export type DumpInspection = {
  file: string;
  mtimeMs: number;
  bytes: number;
  /** `ok`, the text `PRAGMA integrity_check` refused with, or `unreadable:<errno|SQLITE_…>`. */
  integrity: string;
  /** `null` when the file could not be read at all. */
  userVersion: number | null;
};

export type DumpsInspection = { preMigration: DumpInspection | null };

export type DataDirInspection = {
  path: string;
  /** Top-level names, sorted: names only, never a content listing of a subdirectory. */
  entries: string[];
  /**
   * The writer paths that exist, relative to the data dir (`writer/state.json`…), or `['writer']`
   * when the directory is there with none of them inside.
   */
  denied: string[];
  /**
   * Top-level entries outside the allow-list, as **absolute paths** — what the operator types
   * next. `writer` is reported through `denied` only.
   */
  stray: string[];
  tokens: { admin: boolean; engine: boolean };
  /**
   * The errno of a directory that could not be listed, or `null`. An unlistable data dir is a
   * fact the preflight must be able to fail on — a throw here would turn the whole doctor
   * answer into a 500 and hide the schema and frame rows that are still readable.
   */
  error: string | null;
};

export type FrameRow = { chapter: number; position: 'first' | 'last'; sha256: string };

export type FrameInspection = {
  /** `book_frame` when BOOK-187's table exists, else the basis slot of `blocks` (BOOK-6). */
  source: 'book_frame' | 'basis';
  /** The slots that hold a row; a missing slot is omitted and the CLI fails on the unpaired set. */
  rows: FrameRow[];
};

export type GraphInspection =
  | { shipped: false }
  | { shipped: true; facts: number; threads: number; edges: number; closureMs: number | null };

/**
 * **The allow-list is imported, never copied.** `server/src/dataHome.ts` owns the volume's shape —
 * the marker's two shapes included — and `bin/home-check.mjs`, the deploy gate, reads the same
 * module. Two lists were how the live volume's `.book-volume` came to be a stray in the doctor and
 * a marker in the guard (BOOK-187).
 */

/** `pre-v22-20261028T120000Z.db` — the dump a migration leaves before it changes the schema. */
const DUMP_FILE = /^pre-v.+\.db$/u;

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The errno or SQLite code of a failure — the only part of it a report may carry. */
function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'ERROR';
}

export function inspectSchema(db: Db): SchemaInspection {
  return { userVersion: Number(db.pragma('user_version', { simple: true })), expected: SCHEMA_VERSION };
}

/** Test seam: a factory lets a test count opens without touching the real file's bytes. */
export type DumpDeps = { DatabaseImpl?: typeof Database };

type DumpFact = { integrity: string; userVersion: number | null };

/**
 * The last few integrity answers, keyed by `file|mtimeMs|bytes`. `PRAGMA integrity_check` is
 * synchronous and walks the whole file: on a launch-sized dump it would block the site's event
 * loop for every poll of the preflight. An unchanged file (same path, mtime and size) cannot have
 * a different answer, so it is not re-read; a touched or replaced dump misses by construction.
 * Bounded and FIFO: eight entries is more than the handful of dumps a launch leaves behind, and a
 * cache that grew with the data dir would be a leak in the process that must stay small.
 */
const DUMP_CACHE_LIMIT = 8;
const dumpCache = new Map<string, DumpFact>();

function dumpFactOf(key: string, file: string, DatabaseImpl: typeof Database): DumpFact {
  const cached = dumpCache.get(key);
  if (cached !== undefined) return cached;
  const fact = readDump(file, DatabaseImpl);
  if (dumpCache.size >= DUMP_CACHE_LIMIT) {
    const oldest = dumpCache.keys().next().value;
    if (oldest !== undefined) dumpCache.delete(oldest);
  }
  dumpCache.set(key, fact);
  return fact;
}

/** The dump a migration would have left: newest by mtime, opened read-only, never written. */
export function inspectDumps(dataDir: string, deps: DumpDeps = {}): DumpsInspection {
  const dir = join(dataDir, 'backups');
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => DUMP_FILE.test(name));
  } catch {
    // No backups directory is a fact the CLI reports; it is not an error of the route.
    return { preMigration: null };
  }
  const found = names.flatMap((name) => {
    const file = join(dir, name);
    try {
      const stats = statSync(file);
      return stats.isFile() ? [{ file, mtimeMs: stats.mtimeMs, bytes: stats.size }] : [];
    } catch {
      return [];
    }
  });
  const newest = found.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (newest === undefined) return { preMigration: null };
  const key = `${newest.file}|${String(newest.mtimeMs)}|${String(newest.bytes)}`;
  return { preMigration: { ...newest, ...dumpFactOf(key, newest.file, deps.DatabaseImpl ?? Database) } };
}

/** `integrity_check` and `user_version` of one file, read-only; a broken file is a value here. */
function readDump(file: string, DatabaseImpl: typeof Database): { integrity: string; userVersion: number | null } {
  let db: Database.Database | null = null;
  try {
    db = new DatabaseImpl(file, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true }) as unknown;
    const userVersion = db.pragma('user_version', { simple: true }) as unknown;
    return { integrity: String(integrity), userVersion: Number(userVersion) };
  } catch (error) {
    return { integrity: `unreadable:${codeOf(error)}`, userVersion: null };
  } finally {
    try {
      db?.close();
    } catch {
      /* a connection that never opened has nothing to close */
    }
  }
}

/**
 * The data dir is the home of the book, and only the book: the allow-list `dataHome.ts` owns (the
 * deploy guard's own list, not a second copy), the two token files by presence, and the writer's
 * paths by name — `writer/` itself included, so a volume that holds only an empty one is refused
 * here as it is by `bin/home-check.mjs`. Nothing is read inside a subdirectory — a name is enough
 * to report a stray, and a transcript is not ours to enumerate. The volume marker is the one entry
 * judged by its content, and it is read **once**, read-only, so the answer is a snapshot.
 *
 * A directory that cannot be listed (a wrong mount, a file where the volume should be) is a
 * reported `error`, not a throw: the preflight has to be able to say *which* fact is unavailable,
 * and a 500 would also swallow the schema and frame rows that are still readable.
 */
export function inspectDataDir(dataDir: string): DataDirInspection {
  const tokens = {
    admin: exists(join(dataDir, 'admin.token')),
    engine: exists(join(dataDir, 'engine.token')),
  };
  let dirents: Array<{ name: string; directory: boolean }>;
  try {
    dirents = readdirSync(dataDir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    return { path: dataDir, entries: [], denied: [], stray: [], tokens, error: codeOf(error) };
  }
  const markerContent = readVolumeMarker(dataDir);
  const deniedTop = new Set(DENIED_PATHS.map((path) => path.split('/')[0] ?? path));
  const deniedPresent = DENIED_PATHS.filter((path) => exists(join(dataDir, path)));
  // `writer` is never a stray: it is reported through `denied`, the same fact the deploy guard
  // states — `writer/` itself is a leftover, so a volume holding only an empty `writer/` is not
  // clean just because none of the three paths is there (BOOK-187 review).
  const writerPresent = dirents.some((entry) => entry.name === 'writer');
  return {
    path: dataDir,
    entries: dirents.map((entry) => entry.name),
    denied: deniedPresent.length > 0 || !writerPresent ? deniedPresent : ['writer'],
    stray: dirents
      .filter((entry) => !deniedTop.has(entry.name))
      .filter(
        (entry) => !classifyDataEntry({ name: entry.name, directory: entry.directory, markerContent }).ok,
      )
      .map((entry) => absoluteOf(dataDir, entry.name)),
    tokens,
    error: null,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Columns of a table, from SQLite's own schema; an absent table has none. */
function columnsOf(db: Db, table: string): Set<string> {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])));
}

type FrameSlot = { chapter: number; position: 'first' | 'last'; order: 'ASC' | 'DESC' };

/** The two frozen slots, in the order the preflight reads them. */
const FRAME_SLOTS: readonly FrameSlot[] = [
  { chapter: OPENING_CHAPTER, position: 'first', order: 'ASC' },
  { chapter: TOTAL_CHAPTERS, position: 'last', order: 'DESC' },
];

/**
 * BOOK-188 check 4, DB half: the sha256 the served text must match. `book_frame` (BOOK-187) is
 * the home when it exists — its columns are not ours to assume, so the slot is read through
 * `pragma_table_info` and the text column is used only when both `chapter` and `text` are there.
 * Otherwise the basis slot of `blocks` answers: ch01's first paragraph and ch42's last.
 */
export function inspectFrame(db: Db): FrameInspection {
  const frameColumns = columnsOf(db, 'book_frame');
  if (frameColumns.has('chapter') && frameColumns.has('text')) {
    const rows = FRAME_SLOTS.flatMap((slot) => {
      const text = frameTextOf(db, frameColumns, slot);
      return typeof text === 'string' ? [{ chapter: slot.chapter, position: slot.position, sha256: sha256(text) }] : [];
    });
    return { source: 'book_frame', rows };
  }
  const basis = db.prepare('SELECT text FROM blocks WHERE chapter = ? ORDER BY idx ASC LIMIT 1');
  const ending = db.prepare('SELECT text FROM blocks WHERE chapter = ? ORDER BY idx DESC LIMIT 1');
  const rows = FRAME_SLOTS.flatMap((slot) => {
    const row = (slot.order === 'ASC' ? basis : ending).get(slot.chapter) as { text?: unknown } | undefined;
    return typeof row?.text === 'string'
      ? [{ chapter: slot.chapter, position: slot.position, sha256: sha256(row.text) }]
      : [];
  });
  return { source: 'basis', rows };
}

function frameTextOf(db: Db, columns: Set<string>, slot: FrameSlot): string | null {
  // `position` is optional: a table that holds one row per chapter does not need it.
  const row =
    columns.has('position') === true
      ? (db
          .prepare('SELECT text FROM book_frame WHERE chapter = ? AND position = ? LIMIT 1')
          .get(slot.chapter, slot.position) as { text?: unknown } | undefined)
      : (db.prepare('SELECT text FROM book_frame WHERE chapter = ? LIMIT 1').get(slot.chapter) as
          | { text?: unknown }
          | undefined);
  return typeof row?.text === 'string' ? row.text : null;
}

/** A count of a table that may not exist yet (the graph is stage 3, BOOK-185). */
function countRows(db: Db, table: string, columns: Set<string>): number {
  if (columns.size === 0) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * BOOK-185's closure, timed the way the preflight reports it: the ancestors recursive CTE over
 * `fact_dependency(from, to)`, run three times against the busiest target, best of three in ms.
 * A query that fails is `null` (the CLI then reports «slow/unknown», never a fake number).
 */
const CLOSURE_SQL = `WITH RECURSIVE anc(id) AS (
  SELECT "from" FROM fact_dependency WHERE "to" = ?
  UNION
  SELECT fd."from" FROM fact_dependency fd JOIN anc ON fd."to" = anc.id
) SELECT COUNT(*) AS n FROM anc`;

function closureMs(db: Db): number | null {
  try {
    const busiest = db
      .prepare('SELECT "to" AS id FROM fact_dependency GROUP BY "to" ORDER BY COUNT(*) DESC LIMIT 1')
      .get() as { id?: unknown } | undefined;
    if (busiest === undefined || busiest.id === undefined || busiest.id === null) return null;
    const statement = db.prepare(CLOSURE_SQL);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      statement.get(busiest.id);
      best = Math.min(best, performance.now() - started);
    }
    return Number.isFinite(best) ? Math.round(best * 100) / 100 : null;
  } catch {
    return null;
  }
}

/**
 * Check 6: `shipped` only when stage 3's edge table is in this image *and* shaped as
 * `(from, to)`; then counts and the closure. No model, no network — a count and one query.
 */
export function inspectGraph(db: Db): GraphInspection {
  const edges = columnsOf(db, 'fact_dependency');
  if (!edges.has('from') || !edges.has('to')) return { shipped: false };
  return {
    shipped: true,
    facts: countRows(db, 'facts', columnsOf(db, 'facts')),
    threads: countRows(db, 'threads', columnsOf(db, 'threads')),
    edges: countRows(db, 'fact_dependency', edges),
    closureMs: closureMs(db),
  };
}
