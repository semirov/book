/**
 * BOOK-DOC-84 §10.2 — the engine's class for a failed reading, as one of six words.
 *
 * The page never prints an engine code and never reads a model's sentence: the six classes are
 * the owner's vocabulary for «why the next try waits», and they come from the code the engine
 * wrote on `triage.failed`, not from prose. One place, so `filing:reading` and `live.reading`
 * cannot disagree about the same row.
 */

export const READING_REASONS = [
  'таймаут',
  'обрыв связи',
  'форма ответа',
  'конфликт вердикта',
  'формулировка',
  'сбой вызова',
] as const;

export type ReadingReason = (typeof READING_REASONS)[number];

/** The codes the writer and the engine already report, grouped into the six classes. */
const REASON_OF_CODE: Record<string, ReadingReason> = {
  PROVIDER_TIMEOUT: 'таймаут',
  TIMEOUT: 'таймаут',
  PROVIDER_TRANSPORT: 'обрыв связи',
  TRANSPORT: 'обрыв связи',
  NETWORK: 'обрыв связи',
  PROVIDER_SHAPE: 'форма ответа',
  PROVIDER_REFUSAL: 'форма ответа',
  READING_MALFORMED: 'форма ответа',
  ANSWER_SHAPE: 'форма ответа',
  VERDICT_CONFLICT: 'конфликт вердикта',
  VERDICT_LOCKED: 'конфликт вердикта',
  INTENT_SHAPE: 'формулировка',
  INTENT_INVALID: 'формулировка',
};

/** The six-word class for one code; an unknown code is a failed call, never a silence. */
export function readingReasonOf(code: string | null | undefined): ReadingReason {
  if (code === null || code === undefined) return 'сбой вызова';
  return REASON_OF_CODE[code] ?? 'сбой вызова';
}
