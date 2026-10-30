#!/usr/bin/env node
/**
 * bin/backup.mjs — a backup of the book data volume, taken where the database lives (BOOK-183).
 *
 * The data dir is a Docker named volume mounted into the `site` container, and the host never
 * opens `book.db`: two kernels over one bind mount is what produced `SQLITE_IOERR_SHORT_READ`.
 * So the copy is made **inside** the container, from a source volume into a backup volume:
 *
 *   node bin/backup.mjs [--data DIR] [--out DIR] [--keep-daily N] [--keep-weekly N] [--json]
 *   node bin/backup.mjs --verify DIR [--json]
 *
 * Defaults: `--data` = `$DATA_DIR` or `/data`; `--out` = `$BACKUP_ROOT` or `/backups`; 7 daily
 * and 4 weekly copies. Every path comes from a flag or an environment variable, so the same file
 * runs on the host against a temp dir — that is how it is tested.
 *
 * Why not `deploy/backup.sh`: it needs macOS `sqlite3`/`stat -f`/`shasum` and runs on the host
 * over a bind mount. The image has no `sqlite3` binary but does ship `better-sqlite3` (a server
 * dependency, `/app/node_modules`), which exposes the same SQLite online backup API. This file
 * uses Node builtins and that one module, and adds nothing to `package.json`.
 *
 * A normal run:
 *   * takes `<out>/.lock`; a lock older than 6 h is stale and replaced, a live one is exit 75 —
 *     the run never waits, because a hung backup must not hold the next one;
 *   * refuses to start unless `<out>` has 3 × (database + `versions/`) free — a staging copy plus
 *     one more generation;
 *   * copies `book.db` with the online backup API (a consistent snapshot, the `-wal` included),
 *     converts the copy to `journal_mode=DELETE`, runs `PRAGMA integrity_check`, and deletes any
 *     `book.db-wal`/`-shm` the copy left behind, so the file is self-contained;
 *   * copies `versions/` (when present) and proves it twice the way the old script did: equal file
 *     counts, and equal sha256 per file on both sides;
 *   * writes `manifest.txt` — one line of row counts, then a sorted `<sha256>  <path>` list of
 *     `book.db` and every copied file;
 *   * publishes `daily/<YYYYmmddTHHMMSS>`, and on the first run of an ISO week also copies it to
 *     `weekly/<YYYY>-W<ww>`;
 *   * prunes to the newest `--keep-daily` / `--keep-weekly` directories, never the run's own.
 *     A pruning failure is exit 1 with the copy already published: retention is not skipped
 *     silently, because the next full disk would be the operator's first news of it.
 *
 * Output is one line on stdout, greppable and value-free (counts, paths, sizes only):
 *   book-backup ts=<ISO> status=ok dir=<path> chapters=N blocks=N changes=N comments=N versions=N duration_ms=N
 * `--json` prints one JSON object (the shape `--verify` prints) instead. `--verify DIR` opens
 * `DIR/book.db` readonly, checks the integrity and the counts, writes nothing, and prints that
 * JSON; it is what a restore drill or the host wrapper checks a copy with.
 *
 * Staging (BOOK-183, measured): the copy is assembled in the container's tempdir — `/tmp` is a tmpfs in
 * compose — and only the verified artifact is copied into `<out>` (`/backups`, the one host bind for
 * state) and renamed there. `rename` across tmpfs and the bind is `EXDEV`, so the publish is a copy then
 * a rename INSIDE `<out>`. When the tempdir cannot hold the copy (the site's tmpfs is 32 MiB), the stage
 * falls back to `<out>/.inprogress.<pid>` — the same directory as before this change — and the run is
 * identical, just slower; nothing in the published layout depends on which one was used.
 *
 * Exit: 0 ok · 1 failure (one named `reason=` line on stderr) · 2 usage · 75 another run holds
 * the lock. Failures leave no staging directory and always release the lock (also on SIGINT and
 * SIGTERM — the 6 h stale rule is the floor, not the plan). The volume half — lock, free space,
 * `versions/`, manifest, retention — is `bin/lib/backupFs.mjs`; this file is the database.
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  BackupError,
  EXIT,
  TABLES,
  copyVersions,
  dirSize,
  freeBytes,
  isoWeek,
  manifestText,
  prune,
  reason,
  sha256,
  stamp,
  takeLock,
  walkFiles,
} from './lib/backupFs.mjs';
import { entryState } from './lib/entry.mjs';

/**
 * Where the staging copy is built: the tempdir (a tmpfs in the container) when it can hold the whole
 * copy, else `<out>` itself. `need` is the source size — the stage holds one copy of it, and the final
 * directories are what the 3x check in `backup()` is about.
 */
