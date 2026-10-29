/**
 * Draining the push outbox (BOOK-189) — the site process's only push responsibility.
 *
 * The engine writes rows and stops (ADR-012: it has no network). This module is the other half:
 * it takes the due rows, sends each to the reader's devices, and settles the row by what
 * happened. Three bounds keep it honest:
 *
 *   · **one batch per tick** (`limit`), so the timer is bounded by work, not by the queue;
 *   · **a day's life** (`expires_at`): a site that was down overnight delivers nothing stale —
 *     a notification about yesterday's chapter is a lie about now, and the chapter page already
 *     says what landed;
 *   · **three attempts**, spaced `60s × attempts`, then the row is dropped. A push service that
 *     failed three times is not coming back for this message.
 *
 * **A row is claimed before it is sent.** Selecting a row and sending it are not one act: a send
 * can take seconds, and a second drain (an overlapping tick before the timer was self-scheduling,
 * a restarted site, a second process on the same file) would select the same row and the reader
 * would be told twice. The claim is the conditional `UPDATE … WHERE id = ? AND next_at <= ?`:
 * exactly one drain moves `next_at` past the tick, and only the one that moved it sends. The
 * value it writes is the retry floor, so a crash between claim and send leaves the row to be
 * tried again instead of spinning on every tick.
 *
 * Failure bookkeeping is written from the database, never from the copy the selection returned:
 * `attempts = attempts + 1` in SQL, then `next_at` (or the drop) decided from the value read back.
 * A claimed-but-failed row therefore always survives with its next attempt and its count intact.
 *
 * Failure is per row: one bad row (a device the push service rejects in some new way) cannot
 * stall the queue behind it, and a throw anywhere in one row's handling is a failed attempt
 * rather than an exception that ends the tick.
 *
 * The log line is counts and only counts — `push: sent=1 gone=0 failed=0 expired=0`. An endpoint
 * is a capability and a payload is a reader's business; neither belongs in a log that an
 * operator, a backup and a bug report may all read.
 */

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { deleteSubscriptionByEndpoint, subscriptionsOf, type PushSubscription } from './repo.ts';

/** What a notification says. Four fields, and no fifth may appear: see `passEvent.ts`. */
export type PushMessage = { title: string; body: string; url: string; tag: string };

/**
 * One attempt at one device. The three outcomes are the whole vocabulary of a push service's
 * answer — `gone` is the dead subscription, `error` is «try later», `ok` is delivered.
 */
export type PushTransport = (
  subscription: PushSubscription,
  message: PushMessage,
) => Promise<{ status: 'ok' } | { status: 'gone' } | { status: 'error' }>;

export type DrainOptions = {
  transport: PushTransport;
  nowMs: number;
  /** Rows per tick. The default keeps a tick short enough for a 2-second timer. */
  limit?: number;
  /** Receives one counts-only line per non-empty tick; the site passes its own logger. */
  log?: (line: string) => void;
};

/**
 * What one tick did. A row lands in exactly one of `sent`/`expired`/`failed`; `gone` counts the
 * **devices** a tick forgot, so a row whose only device was dead appears in both `gone` and
 * `failed` — it was not delivered, and the dead subscription was cleaned up on the way.
 */
export type DrainResult = { sent: number; gone: number; failed: number; expired: number };

/** Attempts before a row is dropped. */
export const PUSH_MAX_ATTEMPTS = 3;
/** The first retry waits a minute; the next, two. */
const RETRY_STEP_MS = 60_000;

type OutboxRow = {
  id: number;
  identity_id: string;
  chapter: number;
  title: string;
  body: string;
  url: string;
  tag: string;
  expires_at: string;
  attempts: number;
};

