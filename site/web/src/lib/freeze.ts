import { TOTAL_CHAPTERS, type CatalogEntry } from '@book/shared';

/**
 * BOOK-33 — a frozen chapter is frozen by **identity**, not by whether it currently holds a
 * frame-only file.
 *
 * ch01 and ch67 are the book's frame: the server refuses `FROZEN_FRAME` on both, so the page
 * must not offer a form on them either. A basis slot is the usual shape (`entry.basis`), but
 * the CHAPTER_1 that the writer produced in BOOK-32 is a *written* ch01 — the frame on line 1
 * and prose under it — and keying the freeze on `basis` alone left a live form on a chapter
 * the server would refuse. One predicate, used by the article and the strip alike.
 */
export function isFrozenChapter(entry: Pick<CatalogEntry, 'n' | 'basis'>): boolean {
  return entry.basis || entry.n === 1 || entry.n === TOTAL_CHAPTERS;
}

/** The frozen strip says why: the frame, or the page 2 basis (§2.6). */
export function frozenReasonOf(entry: Pick<CatalogEntry, 'n' | 'basis'>): 'frame' | 'basis' {
  return entry.n === 1 || entry.n === TOTAL_CHAPTERS ? 'frame' : 'basis';
}
