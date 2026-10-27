import type { ChapterLength } from '@book/shared';

import { useRunningPage } from '../lib/pageTrack.ts';

/**
 * BOOK-89, D2/D3 — the reader's running folio: one leaf, two slots, no number stored.
 *
 * The page is derived from the scroll by `useRunningPage`, inside this component — so a flip
 * re-renders one `<span>` and nothing else: not the header, not the ribbon, never a
 * paragraph. The element is out of the flow (`position: fixed`, `pointer-events: none`), so
 * it can change a hundred times without moving a single line of prose.
 *
 * It renders nothing at all where no page exists — the cover, page 2 and the contents — and
 * the visible numeral is the only content: a scroll-driven number must not be announced, so
 * the leaf is `aria-hidden` and the TOC carries the same digits as text (D5).
 *
 * `data-page` is the measured value, for the DOM tests; the page itself is never stored.
 */
export function PageNumber({ catalog }: { catalog: readonly ChapterLength[] }) {
  const page = useRunningPage(catalog);
  if (page === null) return null;
  return (
    <span className="folio" data-page={page} aria-hidden="true">
      {page}
    </span>
  );
}
