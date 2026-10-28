/**
 * BOOK-175 — what a `SIGKILL` mid-transaction costs, on the upgraded driver.
 *
 * A writer process commits real batches (so the `-wal` genuinely holds committed frames), then
 * opens one big transaction and keeps writing. Its page cache is 16 KiB and its rows are 8 KiB,
 * so SQLite spills the dirty pages into the WAL *before* the commit: the kill lands on a torn
 * write, not on a transaction that only ever lived in memory.
 *
 * A kill of a process with nothing pending proves nothing, so the parent proves the state before
 * it fires: the child reports, from inside its own transaction, that it is in one, how many rows
 * are in flight, and how many bytes the WAL holds — and that byte count is compared with the size
 * after its last commit. The parent then re-reads the committed rows through its own connection
 * while the child is still mid-transaction, which is also the proof that a reader is not blocked.
 *
 * The fixture's post-handshake work is bounded (`POST_HANDSHAKE_ROWS`), and after it the process
 * blocks with no I/O. So the test also owes the bound a proof, not just a comment: the WAL must
 * grow while those rows are written, must be *flat* once the child is quiescent, and must still be
 * flat at the kill. A fixture that kept writing until it was killed would fail here — and if the
 * whole run were killed instead, it would leave an inert orphan rather than a WAL growing forever.
 *
 * After the kill the file is opened with `openDatabase()`: integrity, foreign keys, journal mode,
 * engine version, every committed row present with its payload intact, none of the killed
 * transaction's rows, and a write that succeeds on the recovered file.
 *
 * The pre-kill connection is deliberately left open across the kill. Closing it would let SQLite
 * checkpoint and delete the WAL on the last-connection close, handing the test a file it had
 * already tidied — a recovery test that proves nothing.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { spawnFixture, type FixtureChild } from './support/child.ts';

/** The cap `crashChild.mjs` declares after its handshake; a fixture that grows it fails here. */
const POST_HANDSHAKE_ROWS = 200;
/** How long the parent watches a quiescent writer before killing it. Not a synchronisation. */
const QUIESCENT_WINDOW_MS = 250;

