/**
 * The basis sentence a slot shows before (or without) its chapter request (BOOK-6).
 *
 * Chapter 1 opens with the frozen frame and chapter 42 closes with it, and in the owner's
 * empty-book state each of those files *is* that sentence. The catalog says `basis: true` for
 * such a slot — it is not a written chapter — but the reader must see the sentence.
 *
 * **The served block is the text** (BOOK-187 AC3): the server answers `/api/chapters/1` and
 * `/api/chapters/42` from the `book_frame` row, so once the payload is here its paragraph is
 * what prints. The compiled constant (`FRAME_FIRST_SENTENCE`/`FRAME_LAST_SENTENCE`) is only the
 * **offline-shell fallback** — the reserved paragraph a basis slot shows while the request is
 * still on its way (or when the shell is read with no API at all). It is never allowed to
 * override a served sentence: the volume, not the image, is the source.
 */

import { frameSentenceOf, type CatalogEntry, type ChapterDto } from '@book/shared';

/** The loaded chapter as much as this module needs: the blocks and the basis flag. */
export type LoadedBasis = Pick<ChapterDto, 'blocks' | 'basis'> | null;

/**
 * The frozen sentence of a basis-only slot, or null when the slot is empty or written.
 *
 * The payload's paragraph wins when it is there (`basis: true` with blocks); the compiled
 * constant fills the wait before the request settles. `null` means the slot has nothing to
 * print yet, which is what the article's busy/reserved states key on.
 */
export function basisSentenceOf(entry: CatalogEntry, chapter: LoadedBasis = null): string | null {
  if (!entry.basis || entry.written) return null;
  const served = chapter?.basis === true ? chapter.blocks[0]?.text : undefined;
  if (typeof served === 'string' && served.length > 0) return served;
  return frameSentenceOf(entry.n);
}

/**
 * Whether the chapter a slot has loaded still describes that slot.
 *
 * `rev` is the ordering authority (§10.4) — except on a basis projection: a chapter emptied
 * down to its frozen sentence keeps its `rev` (no revision happened, BOOK-6), so the loaded
 * prose would otherwise stay on the page. The basis flag closes that gap.
 */
export function chapterMatchesEntry(
  entry: CatalogEntry,
  chapter: Pick<ChapterDto, 'rev' | 'basis'> | null,
): boolean {
  if (chapter === null) return false;
  return chapter.rev === entry.rev && chapter.basis === entry.basis;
}
