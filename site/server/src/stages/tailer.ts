/**
 * The stage tailer (docs/writer-lane.md §3): `pass_stages` → one `pass:stage` frame per row.
 *
 * The cursor is the store's own `seq`, seeded at boot from `MAX(seq)`: a stage that happened
 * while the process was down is not news, and a socket that missed one reads it from
 * `GET /api/chapters/:n/stages`. Each row is published once, in `seq` order; the cursor moves
 * only after `emit` returned, so a throw retries the row on the next tick instead of losing it.
 */

import type { PassStageEvent } from '@book/shared';

import type { Db } from '../db/db.ts';
import { listStageRowsAfter, maxStageSeq } from './repo.ts';

export type StageTailerOptions = {
  db: Db;
  emit: (type: 'pass:stage', data: PassStageEvent) => void;
  /** 500 ms in production. */
  intervalMs?: number;
  /** A failed tick is reported, not thrown: the next tick retries the same rows. */
  onError?: (message: string, error: unknown) => void;
};

const DEFAULT_INTERVAL_MS = 500;
/** One tick drains at most this many rows at a time, then reads on, so a burst keeps order. */
const BATCH = 200;

export class StageTailer {
  private readonly db: Db;
  private readonly emit: (type: 'pass:stage', data: PassStageEvent) => void;
  private readonly intervalMs: number;
  private readonly onError: (message: string, error: unknown) => void;
  private cursor: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: StageTailerOptions) {
    this.db = options.db;
    this.emit = options.emit;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onError = options.onError ?? (() => undefined);
    // Nothing before this boot is published live: a reader learns it from the API, with `at`.
    this.cursor = maxStageSeq(options.db);
  }

  /** The last published `seq`; a test reads it to prove the seed. */
  get cursorSeq(): number {
    return this.cursor;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch (error) {
        this.onError('stage tailer tick failed', error);
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick: publish every row past the cursor, in `seq` order. Returns how many went out. */
  poll(): number {
    let published = 0;
    for (;;) {
      const rows = listStageRowsAfter(this.db, this.cursor, BATCH);
      if (rows.length === 0) return published;
      for (const row of rows) {
        this.emit('pass:stage', row.event);
        this.cursor = row.seq;
        published += 1;
      }
      if (rows.length < BATCH) return published;
    }
  }
}
