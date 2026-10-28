/**
 * BOOK-175 — one of the four writer processes: its own connection on the shared `book.db`, the
 * same pragmas `openDatabase()` sets (server/src/db/db.ts — this fixture must not drift from it),
 * committed batches, and a report of what the contention cost it.
 *
 * Plain node and plain `better-sqlite3`: no tsx, no site code, because the point is the process
 * boundary, not our wrappers.
 *
 * argv: <db file> <writer name> <transactions> <rowsPerTransaction> [busyTimeoutMs]
 * stdout: one JSON line at the end (`event: done`); a throw exits non-zero with stderr, which is
 * how a caller sees a writer that did not finish instead of a quiet shortfall.
 */

import Database from 'better-sqlite3';

import { withRetry } from './retry.mjs';

const [file, writer, transactionsArg, rowsArg, busyArg] = process.argv.slice(2);
const transactions = Number(transactionsArg);
const rows = Number(rowsArg);
const busyTimeout = Number(busyArg ?? 5000);

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma(`busy_timeout = ${busyTimeout}`);
// The checkpoint path production actually runs: SQLite's automatic checkpoint on commit (default
// 1000 pages). Set to every commit here, so the four writers race *automatic* checkpoints — and
// the WAL reset — not only the parent's explicit pragmas.
db.pragma('wal_autocheckpoint = 1');

const insert = db.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)');

let seq = 0;
/** `immediate`: a writer that knows it will write takes the lock up front, as the engine does. */
const commit = db.transaction(() => {
  for (let row = 0; row < rows; row += 1) {
    seq += 1;
    insert.run(writer, seq, `${writer}#${seq}`);
  }
}).immediate;

let attempts = 0;
let retries = 0;
let waitedMs = 0;
let maxWaitMs = 0;

for (let n = 0; n < transactions; n += 1) {
  // The budget is wide enough that only a stuck writer reaches it: the lock waits we expect are
  // measured, and a retry is reported rather than hidden.
  const result = withRetry(commit, { budgetMs: busyTimeout * 4, backoffMs: 5 });
  attempts += result.attempts;
  retries += result.retries;
  waitedMs += result.waitedMs;
  maxWaitMs = Math.max(maxWaitMs, result.maxWaitMs);
}

process.stdout.write(
  `${JSON.stringify({
    event: 'done',
    writer,
    transactions,
    rows: transactions * rows,
    attempts,
    retries,
    waitedMs,
    maxWaitMs,
    // Read back from this process: the caller can prove the fixture ran the production pragmas,
    // not a quieter set of its own.
    journalMode: db.pragma('journal_mode', { simple: true }),
    busyTimeout: db.pragma('busy_timeout', { simple: true }),
    foreignKeys: db.pragma('foreign_keys', { simple: true }),
    sqliteVersion: db.prepare('SELECT sqlite_version() AS v').get().v,
  })}\n`,
);

db.close();
