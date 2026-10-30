import type { ChangeDto } from '@book/shared';
import type { ReactNode } from 'react';

import { countOf, type HistoryRow, type InterventionRow, type RowWindow } from '../lib/recState.ts';
import { RecordChangeSection } from './ChangeSection.tsx';
import { RowsList, SectionHeader } from './RecordParts.tsx';

/** The record's four sections; one body is open at a time. */
export type RecordSection = 'interventions' | 'change' | 'history';

/**
 * BOOK-220 §11.3 — the record's lists, drawn in one place.
 *
 * `замечания` holds the sentence's **other** filings (the filing the record is open for lives in
 * the head), and a section with nothing is not a section: no header, no count of zero, no empty
 * list. `история` prints rows whose every line answers when / who / what; `правка` is the change
 * the record was opened for, when there is one.
 */
export function RecordSections({
  rows,
  windowed,
  historyList,
  historyWindowed,
  lifted,
  section,
  history,
  changeId,
  changeRead,
  before,
  after,
  onToggle,
  onLift,
  onFold,
  onOpenFiling,
}: {
  rows: readonly InterventionRow[];
  windowed: RowWindow<InterventionRow>;
  historyList: readonly HistoryRow[];
  historyWindowed: RowWindow<HistoryRow>;
  lifted: boolean;
  section: RecordSection | null;
  history: boolean;
  changeId: string | null;
  changeRead: { change: ChangeDto | null; failed: boolean };
  before: string | null;
  after: string | null;
  onToggle: (next: RecordSection, control: HTMLElement) => void;
  onLift: () => void;
  onFold: () => void;
  onOpenFiling: (row: InterventionRow) => void;
}): ReactNode {
  return (
    <div className="rec-sections">
      {rows.length > 0 ? (
        <>
          <SectionHeader
            label="замечания"
            count={countOf(rows)}
            open={section === 'interventions'}
            onPress={(control) => onToggle('interventions', control)}
          />
          {section === 'interventions' ? (
            <RowsList
              rows={windowed}
              lifted={lifted}
              onLift={onLift}
              onFold={onFold}
              onOpen={onOpenFiling}
            />
          ) : null}
        </>
      ) : null}
      {changeId === null ? null : (
        <RecordChangeSection
          open={section === 'change'}
          read={changeRead}
          before={before}
          after={after}
          onPress={(control) => onToggle('change', control)}
        />
      )}
      {history && historyList.length > 0 ? (
        <>
          <SectionHeader
            label="история"
            count={countOf(historyList)}
            open={section === 'history'}
            onPress={(control) => onToggle('history', control)}
          />
          {section === 'history' ? (
            <RowsList rows={historyWindowed} lifted={lifted} onLift={onLift} onFold={onFold} history />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
