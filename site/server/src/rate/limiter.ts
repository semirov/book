/**
 * Rate limiting (ARCHITECTURE.md §14; ADR-010).
 *
 * Exact sliding windows over the `rate_events` table, which is the only store: there is no
 * in-memory mirror to drift from it, and a restart does not forget a budget. One
 * synchronous block does check-and-insert inside a transaction, so two requests cannot both
 * take the last slot on a single node. No Redis, by decision, not by omission.
 *
 * The store is a *budget*, not an authorization check: the caller decides what a refusal
 * means and which public error code to return.
 */

import type { Db } from '../db/db.ts';

export type LimitSpec = { key: string; limit: number; windowMs: number };

export type LimitVerdict = {
  allowed: boolean;
  key: string;
  limit: number;
  used: number;
  remaining: number;
  /** When the oldest event in the window leaves it; `null` when nothing was recorded. */
  resetAtMs: number | null;
  retryAfterMs: number;
};

export type ConsumeResult =
  | { allowed: true; verdicts: LimitVerdict[] }
  | { allowed: false; blocked: LimitVerdict; verdicts: LimitVerdict[] };

const GLOBAL_PRUNE_EVERY_MS = 60 * 60_000;
/** §14 retention: `rate_events` keeps one hour of history — every window but the daily edit fits. */
const KEEP_MS = 60 * 60_000;
/** The daily edit budget is the one window longer than an hour; its rows must survive it. */
const EDIT_KEY_PREFIX = 'edit:';
const EDIT_KEEP_MS = 24 * 60 * 60_000;

export class RateLimiter {
  private readonly db: Db;
  private readonly now: () => number;
  private lastPruneAt = 0;

  constructor(db: Db, now: () => number = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  /** Read-only check: used by GET/health paths and by tests that assert "no slot". */
  check(spec: LimitSpec): LimitVerdict {
    const nowMs = this.now();
    const since = nowMs - spec.windowMs;
    const rows = this.db
      .prepare('SELECT ts FROM rate_events WHERE key = ? AND ts > ? ORDER BY ts')
      .all(spec.key, since) as Array<{ ts: number }>;
    return verdict(spec, rows.map((row) => row.ts), nowMs);
  }

  /**
   * All-or-nothing: every spec must pass, and only then is one event recorded per key. A
   * comment counted against both the IP and the identity is therefore never half-counted.
   */
  consume(specs: readonly LimitSpec[]): ConsumeResult {
    if (specs.length === 0) return { allowed: true, verdicts: [] };
    const nowMs = this.now();
    this.pruneIfDue(nowMs);

    const run = this.db.transaction((): ConsumeResult => {
      const verdicts = specs.map((spec) => this.check(spec));
      const blocked = verdicts.find((entry) => !entry.allowed);
      if (blocked !== undefined) return { allowed: false, blocked, verdicts };

      const insert = this.db.prepare('INSERT INTO rate_events (key, ts) VALUES (?, ?)');
      for (const verdictRow of verdicts) insert.run(verdictRow.key, nowMs);
      return {
        allowed: true,
        verdicts: verdicts.map((entry) => ({
          ...entry,
          used: entry.used + 1,
          remaining: Math.max(0, entry.limit - entry.used - 1),
        })),
      };
    });
    return run();
  }

  /** Record an event without a check: the host CLI and the decisions tailer own their gates. */
  record(key: string, atMs: number = this.now()): void {
    this.db.prepare('INSERT INTO rate_events (key, ts) VALUES (?, ?)').run(key, atMs);
  }

  /** Delete the rows of one key that have left the window (lazy, cheap). */
  pruneKey(key: string, windowMs: number): void {
    this.db.prepare('DELETE FROM rate_events WHERE key = ? AND ts <= ?').run(key, this.now() - windowMs);
  }

  private pruneIfDue(nowMs: number): void {
    if (nowMs - this.lastPruneAt < GLOBAL_PRUNE_EVERY_MS) return;
    this.lastPruneAt = nowMs;
    // Two ranges, because §14 keeps the counters short but the daily edit budget must
    // actually cover a day: pruning its rows early would hand back the slot.
    this.db
      .prepare('DELETE FROM rate_events WHERE ts < ? AND key NOT LIKE ?')
      .run(nowMs - KEEP_MS, `${EDIT_KEY_PREFIX}%`);
    this.db
      .prepare('DELETE FROM rate_events WHERE ts < ? AND key LIKE ?')
      .run(nowMs - EDIT_KEEP_MS, `${EDIT_KEY_PREFIX}%`);
  }
}

function verdict(spec: LimitSpec, stamps: readonly number[], nowMs: number): LimitVerdict {
  const used = stamps.length;
  const oldest = stamps[0];
  const resetAtMs = oldest === undefined ? null : oldest + spec.windowMs;
  return {
    allowed: used < spec.limit,
    key: spec.key,
    limit: spec.limit,
    used,
    remaining: Math.max(0, spec.limit - used),
    resetAtMs,
    retryAfterMs: resetAtMs === null ? 0 : Math.max(0, resetAtMs - nowMs),
  };
}
