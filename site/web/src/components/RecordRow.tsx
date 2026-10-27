import type { HistoryRecordDto } from '@book/shared';

import { recordReason, recordWord } from '../lib/changeStatus.ts';
import { momentText } from '../lib/history.ts';

/**
 * BOOK-65 — one public record entry: **one change, one line**, and one way in.
 *
 * The row carries exactly six facts — the change's number, its date and time, the reader's
 * alias, the place, one outcome word and the button that opens the card. Nothing from the log
 * is printed: no event summary, no event kind, no five-word deed chain, no second «прицел»
 * control. Clicking the row does not move the moment either; the moment moves only through
 * `MomentControl`, so a tap on the entry always means the card.
 *
 * The final wording of the number and the outcome belongs to BOOK-59's copy pass.
 */
export type RecordRowProps = {
  record: HistoryRecordDto;
  onOpenChange: (changeId: string) => void;
};

export function RecordRow({ record, onOpenChange }: RecordRowProps) {
  const word = recordWord(record);
  const reason = recordReason(record);
  // BOOK-7 + BOOK-65: a premise is the chapter's starting point, so its noun is «замысел», not
  // «правка» — but every entry still carries its number: «замысел 9», never a bare noun.
  const number = record.premise ? `замысел ${record.seq}` : `правка ${record.seq}`;
  const place = `глава ${record.chapter}`;
  const date = momentText(record.at);
  const label = `${date}, ${number}, ${place}, ${record.alias}, ${word}${
    reason === null ? '' : `, ${reason}`
  } — открыть карточку правки`;

  return (
    // BOOK-77 (audit F1): the alias is a reader's display name, so the row is masked on its own.
    <li className="chr-row ym-hide-content">
      <span className="chr-date">{date}</span>
      <span className="chr-seq">{number}</span>
      <span className="chr-place">{place}</span>
      <span className="chr-alias">{record.alias}</span>
      <span className="chr-outcome">
        {word}
        {reason === null ? null : <span className="chr-reason">{reason}</span>}
      </span>
      <button
        type="button"
        className="chr-change"
        aria-label={label}
        onClick={() => onOpenChange(record.changeId)}
      >
        карточка
      </button>
    </li>
  );
}
