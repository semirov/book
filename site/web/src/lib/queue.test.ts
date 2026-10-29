import type { QueuePendingDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { pendingInLaneOrder, queuePlaceOf } from './queue.ts';

/**
 * BOOK-DOC-84 #36 — the queue travels in the snapshot.
 *
 * The 10 s `/api/queue` poll is deleted (D6/C), so this module is the only ruler over the
 * pending list: the reader's own place and the lane's order.
 */

const pending = (overrides: Partial<QueuePendingDto> = {}): QueuePendingDto => ({
  id: 'chg_1',
  chapter: 4,
  seq: 1,
  ahead: 0,
  kind: 'edit',
  enqueuedAt: '2026-10-29T10:00:00Z',
  ...overrides,
});

describe('the reader’s place in the lane', () => {
  it('is the nearest pending change of the reader’s own', () => {
    const list = [
      pending({ id: 'chg_1', ahead: 2, seq: 1 }),
      pending({ id: 'chg_2', ahead: 0, seq: 2 }),
      pending({ id: 'chg_3', ahead: 3, seq: 3 }),
    ];
    expect(queuePlaceOf(list, new Set(['chg_1', 'chg_3']))).toEqual({ ahead: 2, chapter: 4 });
    expect(queuePlaceOf(list, new Set(['chg_3']))).toEqual({ ahead: 3, chapter: 4 });
  });

  it('is nothing when the reader has no waiting change, or the snapshot carries no list', () => {
    expect(queuePlaceOf([pending()], new Set())).toBeNull();
    expect(queuePlaceOf([], new Set(['chg_1']))).toBeNull();
    expect(queuePlaceOf(undefined, new Set(['chg_1']))).toBeNull();
  });

  it('lists the lane in its own order, never in arrival order', () => {
    const list = [pending({ id: 'b', seq: 2 }), pending({ id: 'a', seq: 1 })];
    expect(pendingInLaneOrder(list).map((row) => row.id)).toEqual(['a', 'b']);
  });
});