export async function drainPush(db: Db, options: DrainOptions): Promise<DrainResult> {
  const now = toIso(options.nowMs);
  const rows = db
    .prepare(
      `SELECT id, identity_id, chapter, title, body, url, tag, expires_at, attempts
         FROM push_outbox WHERE next_at <= ? ORDER BY id LIMIT ?`,
    )
    .all(now, options.limit ?? 20) as OutboxRow[];

  const result: DrainResult = { sent: 0, gone: 0, failed: 0, expired: 0 };
  for (const row of rows) {
    try {
      await drainRow(db, row, options, now, result);
    } catch {
      // A row this build cannot even handle is still a row: it spends an attempt like any other
      // failure, so a poisoned row leaves the queue instead of spinning on every tick.
      result.failed += 1;
      retryOrDrop(db, row.id, options.nowMs, null);
    }
  }

  if (rows.length > 0) {
    options.log?.(
      `push: sent=${String(result.sent)} gone=${String(result.gone)} failed=${String(result.failed)} expired=${String(result.expired)}`,
    );
  }
  return result;
}

async function drainRow(
  db: Db,
  row: OutboxRow,
  options: DrainOptions,
  now: string,
  result: DrainResult,
): Promise<void> {
  if (row.expires_at <= now) {
    // Yesterday's news is deleted, not sent — and not claimed: nothing is owed to anyone.
    drop(db, row.id);
    result.expired += 1;
    return;
  }

  if (!claim(db, row, options.nowMs, now)) return;

  const devices = subscriptionsOf(db, row.identity_id);
  if (devices.length === 0) {
    // The reader removed their last device between the claim and the drain: the queue can never
    // deliver this row, so it goes now rather than aging out an hour later.
    drop(db, row.id);
    result.failed += 1;
    return;
  }

  const message: PushMessage = { title: row.title, body: row.body, url: row.url, tag: row.tag };
  let dead = 0;
  for (const device of devices) {
    const outcome = await options.transport(device, message);
    if (outcome.status === 'ok') {
      drop(db, row.id);
      result.sent += 1;
      return;
    }
    if (outcome.status === 'gone') {
      deleteSubscriptionByEndpoint(db, device.endpoint);
      dead += 1;
    }
  }

  result.gone += dead;
  result.failed += 1;
  retryOrDrop(db, row.id, options.nowMs, devices.length - dead);
}

/**
 * Takes the row for this tick, or loses the race and reports it. `next_at` moves past `now` in
 * the same statement that proves the row was still due: two drains cannot both see `changes === 1`.
 * The moment written is the retry floor of the attempt being made, so an interrupted tick delays
 * the next try by the same amount a failure would (and `attempts` is untouched until one fails).
 */
function claim(db: Db, row: OutboxRow, nowMs: number, now: string): boolean {
  const claimed = db
    .prepare('UPDATE push_outbox SET next_at = ? WHERE id = ? AND next_at <= ?')
    .run(toIso(nowMs + RETRY_STEP_MS * (row.attempts + 1)), row.id, now).changes;
  return claimed === 1;
}

/**
 * Bookkeeping for a row that was not delivered: one more attempt, a later `next_at`, or the drop
 * once the attempts are spent. The count is incremented **in SQL** and read back — a copy the
 * selection returned may already be stale, and a wrong count either retries a row forever or
 * drops it after one try. `devicesLeft` is `null` when the failure happened outside this row's
 * delivery (the catch above): then the count is unknown and only the attempt is spent. A row
 * with no device left at all is dropped at once — there is nothing to retry towards.
 */
function retryOrDrop(db: Db, id: number, nowMs: number, devicesLeft: number | null): void {
  const bumped = db
    .prepare('UPDATE push_outbox SET attempts = attempts + 1 WHERE id = ? RETURNING attempts')
    .get(id) as { attempts: number } | undefined;
  // Gone from another tick's drop: nothing left to book.
  if (bumped === undefined) return;
  if (bumped.attempts >= PUSH_MAX_ATTEMPTS || devicesLeft === 0) {
    drop(db, id);
    return;
  }
  db.prepare('UPDATE push_outbox SET next_at = ? WHERE id = ?').run(
    toIso(nowMs + RETRY_STEP_MS * bumped.attempts),
    id,
  );
}

function drop(db: Db, id: number): void {
  db.prepare('DELETE FROM push_outbox WHERE id = ?').run(id);
}
