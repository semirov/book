import type { CatalogEntry, FrontDto, StateSnapshot } from '@book/shared';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import type { HeadSocket } from '../lib/headStatus.ts';
import type { TitleMotion } from '../lib/titleChange.ts';
import type { Stages } from '../lib/useStages.ts';
import { useFrontSequence } from '../useFrontSequence.ts';
import { Annotation } from './Annotation.tsx';
import { Header } from './Header.tsx';
import { HowTheBookIsMade } from './HowTheBookIsMade.tsx';
import { TitleSheet } from './TitleSheet.tsx';
import { ViewSwitch, type BookView } from './ViewSwitch.tsx';

/**
 * The opening screen (BOOK-39, BOOK-DOC-5 §2–§5): the cover, the site's explanation of how the
 * book is made, the rule, page 2, and only then the instrument strip.
 *
 * The rule is deliberate layout, not text: the owner's `***` separates what the site says
 * about the book from the book's own words, and it is an `<hr>` so that no reader, no API
 * response and no manuscript string ever carries those three characters. It sits in one
 * `.page` of its own (BOOK-88): the rule is prose, so it needs the column's box to start on
 * the column's left edge and the measure to end on the prose's right edge.
 *
 * A book's opening has no status bar — the chip and «книга · хроника» arrive when the
 * inventory starts, below the annotation, where the sticky header covers the TOC and the
 * chapters only.
 *
 * BOOK-DOC-49 — this component mounts exactly when the front lands, so `t = 0` of the
 * first-load sequence is its commit: the driver lives here and nowhere in `App`. The typed
 * title's per-frame state deliberately does **not**: it lives in the `h1` (`TitleSheet.tsx`),
 * so a typing frame updates the title and never re-renders this component and page 2 under it.
 * `seq` is false for a page load that owns no sequence (reduced motion, a deep link, a restored
 * scroll), and then not one `data-seq` attribute is written at all.
 */
export function Opening({
  front,
  state,
  ribbon,
  catalog,
  escalation,
  onOpenChange,
  view,
  onViewChange,
  motion,
  live,
  chronicle,
  stages,
  socket,
  reading,
  gated,
}: {
  front: FrontDto;
  state: StateSnapshot;
  ribbon: Ribbon | null;
  catalog: readonly CatalogEntry[];
  escalation: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
  view: BookView;
  onViewChange: (view: BookView) => void;
  motion?: TitleMotion;
  /** BOOK-56: `state.history.live`; off removes the cascade ribbon, which is history. */
  live: boolean;
  /**
   * BOOK-56: `state.history.started` — the chronicle exists, so «книга · хроника» is a way in.
   * Absent falls back to `live`: an older caller knows only that, and a reader change starts
   * the chronicle too.
   */
  chronicle?: boolean;
  /** BOOK-156 #3814: the page's stage log — the running head says the book is being written. */
  stages?: Stages;
  /** BOOK-218: the page's socket status — with no live line the head says `связи нет`. */
  socket?: HeadSocket;
  /** BOOK-104 / BOOK-207: the page's one reading model, resolved in `App`. */
  reading: { n: number | null; page: number | null };
  /**
   * BOOK-225: the age gate stands where the chapters would. The way into the chronicle is a
   * way into the book's record, and its past chapters are text — so the switch waits for the
   * same answer the chapters wait for, and the opening is one screen of book matter.
   */
  gated?: boolean;
}) {
  const stage = useFrontSequence(motion?.token ?? 0);
  const seq = stage !== 'idle';
  const wayIn = chronicle ?? live;
  return (
    <>
      <TitleSheet front={front} motion={motion} seq={seq} running={stage === 'run'} />
      <HowTheBookIsMade seq={seq} />
      {/* BOOK-88: the wrapper gives the rule the column's box to start from; its own `max-width`
          (base.css) ends it on the prose's right edge. `data-seq` stays on the `<hr>`. */}
      <div className="page">
        <hr className="front-rule" data-seq={seq ? 'rule' : undefined} />
      </div>
      <Annotation front={front} seq={seq} />
      <Header
        state={state}
        ribbon={ribbon}
        catalog={catalog}
        markers={escalation}
        onOpenChange={onOpenChange}
        live={live}
        stages={stages}
        socket={socket}
        reading={reading}
      />
      {/* BOOK-225 — a gated page has no second mode: the record's past chapters are prose. */}
      {gated === true ? null : <ViewSwitch view={view} onChange={onViewChange} live={wayIn} />}
    </>
  );
}
