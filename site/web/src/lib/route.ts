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
