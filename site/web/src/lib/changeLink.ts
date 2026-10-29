import { CHANGE_QUERY_PARAM } from '@book/shared';

/**
 * `?change=<id>` — the one address a reader's change has.
 *
 * The id is bounded and charset-limited here, exactly as the old fragment parser bounded it: a
 * query is data from the address bar, and a change id is a short opaque key. Anything else is
 * not a change link, and the page must not fetch or scroll for it.
 */
export function changeIdFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get(CHANGE_QUERY_PARAM);
  if (raw === null || raw.length === 0 || raw.length > 80) return null;
  return /^[A-Za-z0-9_-]+$/u.test(raw) ? raw : null;
}

/**
 * The address without `?change=`: called when the reader closes the record, so a reload does
 * not reopen a section the reader put away. Other parameters and the fragment are untouched.
 */
export function clearChangeParam(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(CHANGE_QUERY_PARAM)) return;
  url.searchParams.delete(CHANGE_QUERY_PARAM);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
