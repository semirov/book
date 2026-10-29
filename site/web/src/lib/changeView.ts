import type { ChangeDto, CommentDto } from '@book/shared';

import { changeNumber, outcomeCopy, stepLabel } from './changeStatus.ts';
import { commentStamp } from './commentView.ts';
import { changeWord } from './marginalia.ts';

/**
 * The change's own vocabulary for the record's `правка` section.
 *
 * A change used to be a sheet of its own (the change card, then the focus view). It is now a
 * section of the sentence's record: the numeral is the section's header value, and the body is
 * rows in the record's register — the touched sentence before and after, the state word with
 * its moment, the change's outcome, and one line per step. Everything here is a function of
 * the public DTOs and the record's own anchor, so the rows can be asserted without a browser.
 */

export type ChangeStepRow = { key: string; text: string };

export type ChangeView = {
  id: string;
  /** `014` — the numeral the section header prints, never a screen title. */
  numeral: string;
  /** `внесено` — the state word (`changeWord`). */
  state: string;
  /** `25.10, 12:05` — the moment the change was decided, or when it was filed. */
  stamp: string;
  /** `внесено` / `внесено частично` / `снято` — the outcome of the change. */
  outcome: string;
  /** The author's own words, as the record quotes them when there is no filing. */
  intent: string;
  /** The sentence the filing cited, as filed; `null` when the change has no filing. */
  before: string | null;
  /** The sentence as it stands now (the record's own anchor quote); `null` for a premise. */
  after: string | null;
  steps: ChangeStepRow[];
};

/**
 * The filing's own quote, when the change was made from one and the record holds it. A change
 * with no filing (an author's own change, a premise) has no «было»: the record prints its
 * intent instead of inventing a sentence.
 */
export function changeBefore(change: Pick<ChangeDto, 'source'>, filings: readonly CommentDto[] | null): string | null {
  const id = change.source.commentId;
  if (id === null) return null;
  return filings?.find((filing) => filing.id === id)?.anchor.quote ?? null;
}

export function changeView(
  change: ChangeDto,
  before: string | null,
  after: string | null,
): ChangeView {
  return {
    id: change.id,
    numeral: changeNumber(change.seq),
    state: changeWord(change),
    stamp: commentStamp(change.decidedAt ?? change.enqueuedAt),
    outcome: outcomeCopy(change.outcome),
    intent: change.intent,
    before,
    after,
    steps: change.steps.map((step) => ({
      key: `${String(step.seq)}-${step.at}`,
      text: stepLabel(step),
    })),
  };
}
