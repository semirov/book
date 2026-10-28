import type { HistoryStateDto, StateSnapshot } from '@book/shared';

/**
 * BOOK-56 — the single reader of `state.history`.
 *
 * The server derives one fact — the reader changes whose filing is not hidden (BOOK-101) —
 * and publishes it in the state DTO. This module is the only place in the SPA that reads it:
 * every history surface receives the boolean from `App`, so no component recounts the log,
 * no CSS hides a block, and no environment flag can disagree with the book.
 */
export function historyOf(state: Pick<StateSnapshot, 'history'> | null | undefined): HistoryStateDto {
  return state?.history ?? { live: false, readerChanges: 0, started: false };
}

/** `state.history.live` — the book has a past to narrate: readers have changed it. */
export function historyLive(state: Pick<StateSnapshot, 'history'> | null | undefined): boolean {
  return historyOf(state).live;
}

/**
 * `state.history.started` — the log holds its first record, so the chronicle exists from the
 * book's start with one record, «начало книги». Everything else still follows `historyLive`.
 *
 * A reader change implies a begun book — the server derives both facts from the same log — so
 * `live` stands for `started` when the field is missing (an older API, or a rollback under an
 * open tab). Withholding the chronicle there would drop the one surface the ribbon, the DNA,
 * the chain and the discussion already assume, over a field the invariant makes redundant.
 *
 * Absent both is `false`: a server that predates the starting record must not invent a chronicle.
 */
export function historyStarted(state: Pick<StateSnapshot, 'history'> | null | undefined): boolean {
  const history = historyOf(state);
  return history.started === true || history.live === true;
}
