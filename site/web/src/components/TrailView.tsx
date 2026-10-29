import type { CatalogEntry, StateSnapshot, ViewerDto } from '@book/shared';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import type { HeadSocket } from '../lib/headStatus.ts';
import type { ChapterLoader } from '../lib/place.ts';
import type { Stages } from '../lib/useStages.ts';
import { Colophon } from './Colophon.tsx';
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
  stages,
  socket,
  reading,
  viewer,
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
  stages: Stages;
  socket?: HeadSocket;
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
        stages={stages}
        socket={socket}
        reading={reading}
      />
      <TrailPage viewer={viewer} {...(loadChapter === undefined ? {} : { onLoadChapter: loadChapter })} />
      <Colophon state={state} imprint={imprint} viewer={viewer} donateUrl={donateUrl} exportBytes={exportBytes} />
    </>
  );
}
