/**
 * BOOK-175 — the four-writer shape on one `book.db`, proven on the upgraded driver.
 *
 * Production runs four writer *processes* against one file (site, engine, writer lane, admin CLI)
 * with `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL` and `foreign_keys = ON`
 * — see `openDatabase()`. That is exactly the shape the WAL-reset bug needed: several processes
 * writing and checkpointing at the same instant.
 *
 * What the loop proves, and what it does not:
 *  - four writers — two in-process handles (site, admin CLI) and two real *processes* (engine,
 *    writer lane) — commit on one file while a fifth connection runs explicit checkpoints
 *    (PASSIVE each round, TRUNCATE every tenth). Every committed row is still there exactly once
 *    and the file is integrity-clean at the end. Handles alone would be the dishonest version of
 *    «four writers»: they share a page cache and a WAL index.
 *  - the shape is the one the WAL-reset bug needed (writers and checkpoints at the same instant),
 *    but with the checkpoint forced by hand: **production has no checkpointer process** — it
 *    relies on SQLite's automatic checkpoint on commit (default 1000 pages), which the child
 *    writers also force to run (`wal_autocheckpoint = 1`). The explicit loop is harsher than what
 *    ships.
 *  - a checkpoint that reports `busy = 1` must be explained by a live writer, never ignored; the
 *    loop asserts that whenever one appears, and whether one does is the scheduler's business.
 *    The *contention* half — a measured lock wait, the retry budget, a checkpoint blocked by a
 *    held lock — is proven by the deterministic tests below, not by the loop.
 *
 * What it cannot prove: that a corrupt file would be caught. The bug is not reproducible on
 * demand; what is assertable is that the engine never reports corruption, never leaks a busy
 * error and never loses a committed row.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { spawnFixture, type FixtureChild } from './support/child.ts';

/** The pragma `openDatabase()` sets: the lock wait inside the driver, and the writers' budget. */
const BUSY_TIMEOUT = 5000;
/** The two child writers: the engine and the writer lane, each committing its own batches. */
const CHILD_WRITERS = [
  { writer: 'engine', transactions: 80, rows: 4 },
  { writer: 'lane', transactions: 80, rows: 4 },
] as const;
/** A budget for the parent's own writes: a lock wait is retried, an escape fails the test. */
const RETRY_LIMIT = 25;
const BACKOFF_MS = 10;

