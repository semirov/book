/**
 * The two static pages that are not the book (audit M5): `/privacy` and `/rules`.
 *
 * They are plain documents — no fetch, no state, no third-party byte — so they are chosen
 * from the path before the app boots: the reader who came for «что здесь собирают» should
 * not wait for the manuscript's catalogue to load to read it. Trailing slashes and an
 * accidental `/privacy.html` are the same page; anything else is the book.
 */

export type StaticPage = 'privacy' | 'rules';

const PATHS: Record<string, StaticPage> = {
  '/privacy': 'privacy',
  '/privacy.html': 'privacy',
  '/rules': 'rules',
  '/rules.html': 'rules',
};

/** Normalise one path segment: `/privacy/` and `/privacy` are the same page. */
export function staticPage(pathname: string): StaticPage | null {
  const trimmed = pathname.replace(/\/+$/u, '');
  return PATHS[trimmed.toLowerCase()] ?? null;
}

/** A same-origin link the composer and the colophon can carry. */
export function staticPageHref(page: StaticPage): string {
  return `/${page}`;
}

/**
 * BOOK-63 — `#ch-12` is the one chapter deep link, and it is the element id the chapter
 * already has. Anything else (`?change=…` is a query, not a hash) is not a
 * chapter link, and the page must not scroll for it.
 */
export function chapterFromHash(hash: string, totalChapters: number): number | null {
  return chapterLinkFromHash(hash, totalChapters)?.chapter ?? null;
}

/** A fragment that names a paragraph as well as its chapter: `#ch-3-b12`. */
export type ChapterLink = {
  chapter: number;
  /** The paragraph's index inside the chapter, or `null` for the chapter's own mouth. */
  blockIndex: number | null;
};

/**
 * BOOK-168 — a place copied from a door can name the paragraph, not only the chapter: `#ch-3`
 * is the chapter's mouth and `#ch-3-b12` is its twelfth block (`placeHref`). The reading surface
 * parses both, so a link carried out of the register lands on the sentence it quotes — with the
 * script off, the browser's own fragment jump does the same on the element id the paragraph has.
 * A number outside the book, a bad index and any other hash are not a link: `null`, no scroll.
 */
export function chapterLinkFromHash(hash: string, totalChapters: number): ChapterLink | null {
  const match = /^#ch-(\d{1,3})(?:-b(\d{1,4}))?$/u.exec(hash);
  if (match === null) return null;
  const chapter = Number(match[1]);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > totalChapters) return null;
  const blockIndex = match[2] === undefined ? null : Number(match[2]);
  return { chapter, blockIndex };
}
