/**
 * Boot: schema read → pre-migration dump → migrate → stamps → prompt drift (BOOK-187, ADR-043 §5).
 *
 * The sequence is fail-closed at every step, because on a git-less host the volume is the only
 * copy of the book (G9) and an older image writing a newer schema is how a book is corrupted:
 *
 *   1. **Open** `book.db` (WAL, the one connection, ADR-001).
 *   2. **The schema read.** `user_version` higher than this build understands → `SCHEMA_FUTURE`,
 *      exit 1, nothing written. A rollback is therefore never "run the previous tag against the
 *      same volume": the previous tag refuses.
 *   3. **The pre-migration dump**, before any DDL: one online backup into `<dataDir>/backups/`
 *      (`pre-v<from>-<UTC>.db`), then a verification that the copy opens and reports the version
 *      it was taken at, with `integrity_check` = ok. A dump that cannot be verified throws
 *      `DUMP_FAILED` and the migration never runs — a book with no verified copy does not move.
 *      Three dumps are kept, pruned oldest first and *only after* a verified one.
 *   4. **The migration**, version-gated one transaction per step as before (`migrate`).
 *   5. **The stamps** into `meta`: `schema_version`, `image_digest`, `build_commit`,
 *      `prompt_bundle`, `migrated_at` (only when a step actually ran) and `booted_at`.
 *   6. **`PROMPT_DRIFT`** (G3): the image's bundle sha against the one the volume recorded. A
 *      difference is not rewritten — the volume keeps the rules that judged its text — and the
 *      image's sha is recorded separately so the admin health answer can print it.
 *
 * Both entrypoints (`index.ts`, `engine.ts`) call this instead of `openDatabase` + `migrate`, and
 * both print one line naming the refusal code and exit 1: the supervisor owns restarts, so there
 * is no retry loop here and no attempt to heal by deleting data.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { readBuildStamp, type BuildStamp } from '../buildStamp.ts';
import { databaseFile, openDatabase, type Db } from './db.ts';
import { migrate } from './migrate.ts';
import { deleteMeta, getMeta, setMeta } from './repo/meta.ts';
import { SCHEMA_VERSION } from './schema.ts';

/** `/data/backups` — inside the volume, next to the database it copies (ADR-043 G9). */
export const BACKUPS_DIR = 'backups';
/** How many pre-migration dumps stay in the volume; older ones go, newest kept. */
export const KEEP_DUMPS = 3;

/** A dump file this module wrote: `pre-v22-20261028T140210Z.db`. */
const DUMP_FILE = /^pre-v\d+-\d{8}T\d{6}Z\.db$/u;

export type BootRefusalCode = 'SCHEMA_FUTURE' | 'DUMP_FAILED';

/**
 * The boot refused to run. The message names the code, the numbers and the paths, because the
 * operator reads exactly one line in the supervisor's log; `code` is what a test (and a future
 * runbook) matches on.
 */
export class BootRefusal extends Error {
  readonly code: BootRefusalCode;

  constructor(code: BootRefusalCode, message: string) {
    super(message);
    this.name = 'BootRefusal';
    this.code = code;
  }
}

/** The one line either entrypoint prints before exiting 1; null for an error that is not a refusal. */
export function bootFailureLine(error: unknown): string | null {
  if (!(error instanceof BootRefusal)) return null;
  return `boot refused (${error.code}): ${error.message}`;
}

export type BootOptions = {
  /** The volume: `book.db` and `backups/` live here. */
  dataDir: string;
  /** Test seam: the stamp the image carries. Default reads `build-info.json` from the site root. */
  buildInfo?: BuildStamp;
  /** Test seam: the clock the dump's name and `seeded_at`/`booted_at` are taken from. */
  now?: () => Date;
  /** Test seam: one line per drift. Default `console.warn`. */
  log?: (line: string) => void;
};

/** `20261028T140210Z` — the UTC moment a dump was taken, in a name a shell can sort. */
export function dumpStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

/** `pre-v22-20261028T140210Z.db` — the file a rollback would open. */
export function dumpName(from: number, at: Date): string {
  return `pre-v${String(from)}-${dumpStamp(at)}.db`;
}

function readVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }) ?? 0);
}

/**
 * One online backup, verified before it counts: the copy must open, report the version it was
 * taken at and pass `integrity_check`. A failure removes the half-written file (it is not a copy
 * of anything) and throws, so no DDL can follow.
 */
