/**
 * BOOK-89, D2/D3 — the reader's running folio: one leaf, one number, and none of it stored.
 *
 * Presentational (BOOK-104): the page is resolved once, in the header's `useReading`, so the
 * chapter the head names and the number in the margin are one commit of one model. A flip
 * re-renders the head's chapter slot and this `<span>` — never a paragraph.
 *
 * The element is out of the flow (`position: fixed`, `pointer-events: none`), so it can change
 * a hundred times without moving a single line of prose. It renders nothing at all where no
 * page exists — the cover, page 2 and the contents — and the visible numeral is the only
 * content: a scroll-driven number must not be announced, so the leaf is `aria-hidden` and the
 * TOC carries the same digits as text (D5).
 *
 * `data-page` is the projected value, for the DOM tests; the page itself is never stored.
 */
export function PageNumber({ page }: { page: number | null }) {
  if (page === null) return null;
  return (
    <span className="folio" data-page={page} aria-hidden="true">
      {page}
    </span>
  );
}
