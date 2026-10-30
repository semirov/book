/**
 * BOOK-DOC-84 §2.1 #9/#36 — the lane's waiting filings, read from the snapshot.
 *
 * The 10 s `/api/queue` poll is gone: `queue.pending` travels with `hello`, `state:snapshot` and
 * `state:updated`, and a change's own place (`ahead`) travels with `change:queued` /
 * `change:processing`. This module is the one ruler over that list — which place the reader's
 * own filing holds, and the waiting list's own row count.
 */

import type { QueuePendingDto } from '@book/shared';

/**
 * The nearest place among the viewer's own waiting changes: the smallest `ahead` of a pending
 * filing the page can name. `null` when the reader has nothing waiting (or the lane's list is
 * not in the payload, which an older snapshot may omit).
 */
export function queuePlaceOf(
  pending: readonly QueuePendingDto[] | undefined,
  ownChangeIds: ReadonlySet<string>,
): { ahead: number; chapter: number } | null {
  if (pending === undefined || pending.length === 0 || ownChangeIds.size === 0) return null;
  let best: { ahead: number; chapter: number } | null = null;
  for (const entry of pending) {
    if (!ownChangeIds.has(entry.id)) continue;
    if (best === null || entry.ahead < best.ahead) best = { ahead: entry.ahead, chapter: entry.chapter };
  }
  return best;
}

/** The lane's waiting rows, in the lane's own order (`seq`), as the snapshot lists them. */
export function pendingInLaneOrder(pending: readonly QueuePendingDto[] | undefined): QueuePendingDto[] {
  return [...(pending ?? [])].sort((left, right) => left.seq - right.seq);
}
