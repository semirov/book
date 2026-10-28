/**
 * BOOK-175 — the writer that dies mid-transaction.
 *
 * Three committed batches first, so the `-wal` genuinely holds committed frames. Then one open
 * transaction whose rows are large (8 KiB) and whose page cache is tiny (`cache_size`, 16 KiB):
 * SQLite has to spill the dirty pages into the WAL *before* the commit, so the kill lands on a
 * torn write instead of a transaction that only exists in memory.
 *
 * The handshake is emitted from inside the transaction, after the spill, and carries the WAL size
 * this process measured itself — a parent that compares it with the size after the last commit
 * has proof the open transaction left bytes on disk.
 *
 * After the handshake the process writes a **bounded** number of rows and then blocks inside the
 * same transaction with no I/O at all. That bound is the point: a vitest run can be `SIGKILL`ed
 * (an agent timeout does it — see vitest.config.ts) while this fixture is still open, and an
 * orphan nobody reaps must not keep growing a WAL in a temp dir no one will look at. A blocked
 * process is inert: no CPU, no bytes, still mid-transaction, ready for the parent's SIGKILL.
 *
 * argv: <db file>
 * stdout: `committed` per batch, one `in-transaction` handshake, one `quiescent`.
 */

import Database from 'better-sqlite3';
import { statSync, writeSync } from 'node:fs';

const [file] = process.argv.slice(2);
const walPath = `${file}-wal`;

const COMMITTED_BATCHES = 3;
const ROWS_PER_BATCH = 12;
const PAYLOAD_BYTES = 8192;
/** The batch the kill must erase: it is never committed, so its rows must never be visible. */
const PENDING_ORDINAL = 99;
const PENDING_ROWS = 40;
/** Bounded work after the handshake, so an orphaned fixture stops writing by itself. */
const POST_HANDSHAKE_ROWS = 200;

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
// One batch (≈96 KiB of payload) cannot fit in 16 KiB: the open transaction must reach the WAL.
db.pragma('cache_size = -16');

const addBatch = db.prepare('INSERT INTO batches (ordinal) VALUES (?)');
const addRow = db.prepare('INSERT INTO batch_rows (batch_id, payload) VALUES (?, ?)');
// `writeSync`, not `process.stdout.write`: the process blocks right after the last line, and a
// queued async write would never be flushed once the main thread is parked in `Atomics.wait`.
const say = (event) => {
  writeSync(1, `${JSON.stringify(event)}\n`);
};
const walBytes = () => statSync(walPath).size;

const commit = db.transaction((ordinal) => {
  const { lastInsertRowid } = addBatch.run(ordinal);
  for (let row = 0; row < ROWS_PER_BATCH; row += 1) {
    // The fill byte is the ordinal, so a torn page shows up as a payload that does not match its
    // batch — the check the parent runs after recovery.
    addRow.run(lastInsertRowid, Buffer.alloc(PAYLOAD_BYTES, ordinal));
  }
});

for (let ordinal = 0; ordinal < COMMITTED_BATCHES; ordinal += 1) {
  commit(ordinal);
  say({ event: 'committed', ordinal, rows: ROWS_PER_BATCH, walBytes: walBytes() });
}

db.exec('BEGIN IMMEDIATE');
const pending = addBatch.run(PENDING_ORDINAL).lastInsertRowid;
for (let row = 0; row < PENDING_ROWS; row += 1) {
  addRow.run(pending, Buffer.alloc(PAYLOAD_BYTES, 200));
}

say({
  event: 'in-transaction',
  ordinal: PENDING_ORDINAL,
  rows: PENDING_ROWS,
  inTransaction: db.inTransaction,
  walBytes: walBytes(),
  committedRows: COMMITTED_BATCHES * ROWS_PER_BATCH,
  payloadBytes: PAYLOAD_BYTES,
  // The pragmas openDatabase() sets, read back from this process: a fixture that drifted from
  // the production opener would be testing another database.
  journalMode: db.pragma('journal_mode', { simple: true }),
  foreignKeys: db.pragma('foreign_keys', { simple: true }),
});

for (let row = 0; row < POST_HANDSHAKE_ROWS; row += 1) {
  addRow.run(pending, Buffer.alloc(PAYLOAD_BYTES, 201));
}

say({
  event: 'quiescent',
  rowsWritten: POST_HANDSHAKE_ROWS,
  inTransaction: db.inTransaction,
  walBytes: walBytes(),
});

// Blocked on the main thread, inside the open transaction, with no I/O: the process stays alive
// and mid-work for the parent's SIGKILL, and an orphan left by a killed test run does nothing.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
