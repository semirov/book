import type { FrontDto, StateSnapshot } from '@book/shared';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import type { TitleMotion } from '../lib/titleChange.ts';
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
 * response and no manuscript string ever carries those three characters.
 *
 * A book's opening has no status bar — the chip and «книга · хроника» arrive when the
 * inventory starts, below the annotation, where the sticky header covers the TOC and the
 * chapters only.
 */
export function Opening({
  front,
  state,
  ribbon,
  escalation,
  onOpenChange,
  view,
  onViewChange,
  motion,
}: {
  front: FrontDto;
  state: StateSnapshot;
  ribbon: Ribbon | null;
  escalation: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
  view: BookView;
  onViewChange: (view: BookView) => void;
  motion?: TitleMotion;
}) {
  return (
    <>
      <TitleSheet front={front} motion={motion} />
      <HowTheBookIsMade />
      <hr className="front-rule" />
      <Annotation front={front} />
      <Header state={state} ribbon={ribbon} markers={escalation} onOpenChange={onOpenChange} />
      <ViewSwitch view={view} onChange={onViewChange} />
    </>
  );
}
