/**
 * BOOK-DOC-43 §4 — how long a wait must last before it is shown (BOOK-66).
 *
 * Two thresholds and no timer: the numbers live here so the hook, the tests and the copy
 * read the same ones. Below 150 ms a placeholder flashes and reads as a glitch, and the
 * common case — a same-origin JSON answer in 20–60 ms — shows nothing at all. Past 2 000 ms
 * the reader stops believing the page, and one plain sentence is cheaper than a second shape.
 */
export const SHOW_AFTER_MS = 150;
export const SLOW_AFTER_MS = 2_000;

/** `quiet` prints nothing; `skeleton` the form; `slow` the one-sentence explanation. */
export type PendingStage = 'quiet' | 'skeleton' | 'slow';

/** The stage a wait of `elapsedMs` has reached. Pure: no clock, no DOM. */
export function pendingStage(elapsedMs: number): PendingStage {
  if (elapsedMs >= SLOW_AFTER_MS) return 'slow';
  if (elapsedMs >= SHOW_AFTER_MS) return 'skeleton';
  return 'quiet';
}