const dirs: string[] = [];
const opened: Db[] = [];
const children: FixtureChild[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await child.kill('SIGKILL');
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** True when `pid` is gone: the signal-0 probe throws `ESRCH` for a reaped process. */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** A synchronous pause: an observation window on a writer that cannot write, not a synchronisation. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A temp `book.db` with the two tables the child writes: a batch and its rows, foreign-keyed. */
function fixture(): { db: Db; file: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-crash-'));
  dirs.push(dataDir);
  const file = databaseFile(dataDir);
  const db = openDatabase(file);
  opened.push(db);
  db.exec(`
    CREATE TABLE batches (
      id INTEGER PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE
    );
    CREATE TABLE batch_rows (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      payload BLOB NOT NULL
    );
  `);
  return { db, file };
}

describe('BOOK-175 — a killed writer leaves a WAL that recovery can finish', () => {
  it(
    'a SIGKILL inside an open transaction keeps every commit and drops the uncommitted batch',
    async () => {
      const { db, file } = fixture();
      const walPath = `${file}-wal`;
      const versionBefore = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;

      const child = spawnFixture('crashChild.mjs', [file]);
      children.push(child);

      // The handshake arrives after every commit, so the committed lines are already in `events`.
      const handshake = await child.next((event) => event.event === 'in-transaction');
      const commits = child.events.filter((event) => event.event === 'committed');
      expect(commits.length).toBeGreaterThan(0);
      /** The batch the kill has to erase; the child names it, so the two files cannot drift. */
      const pending = Number(handshake.ordinal);

      // --- the kill is meaningful, and the test proves it before firing ---------------------
      // 1. the child is inside a transaction, not between two of them, and it ran the same
      //    pragmas as `openDatabase()` — WAL, foreign keys on
      expect(handshake.inTransaction).toBe(true);
      expect(handshake.journalMode).toBe('wal');
      expect(handshake.foreignKeys).toBe(1);
      expect(Number(handshake.rows)).toBeGreaterThan(0);
      // 2. the open transaction spilled: the WAL grew after the last commit, with nothing committed
      const lastCommitWalBytes = Number(commits[commits.length - 1]?.walBytes);
      expect(Number(handshake.walBytes)).toBeGreaterThan(lastCommitWalBytes);
      // 3. the WAL on disk is non-empty at the moment of the kill
      const walAtHandshake = statSync(walPath).size;
      expect(walAtHandshake).toBeGreaterThan(0);
      expect(walAtHandshake).toBeGreaterThanOrEqual(Number(handshake.walBytes));
      // 4. a second connection sees the committed state only — readers are not blocked, and the
      //    in-flight rows are invisible exactly as an uncommitted transaction must be
      const committedRows = Number(handshake.committedRows);
      expect(db.prepare('SELECT COUNT(*) AS n FROM batch_rows').get()).toEqual({ n: committedRows });
      expect(db.prepare('SELECT COUNT(*) AS n FROM batches WHERE ordinal = ?').get(pending)).toEqual({ n: 0 });
      expect(child.alive()).toBe(true);

      // --- the post-handshake work is bounded, and it stops by itself -----------------------
      const quiescent = await child.next((event) => event.event === 'quiescent');
      expect(quiescent.inTransaction).toBe(true);
      expect(Number(quiescent.rowsWritten)).toBe(POST_HANDSHAKE_ROWS);
      const walAtQuiescence = statSync(walPath).size;
      // The bounded rows were really written (the WAL grew), and then the writer went quiet.
      expect(walAtQuiescence).toBeGreaterThan(walAtHandshake);
      expect(walAtQuiescence).toBeGreaterThanOrEqual(Number(quiescent.walBytes));
      pause(QUIESCENT_WINDOW_MS);
      expect(statSync(walPath).size).toBe(walAtQuiescence);

      // --- the kill -------------------------------------------------------------------------
      const walAtKill = statSync(walPath).size;
      expect(walAtKill).toBe(walAtQuiescence);
      expect(walAtKill).toBeGreaterThan(0);
      const exit = await child.kill('SIGKILL');
      expect(exit.signal).toBe('SIGKILL');
      expect(child.alive()).toBe(false);
      expect(pidGone(child.pid)).toBe(true);
      // The frames are still on disk: nothing got to tidy up after the process.
      expect(statSync(walPath).size).toBeGreaterThan(0);

      // --- recovery through the production opener -------------------------------------------
      const recovered = openDatabase(file);
      opened.push(recovered);

      expect(recovered.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(recovered.pragma('foreign_key_check')).toEqual([]);
      expect(recovered.pragma('journal_mode', { simple: true })).toBe('wal');
      expect((recovered.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v).toBe(versionBefore);

      // Every committed batch is present, and every payload is the bytes that were committed —
      // a torn page would show up here as a wrong length or a wrong fill byte.
      const payloadBytes = Number(handshake.payloadBytes);
      expect(recovered.prepare('SELECT COUNT(*) AS n FROM batches').get()).toEqual({ n: commits.length });
      expect(recovered.prepare('SELECT COUNT(*) AS n FROM batch_rows').get()).toEqual({ n: committedRows });
      expect(
        recovered
          .prepare(
            `SELECT COUNT(*) AS n FROM batch_rows r JOIN batches b ON b.id = r.batch_id
              WHERE length(r.payload) <> ?
                 OR hex(substr(r.payload, 1, 2)) <> printf('%02X%02X', b.ordinal, b.ordinal)`,
          )
          .get(payloadBytes),
      ).toEqual({ n: 0 });

      // The killed transaction is gone as a unit: its batch row, its rows, and its unique ordinal
      // are all back to unused — no partial commit.
      expect(recovered.prepare('SELECT COUNT(*) AS n FROM batches WHERE ordinal = ?').get(pending)).toEqual({ n: 0 });
      expect(recovered.prepare('SELECT COUNT(*) AS n FROM batch_rows').get()).toEqual({ n: committedRows });

      // Recovery completed, not just a successful read: the same ordinal writes again.
      const id = Number(
        recovered.prepare('INSERT INTO batches (ordinal) VALUES (?)').run(pending).lastInsertRowid,
      );
      recovered.prepare('INSERT INTO batch_rows (batch_id, payload) VALUES (?, ?)').run(id, Buffer.alloc(payloadBytes, 7));
      expect(recovered.prepare('SELECT COUNT(*) AS n FROM batches').get()).toEqual({ n: commits.length + 1 });
      expect(recovered.prepare('SELECT COUNT(*) AS n FROM batch_rows').get()).toEqual({ n: committedRows + 1 });
      expect(recovered.pragma('integrity_check', { simple: true })).toBe('ok');

      console.log(
        `crash-recovery: ${String(commits.length)} committed batches (${String(committedRows)} rows), ` +
          `${String(lastCommitWalBytes)} B WAL after last commit, ` +
          `${String(walAtHandshake)} B with ${String(handshake.rows)} rows in flight, ` +
          `+${String(walAtQuiescence - walAtHandshake)} B from ${String(quiescent.rowsWritten)} bounded rows, ` +
          `flat at ${String(walAtQuiescence)} B over ${String(QUIESCENT_WINDOW_MS)} ms and at SIGKILL`,
      );
      expect(child.stderr()).toBe('');
    },
    40_000,
  );
});