const dirs: string[] = [];
const opened: Db[] = [];
const children: FixtureChild[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await child.kill('SIGKILL');
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp `book.db` in WAL, with a log table narrow enough that a lost or doubled write shows. */
function fixture(): { db: Db; file: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-multi-writer-'));
  dirs.push(dataDir);
  const file = databaseFile(dataDir);
  const db = openDatabase(file);
  opened.push(db);
  db.exec(`
    CREATE TABLE writer_log (
      writer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (writer, seq)
    )
  `);
  return { db, file };
}

/** Another connection on the same file, through the same `openDatabase()` the four writers use. */
function another(file: string): Db {
  const db = openDatabase(file);
  opened.push(db);
  return db;
}

/** A synchronous pause between attempts: the budget is measured, not slept on by a timer. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type WriteStats = { attempts: number; retries: number; maxWaitMs: number };
/** The one statement shape this file runs: `(writer, seq, payload)`. */
type Insert = { run: (writer: string, seq: number, payload: string) => unknown };

/**
 * A write path that retries a lock wait inside a budget — the discipline these tests measure, not
 * the one production runs today: `server/src/engine/control.ts` turns `SQLITE_BUSY` into
 * `DB_BUSY` / 503, and the writer lane retries once at the transport
 * (`server/src/writer/client.ts`). What this adds is the accounting: `busy_timeout` is what SQLite
 * spends waiting inside the driver, this is what happens when that wait is over, and every
 * attempt's wall time is recorded so a wait cannot be absorbed silently.
 */
function writeRow(insert: Insert, stats: WriteStats, writer: string, seq: number): void {
  for (let retry = 0; ; retry += 1) {
    const startedAt = Date.now();
    try {
      insert.run(writer, seq, `${writer}#${String(seq)}`);
      stats.attempts += 1;
      stats.maxWaitMs = Math.max(stats.maxWaitMs, Date.now() - startedAt);
      return;
    } catch (error) {
      stats.attempts += 1;
      stats.maxWaitMs = Math.max(stats.maxWaitMs, Date.now() - startedAt);
      const code = (error as { code?: string }).code ?? '';
      if (!code.startsWith('SQLITE_BUSY')) throw error;
      stats.retries += 1;
      if (retry >= RETRY_LIMIT) throw error;
      pause(BACKOFF_MS);
    }
  }
}

type Checkpoint = { busy: number; log: number; checkpointed: number };
type CheckpointRun = Checkpoint & { mode: 'PASSIVE' | 'TRUNCATE'; writersAlive: boolean };

/** `PRAGMA wal_checkpoint` returns exactly one row: `busy, log, checkpointed`. */
function checkpoint(db: Db, mode: 'PASSIVE' | 'TRUNCATE'): Checkpoint {
  const [row] = db.pragma(`wal_checkpoint(${mode})`) as Checkpoint[];
  if (row === undefined) throw new Error(`wal_checkpoint(${mode}) returned no row`);
  return row;
}

/** Rows this writer committed, as the file itself reports them. */
function rowsOf(db: Db, writer: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM writer_log WHERE writer = ?').get(writer) as { n: number }).n;
}

describe('BOOK-175 — four writers, one book.db, a parent that checkpoints', () => {
  it(
    'writes from two handles and two processes while checkpoints run, with no escaping SQLITE_BUSY',
    async () => {
      const { db, file } = fixture();
      const admin = another(file);
      // An extra connection whose only job is checkpointing. Production has no such process — it
      // relies on SQLite's automatic checkpoint on commit — so this is a harsher stand-in, and it
      // will not park for the production 5000 ms either: a checkpoint that cannot run must
      // *report* that, and the tuple is the answer we are collecting, not the wait in front of it.
      const checkpointer = another(file);
      checkpointer.pragma('busy_timeout = 10');
      const siteInsert = db.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)');
      const adminInsert = admin.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)');
      const stats: WriteStats = { attempts: 0, retries: 0, maxWaitMs: 0 };
      const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;

      const running = CHILD_WRITERS.map((spec) => {
        const child = spawnFixture('writerChild.mjs', [
          file,
          spec.writer,
          String(spec.transactions),
          String(spec.rows),
          String(BUSY_TIMEOUT),
        ]);
        // Registered as it is created: if the second spawn throws, the first must not outlive the
        // test — `afterEach` only kills what is in this list.
        children.push(child);
        return child;
      });

      const startedAt = Date.now();
      const deadline = startedAt + 20_000;
      const checkpoints: CheckpointRun[] = [];
      const written = { site: 0, admin: 0 };
      let iterations = 0;

      while (running.some((child) => child.alive())) {
        if (Date.now() > deadline) {
          throw new Error(
            `writers still running after 20 s: ${running.map((child) => `${String(child.pid)}:${String(child.alive())}`).join(', ')}`,
          );
        }
        iterations += 1;
        written.site += 1;
        writeRow(siteInsert, stats, 'site', written.site);
        written.admin += 1;
        writeRow(adminInsert, stats, 'admin', written.admin);

        // PASSIVE every round keeps the WAL moving; TRUNCATE is the WAL-reset ingredient and the
        // one a live writer blocks, so it gets a turn often enough to be seen and rarely enough
        // not to turn the loop into a checkpoint benchmark.
        const mode = iterations === 1 || iterations % 10 === 0 ? 'TRUNCATE' : 'PASSIVE';
        const writersAlive = running.some((child) => child.alive());
        checkpoints.push({ ...checkpoint(checkpointer, mode), mode, writersAlive });

        // Hand the event loop back. A synchronous loop never sees a child's `exit` event and
        // would sit here until its own deadline, reporting writers that finished long ago.
        await new Promise<void>((resolve) => setImmediate(() => resolve()));
      }

      const summaries = await Promise.all(running.map((child) => child.next((event) => event.event === 'done')));
      const elapsedMs = Date.now() - startedAt;

      // --- the writers that ran as processes ------------------------------------------------
      const childRetries = summaries.reduce((sum, summary) => sum + Number(summary.retries), 0);
      const childMaxWait = summaries.reduce((max, summary) => Math.max(max, Number(summary.maxWaitMs)), 0);
      for (const [index, spec] of CHILD_WRITERS.entries()) {
        const summary = summaries[index];
        if (summary === undefined) throw new Error(`no summary from ${spec.writer}`);
        // The fixture applied openDatabase()'s pragmas, on the same engine, in its own process.
        expect(summary).toMatchObject({
          writer: spec.writer,
          rows: spec.transactions * spec.rows,
          journalMode: 'wal',
          busyTimeout: BUSY_TIMEOUT,
          foreignKeys: 1,
          sqliteVersion: version,
        });
        // A wait longer than the budget would have thrown instead of being reported.
        expect(Number(summary.maxWaitMs)).toBeLessThanOrEqual(BUSY_TIMEOUT);
        expect(rowsOf(db, spec.writer)).toBe(spec.transactions * spec.rows);
      }

      // --- the writes that ran in this process ----------------------------------------------
      expect(rowsOf(db, 'site')).toBe(written.site);
      expect(rowsOf(db, 'admin')).toBe(written.admin);
      expect(db.prepare('SELECT COUNT(*) AS n FROM writer_log').get()).toEqual({
        n: written.site + written.admin + CHILD_WRITERS.reduce((sum, spec) => sum + spec.transactions * spec.rows, 0),
      });
      expect(stats.maxWaitMs).toBeLessThanOrEqual(BUSY_TIMEOUT);

      // --- the file survived all of it ------------------------------------------------------
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');

      // --- the checkpoints actually ran, and a blocked one is explained ---------------------
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints.some((run) => run.mode === 'TRUNCATE')).toBe(true);
      expect(checkpoints.every((run) => run.busy === 0 || run.busy === 1)).toBe(true);
      expect(checkpoints.reduce((sum, run) => sum + run.checkpointed, 0)).toBeGreaterThan(0);
      for (const run of checkpoints) {
        expect(run.log).toBeGreaterThanOrEqual(run.checkpointed);
        // `busy = 1` means the checkpoint could not take its locks. That is contention, not noise:
        // a writer process was alive in the window the checkpoint ran in.
        if (run.busy === 1) expect(run.writersAlive).toBe(true);
      }

      // With every writer gone the same checkpoint must succeed and reset the WAL: the run left
      // no state that a later process has to work around.
      const final = checkpoint(db, 'TRUNCATE');
      expect(final.busy).toBe(0);
      expect(final.checkpointed).toBe(final.log);
      expect(statSync(`${file}-wal`).size).toBe(0);

      console.log(
        `multi-writer: 4 writers, ${String(iterations)} rounds, ${String(checkpoints.length)} checkpoints ` +
          `(${String(checkpoints.filter((run) => run.busy === 1).length)} busy), ` +
          `${String(written.site + written.admin)} in-process writes in ${String(stats.attempts)} attempts, ` +
          `${String(stats.retries + childRetries)} retries and a longest wait of ` +
          `${String(Math.max(childMaxWait, stats.maxWaitMs))} ms — measured, nothing reached the ` +
          `${String(BUSY_TIMEOUT)} ms budget, ${String(elapsedMs)} ms total, all rows present, integrity ok`,
      );
    },
    40_000,
  );

  it('a blocked checkpoint says busy, and truncates once the writer lets go', () => {
    const { db, file } = fixture();
    const writer = another(file);
    const insert = db.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)');
    insert.run('site', 1, 'site#1');
    insert.run('site', 2, 'site#2');

    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)').run('engine', 1, 'engine#1');
    expect(writer.inTransaction).toBe(true);

    // A TRUNCATE that meets a writer sits in the busy handler for ~4 budget spans before it
    // answers, so the production 5000 ms would make this a 20 s test of the wait. What is under
    // test is the *answer* to a lock it cannot take, not how long it waited to say so.
    db.pragma('busy_timeout = 100');
    const blocked = checkpoint(db, 'TRUNCATE');
    // The tuple is the whole point: a checkpoint that cannot run tells you so.
    expect(blocked.busy).toBe(1);
    expect(blocked.log).toBeGreaterThan(0);
    expect(blocked.checkpointed).toBeGreaterThan(0);
    // A truncated WAL is the only outcome a later writer benefits from; a blocked one leaves it.
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);

    writer.exec('ROLLBACK');
    const after = checkpoint(db, 'TRUNCATE');
    expect(after.busy).toBe(0);
    expect(statSync(`${file}-wal`).size).toBe(0);
  });

  it('a reader sees the previous snapshot while a write transaction is open', () => {
    const { db, file } = fixture();
    const reader = another(file);
    const insert = db.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)');
    insert.run('site', 1, 'committed#1');

    const readSeqs = (): number[] =>
      (reader.prepare('SELECT seq FROM writer_log ORDER BY seq').all() as Array<{ seq: number }>).map((row) => row.seq);

    db.exec('BEGIN IMMEDIATE');
    insert.run('site', 2, 'uncommitted#2');
    expect(db.inTransaction).toBe(true);

    // The premise is pinned rather than assumed: this shape runs in WAL — not because a
    // rollback-journal reader would block (a `RESERVED` lock locks writers, not readers), but
    // because WAL is the mode every writer we ship opens.
    expect(reader.pragma('journal_mode', { simple: true })).toBe('wal');

    const startedAt = Date.now();
    // The reader answers while the writer is mid-transaction, and sees the last commit, not the
    // open transaction's rows.
    expect(readSeqs()).toEqual([1]);
    // A reader that took the write lock would sit in the 5 s busy_timeout instead of answering.
    expect(Date.now() - startedAt).toBeLessThan(BUSY_TIMEOUT);

    db.exec('COMMIT');
    expect(readSeqs()).toEqual([1, 2]);
  });

  it('a rolled-back write never becomes visible to the reader', () => {
    const { db, file } = fixture();
    const reader = another(file);
    const insert = db.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)');
    insert.run('site', 1, 'committed#1');

    db.exec('BEGIN IMMEDIATE');
    insert.run('site', 2, 'doomed#2');
    expect(reader.prepare('SELECT COUNT(*) AS n FROM writer_log').get()).toEqual({ n: 1 });
    db.exec('ROLLBACK');

    expect(reader.prepare('SELECT COUNT(*) AS n FROM writer_log').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM writer_log').get()).toEqual({ n: 1 });
  });

  it(
    'a writer that hits the lock pays a measured wait and still lands its row inside the budget',
    async () => {
      const { db, file } = fixture();
      const holder = another(file);
      holder.exec('BEGIN IMMEDIATE');
      holder.prepare('INSERT INTO writer_log (writer, seq, payload) VALUES (?, ?, ?)').run('admin', 1, 'admin#1');

      // A short budget on purpose: 5000 ms cannot be crossed inside a test that must finish in
      // seconds. The mechanism under test — SQLite waits in budget slices, then throws, then the
      // loop retries — is the production one; the measured wait below is what a writer pays.
      const budget = 200;
      const child = spawnFixture('retryChild.mjs', [file, 'engine', String(budget)]);
      children.push(child);

      const lockWait = await child.next((event) => event.event === 'busy');
      // At least one full budget was really spent waiting (a driver without the pragma would have
      // returned instantly), and the wait stayed far inside the production 5000 ms.
      expect(Number(lockWait.waitMs)).toBeGreaterThanOrEqual(budget);
      expect(Number(lockWait.waitMs)).toBeLessThan(BUSY_TIMEOUT);
      // Only now does the holder let go: the wait above cannot have been a scheduling artefact.
      holder.exec('COMMIT');

      const summary = await child.next((event) => event.event === 'done');
      await child.exited;
      expect(summary.busyTimeout).toBe(budget);
      expect(Number(summary.retries)).toBeGreaterThanOrEqual(1);
      expect(Number(summary.retries)).toBeLessThanOrEqual(40);
      expect(Number(summary.maxWaitMs)).toBeLessThan(BUSY_TIMEOUT);
      // The retried write is not a no-op: it landed, once.
      expect(summary.rows).toBe(1);
      expect(rowsOf(db, 'engine')).toBe(1);
      expect(rowsOf(db, 'admin')).toBe(1);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(child.stderr()).toBe('');
      console.log(
        `retry-budget: budget ${String(budget)} ms, first lock wait ${String(lockWait.waitMs)} ms, ` +
          `${String(summary.retries)} retries, longest wait ${String(summary.maxWaitMs)} ms`,
      );
    },
    30_000,
  );
});
