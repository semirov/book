import type { HistoryRecordDto } from '@book/shared';

import { recordReason, recordStateWord } from '../lib/changeStatus.ts';
import { momentText, recordHeading, spanText } from '../lib/history.ts';

/**
 * The one word each cause gets: whose act the entry is, in a word.
 *
 * «правка читателя» is a person's filing the book accepted; «проход» is a pass over the book,
 * a machine change or a landed stage with no change row. Neither names a model, a role or a
 * stage — the chronicle prints the change, not the machinery that produced it.
 */
export const CAUSE_WORDS = { reader: 'правка читателя', pass: 'проход' } as const;

/**
 * BOOK-65 — one public record entry: **one change to the book**, once, and one way in.
 *
 * The row carries the change's moment, its place (`глава 9 · Название`, from the server's own
 * `chapters` read), the pair the book wrote — «было» → «стало», only where an honest pair
 * exists — whether the change entered the text at all («не внесено» when it did not, with the
 * public reason it was stopped for), whose act it was, and the door to its record. It prints no
 * number, no alias, no event kind, no stage, no model and no price: the chronicle is the book's
 * past, not the workshop's logbook.
 *
 * The door is an **anchor**, built by the server from the same id the record behind it uses
 * (`#правка-<changeId>` · `#проход-<changeId | passId>`), so a row and its record cannot name
 * one entry two ways. Clicking the row does not move the moment either; the moment moves only
 * through `MomentControl`.
 */
export type RecordRowProps = {
  record: HistoryRecordDto;
};

export function RecordRow({ record }: RecordRowProps) {
  const state = recordStateWord(record);
  const reason = recordReason(record);
  const heading = recordHeading(record);
  const cause = CAUSE_WORDS[record.cause];
  const date = momentText(record.at);
  const span = record.span === null ? null : spanText(record.span);
  const reader = record.cause === 'reader';
  const face = reader ? 'прицел' : 'запись';
  const label = [date, heading, span, state, reason, cause].filter((part) => part !== null).join(', ');

  return (
    // BOOK-77 (audit F1): the reader's words may sit in a span, so the row is masked on its own.
    <li className="chr-row ym-hide-content">
      <span className="chr-date">{date}</span>
      <span className="chr-place">{heading}</span>
      {span === null ? null : <span className="chr-span">{span}</span>}
      {state === null ? null : <span className="chr-state">{state}</span>}
      {reason === null ? null : <span className="chr-reason">{reason}</span>}
      <span className="chr-cause">{cause}</span>
      <a
        className="chr-change"
        href={record.recordHref}
        aria-label={`${label} — открыть ${reader ? 'прицел правки' : 'запись прохода'}`}
      >
        {face}
      </a>
    </li>
  );
}
