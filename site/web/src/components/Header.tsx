import type { CatalogEntry, StateSnapshot } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import { useStickyOffsets } from '../lib/headerOffset.ts';
import { useReading } from '../lib/pageTrack.ts';
import { CascadeRibbon } from './CascadeRibbon.tsx';
import { PageNumber } from './PageNumber.tsx';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The chapter's own title, or null. A basis slot's only text is its frozen frame — prose, not
 * a title — and an untitled chapter has none: the head must never lift a word from the slot.
 */
function titleOf(catalog: readonly CatalogEntry[], n: number | null): string | null {
  if (n === null) return null;
  const entry = catalog.find((item) => item.n === n);
  if (entry === undefined || entry.basis) return null;
  const title = entry.title?.trim() ?? '';
  return title.length > 0 ? title : null;
}

/**
 * The running head (DESIGN §5.3, §7.1–7.2; BOOK-DOC-5 §5). The strip sits below the
 * annotation, so a book's opening has no status bar.
 *
 * **The reading surface prints the book, not the product.** The brand is the book's own
 * title — never a chapter count; the chapter slot is the number and a real title — never a
 * state word, a status, an explanation or a sentence lifted from the prose. State belongs to
 * panels, the chronicle and the end matter: the chip that used to stand here («пишется
 * глава N», «правка приостановлена», «последняя запись · 25.10», «глав ещё нет») is gone.
 *
 * BOOK-104: the head names the chapter at the reading line and the folio prints its page —
 * one `useReading`, one model, both from the same commit.
 */
export function Header({
  state,
  ribbon,
  catalog,
  markers: escalation,
  onOpenChange,
  live,
}: {
  state: StateSnapshot;
  ribbon: Ribbon | null;
  catalog: readonly CatalogEntry[];
  markers: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
  /** BOOK-56: the ribbon is history; off means it is not on the page at all. */
  live: boolean;
}) {
  // BOOK-104: the chapter the reader is in and the page it opens — one resolution, two slots.
  const { n, page } = useReading(catalog);
  const title = titleOf(catalog, n);
  const slot = useRef<HTMLSpanElement>(null);
  /** The sticky head's own box: the anchor contract measures it (BOOK-155, owner 2026-10-28). */
  const head = useRef<HTMLElement>(null);
  useStickyOffsets(head);
  const [clipped, setClipped] = useState<string | null>(null);
  const slotKey = n === null ? '' : `${n}:${title ?? ''}`;
  // A title that does not fit the head is dropped for the number alone, never ellipsized.
  const showTitle = title !== null && clipped !== slotKey;
  const label = showTitle ? title : null;
  useMeasuredLayout(() => {
    if (!showTitle) return;
    const node = slot.current;
    const head = node?.closest<HTMLElement>('.top-in') ?? null;
    if (node === null || head === null) return;
    if (head.scrollWidth > head.clientWidth + 1) setClipped(slotKey);
  }, [slotKey, showTitle, label]);
  // A wider head may hold the title again; the next pass decides with the same measurement.
  useEffect(() => {
    const onResize = (): void => setClipped(null);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <header className="top" ref={head}>
      <div className="page sheet top-in">
        <div className="top-row">
          {/* The book's own title and nothing else: no «Книга ·», no count (BOOK-112). */}
          <span className="brand">{state.front.title}</span>
          {/* The chapter slot is reserved (18ch) so naming the chapter never moves the line;
              it sits with the brand, and the folio keeps the row's right end. */}
          <span className="top-chapter" data-n={n ?? undefined} ref={slot}>
            {n === null ? null : (
              <>
                <span className="top-chapter-n">{n}</span>
                {label === null ? null : <span className="top-chapter-w">{label}</span>}
              </>
            )}
          </span>
          {/* D2: below 768 the folio is the last item of this row; above it, fixed in the
              margin and out of this row's flow (live.css). */}
          <PageNumber page={page} />
        </div>
      </div>
      <CascadeRibbon ribbon={ribbon} markers={escalation} onOpenChange={onOpenChange} live={live} />
    </header>
  );
}
