import { frameSentenceOf } from '@book/shared';

/**
 * BOOK-137 — the frame is **two sentences**, not two chapters.
 *
 * ch01 opens with the canon sentence and ch67 closes with it (`book.ts`, F029), and those
 * sentences are the only text the owner fixed. Everything else in a written chapter is ordinary
 * prose: a reader taps it, the strip opens on that word, «вмешаться» works and the filing goes
 * to the auditor. The old predicate froze whole chapters by identity (`n === 1 || n === 67`),
 * which is why the owner could not intervene anywhere in chapter one.
 *
 * So the page asks two questions and neither of them is a chapter number:
 *
 * - `isFrameParagraph` — this paragraph **is** the basis slot (its whole text is the sentence);
 * - `classifyFrame` (`@book/shared`) — this filing **touches** the sentence (`touched`), sits
 *   in its paragraph (`adjacent`) or is ordinary prose (`untouched`).
 *
 * The strip's own words follow the mark, never the chapter: «рамка книги · не меняется» is
 * printed only for a `touched` selection.
 */

/** The canon sentence of a chapter, or null when the chapter has none. */
export function frameTextOf(n: number): string | null {
  return frameSentenceOf(n);
}

/** Whitespace is not text: a rewrapped sentence and the canon one compare as one string. */
function flat(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * The paragraph *is* the frame sentence — the basis slot ch01/ch67 hold before their prose
 * exists. Only such a paragraph has no «вмешаться» rail of its own; the sentence stays
 * touchable, and a filing on it becomes paperwork.
 */
export function isFrameParagraph(n: number, text: string): boolean {
  const frame = frameTextOf(n);
  if (frame === null) return false;
  return flat(text) === flat(frame);
}
