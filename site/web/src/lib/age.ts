import { ageDayIn } from '@book/shared';

/**
 * BOOK-225 — where the gate stands, read from the device.
 *
 * The **words** of the rating and the gate live in `@book/shared`'s `stateWords.ts` (BOOK-218's
 * one vocabulary, reached through `lib/marginalia.ts`); this module holds the one fact the page
 * has to read for itself, before its first request.
 *
 * `document.cookie` is the page's copy of the same value `POST /api/age` writes, and the reading
 * is the shared one (`ageDayIn`) — so a value the server would refuse can never open the gate
 * here, and a reader who already answered never sees the question again.
 */
export function readAgeAcknowledgement(now: Date = new Date()): string | null {
  return ageDayIn(document.cookie, now);
}
