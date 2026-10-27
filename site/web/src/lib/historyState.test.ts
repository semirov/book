import type { HistoryStateDto, StateSnapshot } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { historyLive, historyOf, historyStarted } from './historyState.ts';

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
    expect(historyLive(pick({ live: false, readerChanges: 0, started: false }))).toBe(false);
    expect(historyLive(pick({ live: true, readerChanges: 1, started: true }))).toBe(true);
    expect(historyOf(pick({ live: true, readerChanges: 3, started: true }))).toEqual({
      live: true,
      readerChanges: 3,
      started: true,
    });
  });

  it('is off when the state has no history field at all (an old payload)', () => {
    expect(historyLive(null)).toBe(false);
    expect(historyLive(undefined)).toBe(false);
    expect(historyOf({} as Pick<StateSnapshot, 'history'>)).toEqual({
      live: false,
      readerChanges: 0,
      started: false,
    });
  });
});

describe('the chronicle’s own fact (BOOK-56)', () => {
  it('exists from the book’s first record, before any reader change', () => {
    // A begun book: one record in the log, no reader change yet.
    expect(historyStarted(pick({ live: false, readerChanges: 0, started: true }))).toBe(true);
    expect(historyLive(pick({ live: false, readerChanges: 0, started: true }))).toBe(false);
    // A reader change starts it too, so the two never disagree.
    expect(historyStarted(pick({ live: true, readerChanges: 2, started: true }))).toBe(true);
  });

  it('is off on an empty log, and on for a live book whose server never sent the field', () => {
    expect(historyStarted(pick({ live: false, readerChanges: 0, started: false }))).toBe(false);
    expect(historyStarted(null)).toBe(false);
    expect(historyStarted(undefined)).toBe(false);
    // An older payload has no `started` and no reader change: nothing began, nothing is shown.
    expect(historyStarted({ history: { live: false, readerChanges: 0 } as HistoryStateDto })).toBe(false);
    // …but a reader change implies the book began, so `live` stands for the missing field: the
    // chronicle must not vanish on a payload that predates it while the rest of the page keeps
    // rendering the past it narrates.
    expect(historyStarted({ history: { live: true, readerChanges: 1 } as HistoryStateDto })).toBe(true);
  });
});
