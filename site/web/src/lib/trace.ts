import { formatShare, type MyTraceDto } from '@book/shared';

import { formatChars, formatDayMonth, plural } from './format.ts';

/**
 * The reader's own trace, in one sentence (BOOK-DOC-4, BOOK-207; BOOK-221).
 *
 * The sentence used to name our machinery — «пережила 12 ревизий, сейчас 0,4 %» — and neither
 * the verb nor the number said what it measured. It now says what a person can check: since
 * which measured day their words are in the book, how many times the chapters have been
 * rewritten since, and what the share is a share **of** — the book's text and its characters.
 * The zero is its own sentence: a reader with nothing of theirs in the book is never told
 * «0,0 %», and a share is never drawn from a day the system did not measure.
 */

/** The one sentence the reader sees about their own trace. */
export function traceLine(trace: MyTraceDto): string {
  // The truthful zero line: no share is printed at all, because there is nothing to share.
  if (trace.share <= 0) return 'ваших слов в книге сейчас нет';

  // The percent always names its whole: the book's text, and the characters behind it.
  const now = `сейчас это ${formatShare(trace.share)} текста книги — ${formatChars(trace.chars)}`;
  // The first measured day the reader's words were **in** the book: `measureContributions` writes
  // a 0-character point for an identity that only queued a change, and that day says nothing about
  // a surviving sentence. No point with characters → no day to name.
  const day = trace.series.find((point) => point.chars > 0)?.day;
  const opening = day === undefined ? 'ваши слова в книге' : `ваши слова в книге с ${formatDayMonth(day)}`;

  // Nothing of theirs has been rewritten: the words are there and have survived, and «0 ревизий»
  // is a machine count, not a fact a reader reads.
  if (trace.survivedRevisions <= 0) return `${opening}: их ещё не переписывали. ${now}.`;

  const rewrites = trace.survivedRevisions;
  const since = day === undefined ? 'главы правили' : 'главы с тех пор правили';
  return `${opening}: ${since} ${String(rewrites)} ${plural(rewrites, 'раз', 'раза', 'раз')}, а слова остались. ${now}.`;
}
