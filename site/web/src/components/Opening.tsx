import type { FrontDto, StateSnapshot } from '@book/shared';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import type { TitleMotion } from '../lib/titleChange.ts';
import { Annotation } from './Annotation.tsx';
import { Header } from './Header.tsx';
import { TitleSheet } from './TitleSheet.tsx';
import { ViewSwitch, type BookView } from './ViewSwitch.tsx';

/**
 * The opening screen (BOOK-DOC-5 §2–§5): the cover, page 2, and only then the instrument
 * strip. A book's opening has no status bar — the chip and «книга · хроника» arrive when
 * the inventory starts, below the annotation, where the sticky header covers the TOC and
 * the chapters only.
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
      <Annotation front={front} />
      <Header state={state} ribbon={ribbon} markers={escalation} onOpenChange={onOpenChange} />
      <ViewSwitch view={view} onChange={onViewChange} />
    </>
  );
}
