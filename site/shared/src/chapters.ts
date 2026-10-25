/**
 * Chapter arithmetic for the 67-chapter book.
 *
 * The book is written from both ends: a forward lane drafts 1 → 34, a backward lane
 * drafts 67 → 35. `line` is the story line of `manuscript/PLAN.md`:
 * 0 = prologue/finale, 1..7 = the seven narrative lines.
 */

export const TOTAL_CHAPTERS = 67;

/** Last chapter of the forward lane. */
export const FORWARD_LAST = 34;
/** First chapter of the backward lane. */
export const BACKWARD_FIRST = 35;

/** Chapter numbers drafted by the engineer line (F004 allows the phrase only there). */
export const ENGINEER_LINE_CHAPTERS: readonly number[] = [23, 27, 31, 35, 39, 43, 47, 51, 55, 59, 63];

export type Direction = 'forward' | 'backward';

export function isChapterNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_CHAPTERS;
}

export function directionOf(n: number): Direction {
  return n <= FORWARD_LAST ? 'forward' : 'backward';
}

export function lineOf(n: number): number {
  if (n === 1 || n === TOTAL_CHAPTERS) return 0;
  if (n >= 2 && n <= 8) return 1;
  if (n >= 9 && n <= 15) return 2;
  if (n >= 16 && n <= 22) return 3;
  // Part II: strict 4 → 5 → 6 → 7 rotation over chapters 23..66.
  return 4 + ((n - 23) % 4);
}

/** All 67 chapter numbers, ascending. */
export function allChapterNumbers(): number[] {
  return Array.from({ length: TOTAL_CHAPTERS }, (_, i) => i + 1);
}

/** `7` → `07`; chapter numbers are field numbers everywhere in the UI. */
export function chapterLabel(n: number): string {
  return String(n).padStart(2, '0');
}

