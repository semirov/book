/**
 * The full hall (BOOK-75): what the reader is told, and how often the browser knocks again.
 *
 * The reading itself is REST and is never gated by the socket (AC2), so a full hub is not a
 * dead page: the prose keeps loading underneath and the strip at the foot of the page holds
 * the one fact. A seat frees without a reload, so the socket reconnects on its own (AC3) —
 * there is no button, because a button invites a reader to hammer a closed door.
 *
 * The cadence is deliberately slow and never stops. Every waiting reader is a poll against
 * the hub, and the hub's refusal path builds nothing (no connection record, no `hello`), so a
 * 20 s knock costs a close frame and nothing else. The delay grows gently: a first wait is
 * 20 s, a second 30 s, and it stays there.
 */

/**
 * BOOK-218 — the plate's sentence lives in `@book/shared`'s `stateWords.ts`: the reader waits for
 * a seat, and the word «очередь» is not the book's.
 */
export { CAPACITY_PLATE } from '@book/shared';
export const CAPACITY_STATE = 'Чтение идёт. Подключится само, когда освободится место.';
export const CAPACITY_RETRY_MS = 20_000;

/** The grown base: 20 s, then 30 s, and no further growth — the wait is a queue, not a retry storm. */
const CAPACITY_MAX_MS = 30_000;

/**
 * 20 s ±20 %, doubling the base once and capping it at 30 s: 16–24 s on the first knock,
 * 24–36 s from the second on. Slow on purpose (see above), bounded so a freed seat is
 * still noticed within half a minute.
 */
export function capacityDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(0, Math.trunc(attempt)), 2);
  const base = Math.min(CAPACITY_MAX_MS, CAPACITY_RETRY_MS * 2 ** exponent);
  return Math.round(base * (0.8 + random() * 0.4));
}