function pickScratch(out, need) {
  for (const dir of [tmpdir(), out]) {
    try {
      if (freeBytes(dir) >= need) return { dir, tmpfs: dir !== out };
    } catch {
      // A tempdir we cannot stat is not a candidate; `<out>` is checked last and always exists.
    }
  }
  return { dir: out, tmpfs: false };
}

/** One stderr line: an SQLite message may carry newlines, and the contract is one line. */
const oneLine = (text) => String(text).replace(/\s+/gu, ' ').trim();

/**
 * The one module outside Node's builtins. It is a server dependency, so the image ships it at
 * `/app/node_modules`; a pruned or broken tree must still say *why* it cannot run, in the same one
 * line as every other refusal, instead of dying in a stack trace before the CLI exists.
 */
let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch (error) {
  console.error(oneLine(`book-backup status=fail reason=MODULE_MISSING message=${JSON.stringify(reason(error))}`));
  process.exit(EXIT.fail);
}

// Every directory and file this process creates belongs to a backup, so it is owner-only — the host
// script's `umask 077`. `daily/<ts>/` lands 0700 and `book.db` 0600 (`manifest.txt` is written 0600
// explicitly); without this the container's default umask made them world-readable inside /backups.
process.umask(0o77);

const DEFAULTS = { data: '/data', out: '/backups', keepDaily: 7, keepWeekly: 4 };

const USAGE = `usage:
  node bin/backup.mjs [--data DIR] [--out DIR] [--keep-daily N] [--keep-weekly N] [--json]
  node bin/backup.mjs --verify DIR [--json]

flags:
  --data DIR        source holding book.db and versions/; default $DATA_DIR or ${DEFAULTS.data}
  --out DIR         backup root; default $BACKUP_ROOT or ${DEFAULTS.out}
  --keep-daily N    daily copies kept, newest first; default ${DEFAULTS.keepDaily}, at least 1
  --keep-weekly N   weekly copies kept, newest first; default ${DEFAULTS.keepWeekly}, at least 1
  --json            one JSON object instead of the log line
  --verify DIR      read DIR/book.db readonly, check integrity and counts, write nothing
  --help            this text

exit: 0 ok · 1 failure (one reason= line on stderr) · 2 usage · 75 <out>/.lock is held`;

/**
 * The flags, and nothing else. A typo is a usage error (2) rather than a run against defaults —
 * a backup that silently lands in the wrong place is worse than one that refuses.
 */
export function parseArgs(argv, env = process.env) {
  const opts = {
    data: (env.DATA_DIR ?? '').trim() || DEFAULTS.data,
    out: (env.BACKUP_ROOT ?? '').trim() || DEFAULTS.out,
    keepDaily: DEFAULTS.keepDaily,
    keepWeekly: DEFAULTS.keepWeekly,
    json: false,
    verify: null,
    help: false,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (!arg.startsWith('-')) throw new BackupError('USAGE', `unexpected argument: ${arg}`, EXIT.usage);
    const equals = arg.indexOf('=');
    let name = arg;
    let value;
    if (equals > 0) {
      name = arg.slice(0, equals);
      value = arg.slice(equals + 1);
    } else {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new BackupError('USAGE', `flag ${arg} needs a value`, EXIT.usage);
      }
      value = next;
      index += 1;
    }
    if (value.trim().length === 0) throw new BackupError('USAGE', `flag ${name} needs a value`, EXIT.usage);
    if (name === '--data') opts.data = value;
    else if (name === '--out') opts.out = value;
    else if (name === '--verify') opts.verify = value;
    else if (name === '--keep-daily') opts.keepDaily = keepCount(name, value);
    else if (name === '--keep-weekly') opts.keepWeekly = keepCount(name, value);
    else throw new BackupError('USAGE', `unknown flag: ${name}`, EXIT.usage);
  }
  return opts;
}

/** `--keep-*` is a count of copies; 0 would delete the copy this run just made. */
function keepCount(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new BackupError('USAGE', `${name} must be an integer of at least 1`, EXIT.usage);
  }
  return n;
}

/**
 * The copy, from the live volume. `readonly` on purpose: the backup never writes to the data dir,
 * and the online backup API gives a consistent snapshot that includes what is still in `-wal`.
 * The copy is then made self-contained — `journal_mode=DELETE`, integrity checked, no `-wal`/`-shm`
 * left to be forgotten during a restore.
 */
