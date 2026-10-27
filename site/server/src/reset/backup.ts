/**
 * BOOK-137 — the copy taken before a wipe, and the three things that make it a backup rather
 * than a file: mode `0600`, a passing `PRAGMA integrity_check`, and the same content counts the
 * live database reports.
 *
 * One rule outranks the rest: a file the reset did not create is never deleted. `VACUUM INTO`
 * refuses an existing target, and unlinking it in the catch would destroy the very copy an
 * earlier reset left behind (M2).
 */

import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { Db } from '../db/db.ts';
import { type BookCount, countBook } from './counts.ts';

/** The verified backup, as the operator needs to read it: a path, a mode and two facts. */
export type BackupFact = { file: string; mode: '0600'; integrity: 'ok'; countsMatch: true };

export class BackupFailedError extends Error {
  readonly code = 'BACKUP_FAILED';
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = 'BackupFailedError';
  }
}

/** `book-reset-20261028T120000Z.db`, with `-1`, `-2`… when the same second runs twice. */
export function backupPath(dataDir: string, now: Date, asked?: string): string {
  if (asked !== undefined) return asked;
  const stamp = now.toISOString().replace(/\.\d{3}Z$/u, 'Z').replace(/[-:]/gu, '');
  const base = join(dataDir, `book-reset-${stamp}.db`);
  let candidate = base;
  for (let suffix = 1; existsSync(candidate); suffix += 1) {
    candidate = join(dataDir, `book-reset-${stamp}-${String(suffix)}.db`);
  }
  return candidate;
}

/** A partial backup is a lie with a filename: remove it before reporting the failure. */
function removeQuietly(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // Nothing to salvage: the failure below names the path, and the file is not a backup.
  }
}

function failureOf(stage: string, error: unknown, file: string): BackupFailedError {
  const errno = (error as NodeJS.ErrnoException).code ?? 'ERROR';
  return new BackupFailedError(`backup ${stage} failed (${errno}) at ${file}`, file);
}

function sameCounts(left: readonly BookCount[], right: readonly BookCount[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && other.key === entry.key && other.rows === entry.rows;
  });
}

/**
 * Copy the book, then check the copy. Only a file this call created is removed on failure: a
 * target that already exists is refused before anything is written.
 */
export function writeBackup(db: Db, file: string, expected: readonly BookCount[]): BackupFact {
  if (existsSync(file)) throw new BackupFailedError(`backup target already exists at ${file}`, file);
  try {
    db.prepare('VACUUM INTO ?').run(file);
  } catch (error) {
    removeQuietly(file);
    throw failureOf('VACUUM INTO', error, file);
  }
  try {
    chmodSync(file, 0o600);
  } catch (error) {
    removeQuietly(file);
    throw failureOf('chmod 0600', error, file);
  }
  let copy: Database.Database | null = null;
  try {
    copy = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = copy.pragma('integrity_check', { simple: true }) as unknown;
    if (integrity !== 'ok') throw new Error(`integrity_check said ${String(integrity)}`);
    if (!sameCounts(countBook(copy), expected)) throw new Error('counts differ from the live book');
  } catch (error) {
    removeQuietly(file);
    throw failureOf('verification', error, file);
  } finally {
    copy?.close();
  }
  return { file, mode: '0600', integrity: 'ok', countsMatch: true };
}
