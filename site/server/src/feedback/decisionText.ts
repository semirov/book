/**
 * BOOK-158 — the sentence a reader is owed when a decision line carries a handle instead of
 * words, or nothing readable at all.
 *
 * It lives apart from `feedback/decisions.ts` because that file is at its arch bound; the tailer
 * and the tests read it from one place.
 */

import { holdsInternalCode, readerReason } from '@book/shared';

/** The sentence a reader is owed when a decision line carries a handle instead of words. */
export const DECISION_FALLBACK = 'вне рамок: замечание не про текст этой главы';

/**
 * The refusal the reader reads is a sentence, never an engine's handle. A line whose reason is
 * `PROVIDER_SHAPE`/`INTENT_SHAPE`, or nothing readable at all, is refused with the book's own
 * line — the code stays in the log, where an operator can look it up.
 */
export function publicDecisionReason(reason: string): string {
  if (holdsInternalCode(reason)) return DECISION_FALLBACK;
  return readerReason(reason)?.slice(0, 200) ?? DECISION_FALLBACK;
}
