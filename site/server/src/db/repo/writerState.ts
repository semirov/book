/**
 * `writer_state` — the writer lane's counter, the row that replaced `writer/state.json`
 * (BOOK-187 AC5, ADR-043 §1 «spend, stages, transcripts, attempts — DB»).
 *
 * The writer process holds no database handle (one writer kernel per process, BOOK-183), so this
 * module is only ever reached through the engine: `GET /internal/writer-state` reads it and
 * `POST /internal/writer-state` writes it. The table is one row (`id = 1`), which is what makes
 * the write a single statement and the day a single fact.
 *
 * **The day belongs to the caller's clock.** A row stamped `2026-10-27` read with `day=2026-10-28`
 * is a fresh day — no midnight job resets it, and a writer that was asleep for a week cannot spend
 * a week's passes in one minute. The row keeps its own day until the next spending pass moves it.
 *
 * The write is **one transaction** (read the row, decide, write): a read outside the write would
 * let two callers both see `passes = 3` and both store `4`. It is taken `IMMEDIATE`, so the write
 * lock is held from `BEGIN`: a second connection waits at the door instead of reading a row it is
 * about to fail to upgrade — one writer kernel (BOOK-183) does not make the pair atomic by itself.
 */

import type { WriterStateDto } from '@book/shared';

import type { Db } from '../db.ts';
import { toIso } from '../../util/time.ts';

/** A day the counter may name: `YYYY-MM-DD` that is a real calendar date in UTC. */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * `2026-02-30` and `2026-13-01` are not days. The round trip through `Date.UTC` is the check:
 * a value that does not survive it is refused by the route with a 400, never stored as a bucket
 * nobody can ask for again.
 */
export function isIsoDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

type StateRow = {
  day: string;
  passes: number;
  last_pass_at: string | null;
  pause_until: string | null;
};

function readRow(db: Db): StateRow | null {
  const row = db.prepare('SELECT day, passes, last_pass_at, pause_until FROM writer_state WHERE id = 1').get() as
    | StateRow
    | undefined;
  return row ?? null;
}

function dto(row: StateRow): WriterStateDto {
  return { day: row.day, passes: row.passes, lastPassAt: row.last_pass_at, pauseUntil: row.pause_until };
}

/**
 * The counter as `day`'s reader sees it: the row when it is about that day, a fresh day otherwise.
 * `passes` is never negative and never inherited across days.
 */
export function readWriterState(db: Db, day: string): WriterStateDto {
  const row = readRow(db);
  if (row === null || row.day !== day) return { day, passes: 0, lastPassAt: null, pauseUntil: null };
  return dto(row);
}

/** The row as it stands, whatever day it names — what the two health answers print. */
export function readWriterSummary(db: Db): WriterStateDto | null {
  const row = readRow(db);
  return row === null ? null : dto(row);
}

export type RecordPassInput = {
  /** The caller's day bucket (`YYYY-MM-DD`, UTC). */
  day: string;
  /** Did the pass spend money? A closed or parked pass did; an idle one did not. */
  spent: boolean;
  /** `undefined` leaves the column alone, `null` clears it, a string sets it. */
  pauseUntil?: string | null;
  /** The clock, for a fixture; the row is stamped in UTC seconds. */
  now?: number;
};

/**
 * Count one pass and answer the resulting row. In one transaction:
 *  · no row → insert it (`passes = spent ? 1 : 0`);
 *  · a row for another day → reset to this day with the same `spent` rule;
 *  · a row for this day → `passes + (spent ? 1 : 0)`.
 * `last_pass_at` moves only when money was spent, `updated_at` always, and `pause_until` only when
 * the caller said something about it.
 */
export function recordWriterState(db: Db, input: RecordPassInput): WriterStateDto {
  const at = toIso(input.now ?? Date.now());
  const write = db.transaction((): WriterStateDto => {
    const row = readRow(db);
    const sameDay = row !== null && row.day === input.day;
    const next: WriterStateDto = {
      day: input.day,
      passes: (sameDay ? row.passes : 0) + (input.spent ? 1 : 0),
      lastPassAt: input.spent ? at : (row?.last_pass_at ?? null),
      pauseUntil: input.pauseUntil === undefined ? (row?.pause_until ?? null) : input.pauseUntil,
    };
    db.prepare(
      `INSERT INTO writer_state (id, day, passes, last_pass_at, pause_until, updated_at)
       VALUES (1, @day, @passes, @lastPassAt, @pauseUntil, @at)
       ON CONFLICT(id) DO UPDATE SET
         day = @day, passes = @passes, last_pass_at = @lastPassAt,
         pause_until = @pauseUntil, updated_at = @at`,
    ).run({ ...next, at });
    return next;
  });
  return write.immediate();
}
