/**
 * Drafting is not a change and does not enter the FIFO lane (ARCHITECTURE.md §6A.9, §6A.10).
 *
 * Two fronts write away from the two fixed points: `fwd` writes 1→34, `bwd` writes 67→35.
 * The engine only decides *which* slot is next and refuses a draft that would break C1
 * (a neighbour that does not exist yet), the meeting point (the fronts may not cross) or
 * the volume of work in flight. A draft is pulled in the gaps of the lane.
 */

import { FORWARD_LAST, TOTAL_CHAPTERS } from '@book/shared';

import type { Db } from '../db/db.ts';

export type DraftLane = 'fwd' | 'bwd';

/**
 * The next slot of a lane: the first unwritten chapter walking away from its fixed point,
 * so drafting is contiguous by construction. `null` when the lane is done or the fronts
 * have met.
 */
export function nextDraftChapter(written: ReadonlySet<number>, lane: DraftLane): number | null {
  if (lane === 'fwd') {
    let next = 1;
    while (next <= FORWARD_LAST && written.has(next)) next += 1;
    if (next > FORWARD_LAST) return null;
    // The backward front is the lowest chapter it has written; the fronts must not cross.
    const backwardFront = firstWrittenFrom(written, TOTAL_CHAPTERS, FORWARD_LAST + 1);
    if (backwardFront !== null && next >= backwardFront) return null;
    return next;
  }

  let next = TOTAL_CHAPTERS;
  while (next > FORWARD_LAST && written.has(next)) next -= 1;
  if (next <= FORWARD_LAST) return null;
  // The fronts may not cross: the backward lane stops above the forward lane's last chapter.
  if (next <= highestContiguousFrom(written, 1)) return null;
  return next;
}

/** Walking down from `from` to `floor`, the first written chapter (the bwd front). */
function firstWrittenFrom(written: ReadonlySet<number>, from: number, floor: number): number | null {
  for (let n = from; n >= floor; n -= 1) if (written.has(n)) return n;
  return null;
}

function highestContiguousFrom(written: ReadonlySet<number>, from: number): number {
  let highest = from - 1;
  let n = from;
  while (written.has(n)) {
    highest = n;
    n += 1;
  }
  return highest;
}

/** Tokens spent by all roles since 00:00 UTC — the input to the `throttled` state (§6A.12). */
export function dailyTokens(db: Db, nowMs: number): number {
  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  const row = db
    .prepare('SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens FROM steps WHERE at >= ?')
    .get(start.toISOString().replace(/\.\d{3}Z$/u, 'Z')) as { tokens: number };
  return row.tokens;
}