async function prepareCopy(source, dest) {
  let db;
  try {
    db = new Database(source, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new BackupError('DB_UNREADABLE', `${source}: ${reason(error)}`);
  }
  try {
    await db.backup(dest);
  } catch (error) {
    throw new BackupError('BACKUP_FAILED', `${source} -> ${dest}: ${reason(error)}`);
  } finally {
    db.close();
  }
  const counts = convertAndCount(dest);
  for (const suffix of ['-wal', '-shm']) rmSync(`${dest}${suffix}`, { force: true });
  return counts;
}

/** `PRAGMA integrity_check` as a throw: the first lines of the refusal are what the operator reads. */
function assertIntegrity(db, file) {
  let rows;
  try {
    rows = db.pragma('integrity_check');
  } catch (error) {
    throw new BackupError('INTEGRITY_FAILED', `${file}: ${reason(error)}`);
  }
  const value = rows?.[0]?.integrity_check ?? 'no result';
  if (value !== 'ok') {
    throw new BackupError('INTEGRITY_FAILED', `${file}: ${String(value).split('\n').slice(0, 3).join(' ')}`);
  }
}

/** A missing table is a broken schema, not a zero: the manifest's counts must mean something. */
function countRows(db, file) {
  const counts = {};
  for (const table of TABLES) {
    try {
      counts[table] = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;
    } catch (error) {
      throw new BackupError('TABLE_MISSING', `${file}: ${table}: ${reason(error)}`);
    }
  }
  return counts;
}

/** The staged copy: DELETE journal mode, integrity, then the counts — all on the copy. */
function convertAndCount(file) {
  let db;
  try {
    db = new Database(file, { fileMustExist: true });
  } catch (error) {
    throw new BackupError('DB_UNREADABLE', `${file}: ${reason(error)}`);
  }
  try {
    let mode;
    try {
      mode = db.pragma('journal_mode = DELETE', { simple: true });
    } catch (error) {
      throw new BackupError('JOURNAL_MODE_FAILED', `${file}: ${reason(error)}`);
    }
    if (String(mode).toLowerCase() !== 'delete') {
      throw new BackupError('JOURNAL_MODE_FAILED', `${file}: journal_mode is ${String(mode)}`);
    }
    assertIntegrity(db, file);
    return countRows(db, file);
  } finally {
    db.close();
  }
}

/** `--verify`: the copy a drill or a restore would open, read without writing anything. */
function inspectReadonly(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new BackupError('DB_UNREADABLE', `${file}: ${reason(error)}`);
  }
  try {
    assertIntegrity(db, file);
    return countRows(db, file);
  } finally {
    db.close();
  }
}

const payload = (fields) => ({ job: 'book-backup', ...fields });

/**
 * The run. The lock is taken before anything is written and released in `finally`; the staging
 * directory lives under `<out>` (same filesystem as the destination, so publishing is a rename)
 * and is removed on every failing path.
 */
