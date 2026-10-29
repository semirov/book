import type { BookCostDto, CatalogEntry, FrontDto, StateSnapshot, ViewerDto } from '@book/shared';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import type { PassRecordSession } from '../lib/usePassRecord.ts';
import { CapacityPlate } from './CapacityPlate.tsx';
import { Colophon } from './Colophon.tsx';
import { ConsentBanner } from './ConsentBanner.tsx';
import { Header } from './Header.tsx';
import { PassRecord } from './PassRecord.tsx';

/**
 * The pass record as a mode of the book page (BOOK-166): the running head, the record and the
 * colophon — the two surfaces the owner asked to keep — and nothing between them. The chronicle
 * is the other mode of the same page and keeps the same two ends.
 *
 * The mode is chosen by the hash alone (`usePassRecord`); a click on the record's own link
 * changes the hash and the book page comes back, so this component owns no navigation.
 */
export type PassRecordPageProps = {
  record: PassRecordSession;
  chrome: {
    state: StateSnapshot;
    front: FrontDto;
    ribbon: Ribbon | null;
    catalog: CatalogEntry[];
    escalation: EscalationMarker[];
    viewer: ViewerDto;
    cost: BookCostDto | null;
    donateUrl: string | null;
    exportBytes: number | null;
    capacity: boolean;
    live: boolean;
  };
  /** The page's change door: the ribbon's marker hands over to the book's record. */
  onOpenChange: (changeId: string) => void;
  onOpenChapter: (n: number) => void;
};

export function PassRecordPage({ record, chrome, onOpenChange, onOpenChapter }: PassRecordPageProps) {
  return (
    <>
      <Header
        state={chrome.state}
        ribbon={chrome.ribbon}
        catalog={chrome.catalog}
        markers={chrome.escalation}
        onOpenChange={onOpenChange}
        live={chrome.live}
      />
      <ConsentBanner />
      <PassRecord key={record.hash ?? 'record'} state={record} onOpenChapter={onOpenChapter} />
      <Colophon
        state={chrome.state}
        imprint={chrome.front.imprint}
        viewer={chrome.viewer}
        cost={chrome.cost}
        donateUrl={chrome.donateUrl}
        exportBytes={chrome.exportBytes}
      />
      <CapacityPlate active={chrome.capacity} />
    </>
  );
}
