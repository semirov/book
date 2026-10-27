import type { HistoryStateDto, StateSnapshot } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { historyLive, historyOf } from './historyState.ts';

/**
 * BOOK-56 / AC2 — the selector that reads the one field.
 *
 * The server derives `readerChanges` from the log; the SPA reads the DTO through this
 * module alone. The source scan that forbids a second reader lives under `server/test/`
 * (the arch gate forbids `node:` imports in `web/src/`).
 */

function pick(history: HistoryStateDto): Pick<StateSnapshot, 'history'> {
  return { history };
}

describe('the history selector', () => {
  it('reads the state DTO: one reader change turns it on, zero keeps it off', () => {
    expect(historyLive(pick({ live: false, readerChanges: 0 }))).toBe(false);
    expect(historyLive(pick({ live: true, readerChanges: 1 }))).toBe(true);
    expect(historyOf(pick({ live: true, readerChanges: 3 }))).toEqual({ live: true, readerChanges: 3 });
  });

  it('is off when the state has no history field at all (an old payload)', () => {
    expect(historyLive(null)).toBe(false);
    expect(historyLive(undefined)).toBe(false);
    expect(historyOf({} as Pick<StateSnapshot, 'history'>)).toEqual({ live: false, readerChanges: 0 });
  });
});
