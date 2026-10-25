/**
 * One connection, no pool, no ORM (ADR-001). WAL lets the future engine process and the
 * site read the same file; writes are serialized by SQLite itself.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function databaseFile(dataDir: string): string {
  return join(dataDir, 'book.db');
}
