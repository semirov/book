/**
 * The attempt vocabulary (owner's correction, 2026-10-29): «нет, сроков не надо — только конечное
 * количество попыток».
 *
 * A state between «подан» and one of the two answers is bounded by a **count**; a clock may pace a
 * retry or guard a call in flight, and never decides a state. The numbers live here, once, so the
 * ledger, the engine and the page cannot disagree about how many attempts a filing is worth.
 *
 * The **sentences** a reader reads about an attempt — `FAILED_ATTEMPT_LINE`, `ATTEMPT_LINE`,
 * `ENGINE_SILENT_LINE`, `TRIAGE_REFUSED_LINE` — live in `stateWords.ts` with every other reader's
 * word (BOOK-218: one module spells them). This module only counts, and names the count.
 */

/** Six attempts for one read: 1–5 are model calls, the sixth is the engine's coded floor rung. */
export const TRIAGE_MAX_TRIES = 6;

/** Six claims for one change: a lane that could not take it never waits on an hour. */
export const QUEUE_MAX_ATTEMPTS = 6;

/**
 * The one line a filed attempt is owed: its place in the count, never a promise about time.
 * `попытка 4 из 6` is a fact of the record; «ждёт» and «остаётся в очереди» are not.
 */
export function attemptOfLine(n: number, of: number = TRIAGE_MAX_TRIES): string {
  return `попытка ${String(n)} из ${String(of)}`;
}

/** The queue's own end: six counted claims that produced no step, no hour and no queue. */
export function queueAttemptsLine(attempts: number = QUEUE_MAX_ATTEMPTS): string {
  return `заявка не дошла до главы за ${String(attempts)} попыток`;
}
