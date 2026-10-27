/**
 * The basis sentence a slot shows before (or without) its chapter request (BOOK-6).
 *
 * Chapter 1 opens with the frozen frame and chapter 67 closes with it, and in the owner's
 * empty-book state each of those files *is* that sentence. The catalog says `basis: true` for
 * such a slot — it is not a written chapter — but the reader must see the sentence, so the
 * client prints it from the one shared constant the validator and the ingest already use
 * (`FRAME_FIRST_SENTENCE`/`FRAME_LAST_SENTENCE`). The request then adds the paragraph's id and
 * revision; it never changes the words.
 */

import { frameSentenceOf, type CatalogEntry, type ChapterDto } from '@book/shared';

/** The frozen sentence of a basis-only slot, or null when the slot is empty or written. */
export function basisSentenceOf(entry: CatalogEntry): string | null {
  if (!entry.basis || entry.written) return null;
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