async function backup(opts, started) {
  const startedAt = new Date(started);
  const data = resolve(opts.data);
  const out = resolve(opts.out);
  const dbPath = join(data, 'book.db');
  if (!existsSync(dbPath)) throw new BackupError('DB_MISSING', `no database at ${dbPath}`);
  try {
    mkdirSync(out, { recursive: true });
  } catch (error) {
    throw new BackupError('OUT_UNAVAILABLE', `${out}: ${reason(error)}`);
  }

  const lock = join(out, '.lock');
  takeLock(lock);
  // `stage` is filled in once the source size is known (a tmpfs that cannot hold the copy falls back to
  // `<out>`); the signal handler closes over the variable, not a value.
  let stage = join(out, `.inprogress.${String(process.pid)}`);
  const onSignal = (signal) => {
    rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
    console.error(oneLine(`book-backup status=fail reason=SIGNAL message=stopped by ${String(signal)}`));
    process.exit(EXIT.fail);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const free = freeBytes(out);
    const sourceBytes = statSync(dbPath).size + dirSize(join(data, 'versions'));
    const need = sourceBytes * 3;
    if (free < need) {
      throw new BackupError(
        'ENOSPC',
        `${out}: ${String(free)} bytes free, need ${String(need)} (3 x ${String(sourceBytes)})`,
      );
    }

    const name = stamp(startedAt);
    const dest = join(out, 'daily', name);
    if (existsSync(dest)) throw new BackupError('PUBLISH_FAILED', `already taken: ${dest}`);
    mkdirSync(join(out, 'daily'), { recursive: true });
    mkdirSync(join(out, 'weekly'), { recursive: true });

    const scratch = pickScratch(out, sourceBytes);
    stage = join(scratch.dir, `.inprogress.${String(process.pid)}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });

    const counts = await prepareCopy(dbPath, join(stage, 'book.db'));
    const versions = copyVersions(join(data, 'versions'), join(stage, 'versions'));
    writeFileSync(join(stage, 'manifest.txt'), manifestText(counts, versions, sha256(join(stage, 'book.db'))), {
      mode: 0o600,
    });
    // Publish: only the verified artifact goes into `<out>`. From the tmpfs that is a copy plus a rename
    // inside `<out>` (rename across the two filesystems is EXDEV); staged in `<out>` it is one rename.
    if (scratch.tmpfs) {
      const publish = join(out, `.inprogress.${String(process.pid)}`);
      rmSync(publish, { recursive: true, force: true });
      try {
        cpSync(stage, publish, { recursive: true });
        renameSync(publish, dest);
      } catch (error) {
        // A half-copied `out/.inprogress.<pid>` must not survive a failed publish: the next run would
        // report it as a stale staging directory, and nothing else ever looks inside it.
        rmSync(publish, { recursive: true, force: true });
        throw error;
      }
      rmSync(stage, { recursive: true, force: true });
    } else {
      renameSync(stage, dest);
    }

    const week = isoWeek(startedAt);
    const weeklyDir = join(out, 'weekly', week);
    if (!existsSync(weeklyDir)) {
      try {
        cpSync(dest, weeklyDir, { recursive: true });
      } catch (error) {
        rmSync(weeklyDir, { recursive: true, force: true });
        throw new BackupError('WEEKLY_FAILED', `${weeklyDir}: ${reason(error)}`);
      }
    }

    prune(join(out, 'daily'), opts.keepDaily, name);
    prune(join(out, 'weekly'), opts.keepWeekly, week);

    const ts = startedAt.toISOString();
    const duration = Date.now() - started;
    if (opts.json) {
      console.log(
        JSON.stringify(
          payload({
            ts,
            status: 'ok',
            dir: dest,
            integrity: 'ok',
            ...counts,
            versions: versions.files,
            duration_ms: duration,
          }),
        ),
      );
    } else {
      console.log(
        `book-backup ts=${ts} status=ok dir=${dest}` +
          ` chapters=${String(counts.chapters)} blocks=${String(counts.blocks)}` +
          ` changes=${String(counts.changes)} comments=${String(counts.comments)}` +
          ` versions=${String(versions.files)} duration_ms=${String(duration)}`,
      );
    }
    return EXIT.ok;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

/** `--verify DIR`: readonly, writes nothing, prints the same JSON as a run. */
async function verify(opts, started) {
  const dir = resolve(opts.verify);
  const file = join(dir, 'book.db');
  if (!existsSync(file)) throw new BackupError('DB_MISSING', `no database at ${file}`);
  const counts = inspectReadonly(file);
  const versionsDir = join(dir, 'versions');
  const versions = existsSync(versionsDir) ? walkFiles(versionsDir).length : 0;
  console.log(
    JSON.stringify(
      payload({
        ts: new Date(started).toISOString(),
        status: 'ok',
        dir,
        integrity: 'ok',
        ...counts,
        versions,
        duration_ms: Date.now() - started,
      }),
    ),
  );
  return EXIT.ok;
}

/** One stderr line, one JSON object when the caller asked for JSON or ran `--verify`. */
function reportFailure(opts, error, started) {
  const code = error instanceof BackupError ? error.code : 'INTERNAL';
  const exit = error instanceof BackupError ? error.exit : EXIT.fail;
  const ts = new Date(started).toISOString();
  const text = oneLine(reason(error));
  console.error(
    oneLine(`book-backup ts=${ts} status=fail reason=${code} exit=${String(exit)} message=${JSON.stringify(text)}`),
  );
  if (opts !== null && (opts.json || opts.verify !== null)) {
    console.log(JSON.stringify(payload({ ts, status: 'fail', reason: code, message: text })));
  }
  return exit;
}

export async function main(argv, env = process.env) {
  const started = Date.now();
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (error) {
    const exit = error instanceof BackupError ? error.exit : EXIT.usage;
    const code = error instanceof BackupError ? error.code : 'USAGE';
    console.error(oneLine(`book-backup status=fail reason=${code} message=${JSON.stringify(reason(error))}`));
    console.error(USAGE);
    return exit;
  }
  if (opts.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  try {
    return opts.verify === null ? await backup(opts, started) : await verify(opts, started);
  } catch (error) {
    return reportFailure(opts, error, started);
  }
}

// BOOK-236: decided by REAL paths — the deploy root is a symlink, and the old comparison was false
// through it (a nightly backup that printed nothing and exited 0). An entry that cannot be proved
// is exit 2, never a silent success.
switch (entryState(process.argv[1], import.meta.url)) {
  case 'entry':
    process.exitCode = await main(process.argv.slice(2));
    break;
  case 'unknown':
    console.error(`book-backup: cannot resolve ${String(process.argv[1])} to decide whether it is this CLI — refusing to run (exit 2)`);
    process.exitCode = EXIT.usage;
    break;
  default:
    break;
}
