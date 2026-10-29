import { formatShare, type MyTraceDto } from '@book/shared';

/**
 * The reader's own trace, in one sentence (BOOK-DOC-4, BOOK-207).
 *
 * It left the end matter for its own page (`#след`): the sentence says how many chapter
 * revisions the reader's surviving characters have lived through and what share of the text is
 * currently theirs, in the same language the authors list speaks. A reader with no trace gets
 * the truthful zero line — never a curve drawn from a number the system did not measure.
 */

/** Russian plural for «ревизия»: 1 ревизию · 2 ревизии · 5 ревизий. */
export function revisionsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ревизию';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'ревизии';
  return 'ревизий';
}

/** The one sentence the reader sees about their own trace. */
export function traceLine(trace: MyTraceDto): string {
  return `пережила ${trace.survivedRevisions} ${revisionsWord(trace.survivedRevisions)}, сейчас ${formatShare(trace.share)}`;
}
