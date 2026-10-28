/**
 * BOOK-175 — a writer that really hits the lock, so the retry budget is *measured* instead of
 * asserted in the abstract.
 *
 * The parent holds `BEGIN IMMEDIATE` on the same file when this process starts. The opening
 * `busy_timeout` is short on purpose: a test must finish in seconds, and a 5000 ms budget cannot
 * be crossed by a test that lives 200 ms. What is identical to production is the part under
 * test — SQLite waits inside the driver in budget-sized slices (a lock acquisition that meets a
 * writer spans several of them, ~4x the pragma on this engine), the driver then raises
 * `SQLITE_BUSY`, and the retry loop decides what happens next.
 *
 * argv: <db file> <writer name> <busyTimeoutMs>
 * stdout: `busy` per lock wait (`waitMs`), then one `done` with the totals.
 */

import Database from 'better-sqlite3';

import { withRetry } from './retry.mjs';

const [file, writer, busyArg] = process.argv.slice(2);
const busyTimeout = Number(busyArg);

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma(`busy_timeout = ${busyTimeout}`);

const insert = db.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)');
const write = db.transaction(() => insert.run(writer, 1, `${writer}#1`)).immediate;

const busies = [];
const result = withRetry(write, {
  // Both bounds are far above what the handshake needs: they exist to fail loudly if the parent
  // never releases the lock, not to race it.
  retries: 40,
  budgetMs: 10_000,
  backoffMs: 25,
  onBusy: (busy) => {
    busies.push(busy);
    process.stdout.write(`${JSON.stringify({ event: 'busy', ...busy })}\n`);
  },
});

process.stdout.write(
  `${JSON.stringify({
    event: 'done',
    writer,
    attempts: result.attempts,
    retries: result.retries,
    waitMs: result.waitedMs,
    maxWaitMs: result.maxWaitMs,
    busies: busies.length,
    busyTimeout: db.pragma('busy_timeout', { simple: true }),
    journalMode: db.pragma('journal_mode', { simple: true }),
    rows: (db.prepare('SELECT COUNT(*) AS n FROM writer_log WHERE writer = ?').get(writer) ?? { n: 0 }).n,
  })}\n`,
);

db.close();
