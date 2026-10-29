import type { HistoryRecordDto } from '@book/shared';
import type { MouseEvent } from 'react';

import { CAUSE_WORDS, recordReason, recordStateWord } from '../lib/changeStatus.ts';
import { momentText, recordHeading, spanText } from '../lib/history.ts';
import type { ChapterLoader, Place } from '../lib/place.ts';
import { PlaceLink } from './PlaceLink.tsx';

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
 * The record's door is an **anchor**, built by the server from the same id the record behind it
 * uses (`?change=<changeId>` · `#проход-<changeId>` · `#проход-<chapter>-<passId>`), so a row and
 * its record cannot name one entry two ways. Clicking the row does not move the moment either;
 * the moment moves only through `MomentControl`.
 *
 * BOOK-168 — the place is a door as well: «глава N» takes the reader to the paragraph the
 * change was filed on (its filing, read by id — `sourceCommentId`), and when the record holds
 * no filing only the chapter moves. A change opens through this page's path (`onOpenChange`),
 * which lands on its sentence and shows it in the record's `правка` section; a bare pass — which
 * has no change row — keeps the fragment to its record page.
 */
export type RecordRowProps = {
  record: HistoryRecordDto;
  /** The page's change door; absent where the surface cannot open the book's record. */
  onOpenChange?: (changeId: string) => void;
  /** The page's chapter read, handed to the place door (`PlaceLink`). */
  onLoadChapter?: ChapterLoader;
};

export function RecordRow({ record, onOpenChange, onLoadChapter }: RecordRowProps) {
  const state = recordStateWord(record);
  const reason = recordReason(record);
  const heading = recordHeading(record);
  const cause = CAUSE_WORDS[record.cause];
  const date = momentText(record.at);
  const span = record.span === null ? null : spanText(record.span);
  const reader = record.cause === 'reader';
  const face = reader ? 'правка' : 'запись';
  const label = [date, heading, span, state, reason, cause].filter((part) => part !== null).join(', ');
  // BOOK-168 — the place cell. With a filing the tap lands on its paragraph and opens the
  // filing's panel; without one it is the chapter, and the change is the book's own record.
  const target: Place =
    record.sourceCommentId === undefined || record.sourceCommentId === null
      ? { chapter: record.chapter, changeId: record.changeId ?? undefined }
      : { commentId: record.sourceCommentId, chapter: record.chapter, changeId: record.changeId ?? undefined };
  /**
   * The record's own door. A change opens through the page's one door: a query alone would be a
   * promise this surface cannot keep in place, so the landing is the page's. A bare pass has no
   * change row — its `#проход-<chapter>-<passId>` is the record page, and the browser's own act
   * is the one that gets there. A modified click is always the browser's (copy, a new tab), so
   * the href keeps its promise either way.
   */
  const openRecord = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (record.changeId === null || onOpenChange === undefined) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenChange(record.changeId);
  };

  return (
    // BOOK-77 (audit F1): the reader's words may sit in a span, so the row is masked on its own.
    // BOOK-128 #3900 §1 — two lines: the facts (mono 12) and the prose (serif 14). The door
    // closes the facts line; the span and the reason read under them.
    <li className="chr-row ym-hide-content">
      <span className="chr-facts">
        <span className="chr-date">{date}</span>
        <PlaceLink className="chr-place" place={target} onOpenChange={onOpenChange} onLoadChapter={onLoadChapter}>
          {heading}
        </PlaceLink>
        {state === null ? null : <span className="chr-state">{state}</span>}
        <span className="chr-cause">{cause}</span>
        <a
          className="chr-change"
          href={record.recordHref}
          aria-label={`${label} — открыть ${reader ? 'правку' : 'запись'}`}
          onClick={openRecord}
        >
          {face}
        </a>
      </span>
      {span === null && reason === null ? null : (
        <span className="chr-prose">
          {span === null ? null : <span className="chr-span">{span}</span>}
          {reason === null ? null : <span className="chr-reason">{reason}</span>}
        </span>
      )}
    </li>
  );
}
