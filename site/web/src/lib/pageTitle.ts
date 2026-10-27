import { IMPRINT_AUTHOR } from '@book/shared';

/**
 * The document title (BOOK-DOC-5 §2 as amended by the owner, 2026-10-26): `<title>` follows
 * the live first sheet, from the same front DTO the cover reads — the tab holds no second
 * copy of the book's name and a `front:updated` rename reaches it on its own.
 *
 * The static shell (`index.html`) is the one place allowed to name the printed book, for a
 * reader without JavaScript and for a social card; the running app overwrites it from the
 * DTO. While the first sheet has no title line the tab says what the cover says («Книга»,
 * BOOK-DOC-5 §2) instead of inventing a name.
 */

/** What the tab says while the first sheet has no title line. */
export const FALLBACK_TITLE = 'Книга';

export function documentTitle(frontTitle: string | null): string {
  const title = frontTitle === null || frontTitle.trim().length === 0 ? FALLBACK_TITLE : frontTitle;
  return `${title} — ${IMPRINT_AUTHOR}`;
}

/** The one thing the tab writer needs from a document; a stub is enough for a unit test. */
export interface TitleTarget {
  title: string;
}

/**
 * Write the tab title — or leave it alone. Three states, because a load has three:
 * `undefined` = the state has not arrived yet (the static shell's title stands, so a phone
 * never flashes «Книга» over «Бланк»), `null` = the first sheet genuinely has no title
 * line (the cover's fallback), a string = the live title. The value comes from the same
 * front DTO the cover renders, so a `front:updated` rename reaches the tab on its own.
 */
export function applyDocumentTitle(frontTitle: string | null | undefined, target: TitleTarget): void {
  if (frontTitle === undefined) return;
  target.title = documentTitle(frontTitle);
}
