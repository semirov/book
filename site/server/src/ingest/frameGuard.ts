/**
 * BOOK-137 — the frame is the one text a file may not move.
 *
 * The check is character-exact: ch01 must open with the canon sentence and ch42 must close
 * with it. It compares with `startsWith`/`endsWith` and **no** whitespace collapsing — a
 * reader's filing may be examined, the sentence's letters may not move by a hair. The blank
 * line that separates a title line from the prose is a line break, not text, so it is
 * skipped; inner whitespace never is.
 *
 * One helper, two choke points. `engine/write.ts` refuses a **landing** (`FRAME_CHANGED`), and
 * `ingest/applyChapter.ts` refuses to **publish** at all. The second is the one that matters
 * for the reader: the engine writes the file and the watcher reads it about a second later, so
 * a landing that answers late cannot take back a revision the site already serves.
 */

import { frameSentenceOf, parseChapterTitle } from '@book/shared';

/** The file's frame is the book's frame, character for character (true for a chapter with none). */
export function frameIntact(n: number, raw: string): boolean {
  const expected = frameSentenceOf(n);
  if (expected === null) return true;
  const body = parseChapterTitle(n, raw).body;
  return n === 1
    ? body.replace(/^\n+/u, '').startsWith(expected)
    : body.replace(/\n+$/u, '').endsWith(expected);
}
