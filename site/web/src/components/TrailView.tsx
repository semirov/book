import type { CatalogEntry, LiveFiling, StateSnapshot, FilingUpdatePayload, ViewerDto } from '@book/shared';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import type { ClientState } from '../lib/clientState.ts';
import type { ConnectionState } from '../lib/socketStatus.ts';
import type { ChapterLoader } from '../lib/place.ts';
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
  client,
  connection,
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
  /** BOOK-DOC-84 §11.1 — the page's folded frames: the head's line is derived from them. */
  client?: ClientState | null;
  /** BOOK-DOC-84 §11.1 — the socket's own state, for the head's one connection word. */
  connection?: ConnectionState | null;
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
        client={client}
        connection={connection}
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
