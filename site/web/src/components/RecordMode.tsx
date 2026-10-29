import type { CatalogEntry, FrontDto, StateSnapshot, ViewerDto } from '@book/shared';
import type { ReactElement } from 'react';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import type { ChapterLoader } from '../lib/place.ts';
import type { Stages } from '../lib/useStages.ts';
import type { SocketStatus } from '../lib/ws.ts';
import type { BookView } from './ViewSwitch.tsx';
import { CapacityPlate } from './CapacityPlate.tsx';
import { Chronicle } from './Chronicle.tsx';
import { ConsentBanner } from './ConsentBanner.tsx';
import { TrailView } from './TrailView.tsx';
import { ViewSwitch } from './ViewSwitch.tsx';

/**
 * The record's two early-return modes of the one page (BOOK-166, BOOK-102): «след» — a change's
 * record, opened by `?change=` — and «хроника», the log and the moment it can be read at.
 *
 * They live here rather than in `App` for two reasons. `App` is at its line budget, and the
 * record is a coherent block: a mode has its own head, its own body and its own foot, and it
 * replaces the book page instead of standing inside it. The second reason is the age gate
 * (BOOK-225): a chronicle's past chapters are **prose** — read from `/api/history/chapters/:n`,
 * which refuses without the acknowledgement — and a deep-linked record is a way into the same
 * text. So a gated reader has no record mode at all: `recordModeOf` answers `null`, the book
 * page renders, and the gate stands where the chapters would.
 */
export type RecordModeKind = 'trail' | 'chronicle';

/**
 * Which record page this request is, if any — the one predicate `App` and `RecordMode` share, so
 * the early return and the page it renders can never disagree about who is allowed a mode.
 * A gated reader is never one: the gate outranks both `?change=` and «хроника».
 */
export function recordModeOf(input: {
  acknowledged: boolean;
  trail: boolean;
  view: BookView;
  chronicle: boolean;
}): RecordModeKind | null {
  if (!input.acknowledged) return null;
  if (input.trail) return 'trail';
  if (input.view === 'chronicle' && input.chronicle) return 'chronicle';
  return null;
}

export function RecordMode({
  mode,
  view,
  onViewChange,
  state,
  ribbon,
  catalog,
  markers,
  onOpenChange,
  live,
  socket,
  stages,
  reading,
  viewer,
  front,
  historyTick,
  doorLine,
  plate,
  loadChapter,
}: {
  mode: RecordModeKind;
  view: BookView;
  onViewChange: (view: BookView) => void;
  state: StateSnapshot;
  ribbon: Ribbon | null;
  catalog: CatalogEntry[];
  markers: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
  live: boolean;
  /** BOOK-218: the page's connection, so a record page's head says `связи нет` too. */
  socket: SocketStatus;
  stages: Stages;
  reading: { n: number | null; page: number | null };
  viewer: ViewerDto;
  front: FrontDto;
  historyTick: number;
  doorLine: ReactElement | null;
  /** The connection is at capacity, so the plate says so on either mode. */
  plate: boolean;
  loadChapter: ChapterLoader;
}): ReactElement {
  if (mode === 'trail') {
    return (
      <>
        <TrailView
          state={state} ribbon={ribbon} catalog={catalog}
          markers={markers} onOpenChange={onOpenChange}
          live={live} socket={socket} stages={stages} reading={reading} viewer={viewer}
          imprint={front.imprint} donateUrl={front.donateUrl ?? null}
          exportBytes={front.exportBytes ?? null} loadChapter={loadChapter}
        />
        <ConsentBanner />
        <CapacityPlate active={plate} />
        {doorLine}
      </>
    );
  }
  return (
    <>
      {/* The chronicle mode exists only once the record has started (`recordModeOf` grants it on
          `chronicle`), so the switch is always the way back — never a gated fact of its own. */}
      <ViewSwitch view={view} onChange={onViewChange} live={true} />
      <ConsentBanner />
      <Chronicle
        catalog={catalog}
        frontRev={front.rev}
        tick={historyTick}
        onOpenChange={onOpenChange}
        started
        live={live}
        onLoadChapter={loadChapter}
      />
      <CapacityPlate active={plate} />
      {doorLine}
    </>
  );
}