async function dumpAndVerify(db: Db, dataDir: string, from: number, at: Date): Promise<void> {
  const dir = join(dataDir, BACKUPS_DIR);
  const path = join(dir, dumpName(from, at));
  try {
    // 0700 on the directory the dump lands in; `recursive` makes an existing one a no-op.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await db.backup(path);
    // The copy inherits WAL from the header, and a read-only open of a WAL file leaves `-wal`
    // and `-shm` beside it. A dump is one self-contained file a restore can copy anywhere, so it
    // is taken out of WAL here — the switch checkpoints whatever the backup left and is the last
    // write this file sees.
    const copy = new Database(path, { fileMustExist: true });
    try {
      copy.pragma('journal_mode = DELETE');
      const version = readVersion(copy);
      if (version !== from) {
        throw new Error(`the copy reports schema v${String(version)}, the source is v${String(from)}`);
      }
      const integrity = String(copy.pragma('integrity_check', { simple: true }) ?? '');
      if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);
    } finally {
      copy.close();
    }
  } catch (error) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Nothing to remove: the dump never got as far as a file.
    }
    throw new BootRefusal(
      'DUMP_FAILED',
      `pre-migration dump ${path} failed (${error instanceof Error ? error.message : String(error)}); ` +
        'no migration ran',
    );
  }
}

/** Keep the newest `KEEP_DUMPS` verified dumps; the rest go, oldest first. */
export function pruneDumps(dataDir: string, keep: number = KEEP_DUMPS): string[] {
  const dir = join(dataDir, BACKUPS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => DUMP_FILE.test(name));
  } catch {
    return [];
  }
  const dated = names
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    // Newest first; the name breaks a tie, and it sorts by time at one-second resolution.
    .sort((left, right) => right.at - left.at || right.name.localeCompare(left.name));
  const removed = dated
    .slice(keep)
    .map((entry) => entry.name)
    .sort();
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}

/**
 * The stamps the volume carries after a boot. `prompt_bundle` is written once and then only
 * honoured: it names the rules the text in this volume was judged by, and that is not something a
 * later image may rewrite. A different bundle is a rollback, and it is recorded, not applied.
 */
function writeStamps(
  db: Db,
  migration: { from: number; to: number },
  stamp: BuildStamp,
  at: Date,
  log: (line: string) => void,
): void {
  setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  setMeta(db, 'image_digest', stamp.imageDigest ?? '');
  setMeta(db, 'build_commit', stamp.commit);
  setMeta(db, 'booted_at', at.toISOString());
  // Only a boot that actually changed the schema says when the shape last moved.
  if (migration.to !== migration.from) setMeta(db, 'migrated_at', at.toISOString());

  const bundle = stamp.promptBundleSha;
  if (bundle === null) return;
  const recorded = getMeta(db, 'prompt_bundle');
  if (recorded === null || recorded.length === 0) {
    setMeta(db, 'prompt_bundle', bundle);
    deleteMeta(db, 'prompt_drift');
    return;
  }
  if (recorded === bundle) {
    deleteMeta(db, 'prompt_drift');
    return;
  }
  setMeta(db, 'prompt_drift', bundle);
  log(
    `PROMPT_DRIFT: the volume was written under prompt bundle ${recorded}, this image carries ${bundle} ` +
      '— the recorded bundle is kept; a pass under the new rules must be a new image and a new book',
  );
}

/**
 * The whole boot, in order, with nothing skipped. The returned connection is open and migrated;
 * a refusal throws, and the caller exits 1.
 */
export async function bootDatabase(options: BootOptions): Promise<Db> {
  const { dataDir } = options;
  const stamp = options.buildInfo ?? readBuildStamp();
  const now = options.now ?? ((): Date => new Date());
  const log = options.log ?? ((line: string): void => console.warn(line));
  const file = databaseFile(dataDir);
  const db = openDatabase(file);

  try {
    const from = readVersion(db);
    if (from > SCHEMA_VERSION) {
      throw new BootRefusal(
        'SCHEMA_FUTURE',
        `${file} is at schema v${String(from)}, this build understands v${String(SCHEMA_VERSION)}; ` +
          'an older image does not serve a newer book',
      );
    }
    const at = now();
    // The dump is the first thing that touches the volume, and it happens before any DDL.
    if (from < SCHEMA_VERSION) {
      await dumpAndVerify(db, dataDir, from, at);
      pruneDumps(dataDir);
    }
    const migration = migrate(db);
    writeStamps(db, migration, stamp, at, log);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
