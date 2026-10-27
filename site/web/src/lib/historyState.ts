import type { HistoryStateDto, StateSnapshot } from '@book/shared';

/**
 * BOOK-56 — the single reader of `state.history`.
 *
 * The server derives one fact from the log (`changes.source_comment IS NOT NULL`) and
 * publishes it in the state DTO. This module is the only place in the SPA that reads it:
 * every history surface receives the boolean from `App`, so no component recounts the log,
 * no CSS hides a block, and no environment flag can disagree with the book.
 */
export function historyOf(state: Pick<StateSnapshot, 'history'> | null | undefined): HistoryStateDto {
  return state?.history ?? { live: false, readerChanges: 0 };
}

export function historyLive(state: Pick<StateSnapshot, 'history'> | null | undefined): boolean {
  return historyOf(state).live;
}
