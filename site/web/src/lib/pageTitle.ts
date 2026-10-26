import { IMPRINT_AUTHOR } from '@book/shared';

/**
 * The document title (BOOK-DOC-5 §2 as amended by the owner, 2026-10-26): `<title>` follows
 * the live first sheet, from the same front DTO the cover reads — there is no second copy of
 * the book's name in the build. The static fallback in `index.html` is exactly
 * `documentTitle(null)`, so the tab is never wrong before the first paint.
 *
 * The cover keeps its own fallback («Книга», BOOK-DOC-5 §2); the tab names the book the way
 * a reader would say it.
 */

/** What the tab says while the first sheet has no title line. */
export const UNTITLED = 'Без названия';

export function documentTitle(frontTitle: string | null): string {
  const title = frontTitle === null || frontTitle.trim().length === 0 ? UNTITLED : frontTitle;
  return `${title} — ${IMPRINT_AUTHOR}`;
}
