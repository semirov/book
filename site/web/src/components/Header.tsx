import { TOTAL_CHAPTERS, type CatalogEntry, type StateSnapshot } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import { engineChipCopy, chipCopy } from '../lib/format.ts';
import { useReading } from '../lib/pageTrack.ts';
import { liveChapter, revisingChapter } from '../lib/spine.ts';
import { CascadeRibbon } from './CascadeRibbon.tsx';
import { PageNumber } from './PageNumber.tsx';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The two words the slot prints: its title line, and the word in its state slot. */
function chapterCopyOf(article: Element | null): { title: string | null; word: string | null } {
  const title = article?.querySelector('.ch-title')?.textContent?.trim() ?? '';
  const word = article?.querySelector('.premise-label')?.textContent?.trim() ?? '';
  return { title: title.length > 0 ? title : null, word: word.length > 0 ? word : null };
}

/** The named slot's words, tied to the chapter they were read from. */
type ChapterCopy = { n: number; title: string | null; word: string | null };

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
 *
 * BOOK-104: the head names the chapter at the reading line and the folio prints its page —
 * one `useReading`, one model, both from the same commit. The chapter is no longer observed:
 * the reader's line is where `--offset-top` ends, so the head follows an anchor exactly.
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
  const [copy, setCopy] = useState<ChapterCopy | null>(null);
  const slot = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState<string | null>(null);
  /**
   * The word is not a second table: it is what the named slot itself prints. The catalogue
   * cannot stand in for it — an empty chapter's word may be a premise's own state, which
   * lives in the reader's filings — so the slot stays the source, read before paint for the
   * chapter `n` and watched while it is that chapter (a premise arriving renames it).
   */
  useMeasuredLayout(() => {
    if (n === null || typeof document === 'undefined') {
      setCopy(null);
      return undefined;
    }
    // A catalogue move re-reads the slot too: a revision can re-mount it under the same
    // number, and the observer below would then be watching a detached node.
    const article = document.querySelector<HTMLElement>(`article[data-n="${n}"]`);
    const sync = (): void =>
      setCopy((previous) => {
        const next: ChapterCopy = { n, ...chapterCopyOf(article) };
        const same =
          previous !== null && previous.n === next.n && previous.title === next.title && previous.word === next.word;
        return same ? previous : next;
      });
    sync();
    if (article === null) return undefined;
    const mutations = new MutationObserver(sync);
    mutations.observe(article, { childList: true, subtree: true, characterData: true });
    return () => mutations.disconnect();
  }, [n, catalog]);
  const named = copy === null || copy.n !== n ? null : copy;
  const slotKey = n === null ? '' : `${n}:${named?.title ?? ''}`;
  // A title that does not fit the head is dropped for the state word, never ellipsized.
  const showTitle = named?.title !== null && named?.title !== undefined && clipped !== slotKey;
  const label = n === null ? null : showTitle ? named?.title ?? null : named?.word ?? null;
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
        <div className="top-row">
          <span className={chip.live ? 'live' : 'live idle'}>
            <i className="dot" aria-hidden="true" />
            {chip.text}
          </span>
        </div>
      </div>
      <CascadeRibbon ribbon={ribbon} markers={escalation} onOpenChange={onOpenChange} live={live} />
    </header>
  );
}
