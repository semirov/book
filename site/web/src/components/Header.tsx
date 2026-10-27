import { TOTAL_CHAPTERS, type CatalogEntry, type StateSnapshot } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import { engineChipCopy, chipCopy } from '../lib/format.ts';
import { liveChapter, revisingChapter } from '../lib/spine.ts';
import { useCurrentChapter } from '../lib/useCurrentChapter.ts';
import { CascadeRibbon } from './CascadeRibbon.tsx';
import { PageNumber } from './PageNumber.tsx';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Two label rows and the cascade ribbon (DESIGN §5.3, §7.1–7.2; BOOK-DOC-5 §5). The strip
 * sits below the annotation, so a book's opening has no status bar. The chip says
 * "пишется глава N" only when a lane lease exists; without the engine it falls back to what
 * the files prove («последняя запись · 25.10», «12 глав с текстом»), never to a fake cursor
 * nor to a recency clock (§7.3). The spine and the 0/67 counter are gone: a ribbon with two
 * carets where nobody writes is fake liveness.
 *
 * BOOK-70 removed the second chip of the bottom row — «замечания» had already moved to the
 * register, where its noun is the number's own (Discussion). One row, one chip.
 */
export function Header({
  state,
  ribbon,
  catalog,
  markers: escalation,
  onOpenChange,
}: {
  state: StateSnapshot;
  ribbon: Ribbon | null;
  catalog: readonly CatalogEntry[];
  markers: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
}) {
  // BOOK-90 B: the chapter the reader is in — number, then the title or the slot's own word.
  const chapter = useCurrentChapter();
  const slot = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState<string | null>(null);
  const slotKey = chapter === null ? '' : `${chapter.n}:${chapter.title ?? ''}`;
  // A title that does not fit the head is dropped for the state word, never ellipsized.
  const showTitle = chapter?.title !== null && chapter?.title !== undefined && clipped !== slotKey;
  const label = chapter === null ? null : showTitle ? chapter.title : chapter.word;
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
  const current = liveChapter(state);
  const revising = revisingChapter(state);
  const engineChip = engineChipCopy(state.engine.status);
  const chip =
    engineChip ??
    (current !== null
      ? { text: `пишется глава ${current.n}`, live: true }
      : revising !== null
        ? { text: `правится глава ${revising}`, live: true }
        : chipCopy({ count: state.chapters.count, lastChangeAt: state.activity.lastFileChangeAt }));

  return (
    <header className="top">
      <div className="page sheet top-in">
        <div className="top-row">
          <span className="brand">Книга · {TOTAL_CHAPTERS} глав</span>
          {/* The chapter slot is reserved (18ch) so naming the chapter never moves the line;
              it sits with the brand, and the folio keeps the row's right end. */}
          <span className="top-chapter" data-n={chapter?.n ?? undefined} ref={slot}>
            {chapter === null ? null : (
              <>
                <span className="top-chapter-n">{chapter.n}</span>
                {label === null ? null : <span className="top-chapter-w">{label}</span>}
              </>
            )}
          </span>
          {/* D2: below 768 the folio is the last item of this row; above it, fixed in the
              margin and out of this row's flow (live.css). */}
          <PageNumber catalog={catalog} />
        </div>
        <div className="top-row">
          <span className={chip.live ? 'live' : 'live idle'}>
            <i className="dot" aria-hidden="true" />
            {chip.text}
          </span>
        </div>
      </div>
      <CascadeRibbon ribbon={ribbon} markers={escalation} onOpenChange={onOpenChange} />
    </header>
  );
}
