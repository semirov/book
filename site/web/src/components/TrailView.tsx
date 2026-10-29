import type { CatalogEntry, LiveFiling, LivePass, StateSnapshot, FilingUpdatePayload, ViewerDto } from '@book/shared';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import type { ChapterLoader } from '../lib/place.ts';
import { Colophon } from './Colophon.tsx';
import type { HeadEngine, HeadLane } from '../lib/headStatus.ts';
import { Header } from './Header.tsx';
import { TrailPage } from './TrailPage.tsx';

/**
 * BOOK-207 — the trail's mode of the same page: the head, «ваш след», the colophon.
 *
 * It is not a second application: the head is the book's own running head, the page is the
 * book's column, and the footer is the book's footer. `App` decides the mode (`#след`); this
 * file is its one mount expression, kept out of `App`'s line budget.
 */
export function TrailView({
  state,
  ribbon,
  catalog,
  markers,
  onOpenChange,
  live,
  passes,
  engine,
  lane,
  appliedAt,
  closedAt,
  reading,
  viewer,
  filings,
  filingUpdates,
  imprint,
  donateUrl,
  exportBytes,
  loadChapter,
}: {
  state: StateSnapshot;
  ribbon: Ribbon | null;
  catalog: readonly CatalogEntry[];
  markers: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
  live: boolean;
  passes?: readonly LivePass[];
  engine?: HeadEngine;
  /** BOOK-220 M2 — the lane's day bound, printed beside the head's word. */
  lane?: HeadLane;
  appliedAt?: number | null;
  closedAt?: number | null;
  /** The viewer's own filings from `hello.live.filings` / `filing:update` (no mount-only fetch). */
  filings?: readonly LiveFiling[];
  filingUpdates?: Readonly<Record<string, FilingUpdatePayload>>;
  reading: { n: number | null; page: number | null };
  viewer: ViewerDto;
  imprint: { author: string; copyright: string };
  donateUrl: string | null;
  exportBytes: number | null;
  loadChapter?: ChapterLoader;
}) {
  return (
    <>
      <Header
        state={state}
        ribbon={ribbon}
        catalog={catalog}
        markers={markers}
        onOpenChange={onOpenChange}
        live={live}
        passes={passes}
        engine={engine}
        lane={lane}
        appliedAt={appliedAt}
        closedAt={closedAt}
        reading={reading}
      />
      <TrailPage
        viewer={viewer}
        filings={filings}
        updates={filingUpdates}
        {...(loadChapter === undefined ? {} : { onLoadChapter: loadChapter })}
      />
      <Colophon state={state} imprint={imprint} viewer={viewer} donateUrl={donateUrl} exportBytes={exportBytes} />
    </>
  );
}
