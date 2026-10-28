/**
 * BOOK-188 — the database and filesystem facts the launch preflight reads, and nothing else.
 *
 * The doctor itself is a host CLI (`bin/admin.mjs doctor`), because five of its eight checks are
 * host facts (docker, mountinfo, the working tree, host backups, git). It must never open
 * `book.db` from the host while the stack runs (BOOK-183: two kernels on one WAL file), so its
 * DB facts come through `GET /api/admin/doctor` and are read by the process that already holds
 * the connection. This module is that reading half: pure functions over a `Db` and the data dir.
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
 * The two features this module knows are *not* shipped on this branch (`book_frame` from
 * BOOK-187, `fact_dependency` from BOOK-185) are detected by their presence, never required:
 * an absent table is a reported state, and the route answers instead of failing.
 */

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { OPENING_CHAPTER, TOTAL_CHAPTERS } from '@book/shared';
import Database from 'better-sqlite3';

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
  /** The three forbidden paths that exist, relative to the data dir (`writer/state.json`…). */
  denied: string[];
  /** Top-level entries outside the allow-list; `writer` is reported through `denied` only. */
  stray: string[];
  tokens: { admin: boolean; engine: boolean };
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
 * The one allow-list of the data dir (BOOK-187 AC12). It lives here as a constant, not as caller
 * input: a check that asked the caller what counts as «home» would agree with any stray file.
 */
const ALLOWED_FILES: readonly string[] = ['book.db', 'book.db-wal', 'book.db-shm'];
const ALLOWED_FILE_PATTERNS: readonly RegExp[] = [
  /^[^/]+\.token$/u,
  /^book-before-.+\.db$/u,
  /^book-reset-.+\.db$/u,
  /^cover\./u,
];
const ALLOWED_DIRS: readonly string[] = [
  'backups',
  'archive',
  'versions',
  'index',
  'exchange',
  'logs',
  'locks',
];

/** The three paths the launch forbids in the data dir: prose never lives next to the rows. */
export const DENIED_PATHS: readonly string[] = ['writer/state.json', 'writer/pre', 'writer/transcripts'];

/** `pre-v22-20261028T120000Z.db` — the dump a migration leaves before it changes the schema. */
const DUMP_FILE = /^pre-v.+\.db$/u;

/** For the container's own filesystem check: a directory is not a file and vice versa. */
function allowedEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) return ALLOWED_DIRS.includes(name);
  if (ALLOWED_FILES.includes(name)) return true;
  return ALLOWED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

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
  return { preMigration: { ...newest, ...readDump(newest.file, deps.DatabaseImpl ?? Database) } };
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
 * The data dir is the home of the book, and only the book: the allow-list above, the two token
 * files by presence, and the three forbidden writer paths by name. Nothing is read inside a
 * subdirectory — a name is enough to report a stray, and a transcript is not ours to enumerate.
 */
export function inspectDataDir(dataDir: string): DataDirInspection {
  const dirents = readdirSync(dataDir, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const deniedTop = new Set(DENIED_PATHS.map((path) => path.split('/')[0] ?? path));
  return {
    path: dataDir,
    entries: dirents.map((entry) => entry.name),
    denied: DENIED_PATHS.filter((path) => exists(join(dataDir, path))),
    // `writer` is never a stray: it is reported through `denied`, and a `writer/` with none of
    // the three paths is a leftover of an older writer, not a second home for the book.
    stray: dirents
      .filter((entry) => !deniedTop.has(entry.name))
      .filter((entry) => !allowedEntry(entry.name, entry.directory))
      .map((entry) => entry.name),
    tokens: {
      admin: exists(join(dataDir, 'admin.token')),
      engine: exists(join(dataDir, 'engine.token')),
    },
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
