/**
 * bin/lib/backupFs.mjs — the volume half of `bin/backup.mjs` (BOOK-183).
 *
 * The CLI is about the database; this is about the volume around it: the lock, the free-space
 * floor, the `versions/` tree, the manifest and retention. None of it is Docker-specific and none
 * of it knows the schema, which is also why it lives here: `scripts/arch.mjs` caps a file at 500
 * lines, and one operator tool reads better as "database" plus "directory".
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** The tables the manifest proves: the book's text, its progress, its filings and its audit. */
export const TABLES = ['chapters', 'blocks', 'changes', 'comments', 'identities', 'revisions', 'events'];
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
export const EXIT = { ok: 0, fail: 1, usage: 2, locked: 75 };

/** A failure with a name the operator can grep, and the exit code it deserves. */
export class BackupError extends Error {
  constructor(code, message, exit = EXIT.fail) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.exit = exit;
  }
}

export const reason = (error) => (error instanceof Error ? error.message : String(error));

/** `daily/<YYYYmmddTHHMMSS>` in UTC: lexicographic order is chronological order. */
export function stamp(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/** ISO-8601 week label (`2026-W44`), UTC — the week the old `date +%G-W%V` chose locally. */
export function isoWeek(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

/** Every file under `root`, as `/`-joined relative paths, sorted — deterministic manifests. */
export function walkFiles(root, prefix = '', out = []) {
  for (const name of readdirSync(prefix.length === 0 ? root : join(root, prefix)).sort()) {
    const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
    const stats = lstatSync(join(root, relative));
    if (stats.isDirectory()) walkFiles(root, relative, out);
    else if (stats.isFile()) out.push(relative);
  }
  return out;
}

export function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  return walkFiles(dir).reduce((sum, relative) => sum + statSync(join(dir, relative)).size, 0);
}

/** Streaming sha256: `versions/` holds prose snapshots, and a backup must not need their RAM. */
export function sha256(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read = readSync(fd, buffer, 0, buffer.length, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      read = readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** `statfs` is the bavail the filesystem reports to an unprivileged writer, not the total. */
export function freeBytes(dir) {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch (error) {
    throw new BackupError('STATFS_FAILED', `${dir}: ${reason(error)}`);
  }
}

/** `mkdir` as a yes/no: EEXIST is the answer "someone else has it", not an exception. */
function mkdirOrFalse(dir) {
  try {
    mkdirSync(dir);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw new BackupError('LOCK_FAILED', `${dir}: ${reason(error)}`);
  }
}

/**
 * `<out>/.lock` is a directory: `mkdir` is atomic on every filesystem this runs on, and a lock
 * older than 6 h is a crashed run, not a busy one. Two runs racing for the stale lock both try to
 * take it; exactly one `mkdir` wins and the loser exits 75.
 */
export function takeLock(lock) {
  if (mkdirOrFalse(lock)) return;
  let age = null;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    age = null;
  }
  if (age !== null && age <= LOCK_STALE_MS) {
    throw new BackupError('LOCKED', `another run holds ${lock} (age ${String(Math.round(age / 1000))}s)`, EXIT.locked);
  }
  rmSync(lock, { recursive: true, force: true });
  if (!mkdirOrFalse(lock)) {
    throw new BackupError('LOCKED', `another run took ${lock} after a stale one`, EXIT.locked);
  }
}

/** Counts first, then the sorted proof — what a restore drill diffs against the source. */
export function manifestText(counts, versions, dbHash) {
  const head = `${TABLES.map((table) => `${table}=${String(counts[table])}`).join(' ')} versions_files=${String(versions.files)}`;
  const lines = [{ relative: 'book.db', hash: dbHash }, ...versions.hashes]
    .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
    .map((entry) => `${entry.hash}  ${entry.relative}`);
  return `${head}\n${lines.join('\n')}\n`;
}

/** Newest first is name order; `keep` survives, and the run's own directory never goes. */
export function prune(dir, keep, protectedName) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => !name.startsWith('.')).sort().reverse();
  } catch {
    return;
  }
  for (const name of names.slice(keep)) {
    if (name === protectedName) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch (error) {
      throw new BackupError('PRUNE_FAILED', `${join(dir, name)}: ${reason(error)}`);
    }
  }
}

/**
 * `versions/` is content-addressed snapshots; a copy of it is only worth something if every file
 * arrived. Two proofs, both from the old script: the file count matches, and each file's sha256
 * matches the source. Nothing is trusted from the copy alone.
 */
export function copyVersions(source, dest) {
  if (!existsSync(source)) return { files: 0, hashes: [] };
  const relatives = walkFiles(source);
  for (const relative of relatives) {
    const from = join(source, relative);
    const to = join(dest, relative);
    try {
      mkdirSync(dirname(to), { recursive: true });
      const stats = statSync(from);
      copyFileSync(from, to);
      chmodSync(to, stats.mode & 0o777);
      utimesSync(to, stats.atime, stats.mtime);
    } catch (error) {
      throw new BackupError('VERSIONS_COPY_FAILED', `${from}: ${reason(error)}`);
    }
  }
  const copied = existsSync(dest) ? walkFiles(dest) : [];
  if (copied.length !== relatives.length) {
    throw new BackupError(
      'VERSIONS_COUNT_MISMATCH',
      `source ${String(relatives.length)} files, copy ${String(copied.length)}`,
    );
  }
  const hashes = relatives.map((relative) => {
    const from = sha256(join(source, relative));
    const to = sha256(join(dest, relative));
    if (from !== to) throw new BackupError('VERSIONS_CHECKSUM_MISMATCH', relative);
    return { relative: `versions/${relative}`, hash: to };
  });
  return { files: relatives.length, hashes };
}
