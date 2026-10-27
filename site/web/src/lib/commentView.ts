import { interventionKindLabel, type CommentDto } from '@book/shared';

import { receiptLine } from './terms.ts';

/**
 * How a reader's own note is told apart from a decision (§11.6, §12.6).
 *
 * The thread never collapses "accepted" into "applied": acceptance is a promise, application
 * is a later fact, and a note that was never considered says so. The line is data-driven and
 * carries no gate vocabulary.
 */

/** The line a filing panel prints as a one-line chip; past it, the line is a sentence. */
export const CHIP_MAX_CHARS = 24;

export type CommentLine = {
  state: string;
  detail: string | null;
  tone: 'quiet' | 'live' | 'done' | 'stopped';
  /**
   * BOOK-70: a chip states one fact on one line and may not hold a clause, so the form is a
   * property of the text, decided once here. A `sentence` — a receipt («внесено в главу 07 ·
   * право на ваш текст перешло автору книги») or a clause («снято: текст успел измениться») —
   * is printed at 14 px in the book's own voice and may wrap; a `chip` is 12 px, uppercase,
   * one line. The cap is the line: over 24 characters, or a ` · ` / `: ` in the text, and the
   * line is a sentence.
   */
  form: 'chip' | 'sentence';
};

/** The form, decided in one place: the cap, the clause's punctuation, or an explicit receipt. */
function lineOf(
  state: string,
  detail: string | null,
  tone: CommentLine['tone'],
  receipt = false,
): CommentLine {
  const sentence = receipt || state.length > CHIP_MAX_CHARS || state.includes(' · ') || state.includes(': ');
  return { state, detail, tone, form: sentence ? 'sentence' : 'chip' };
}

export function commentStatusLine(comment: CommentDto): CommentLine {
  // BOOK-7: a premise never says «правка в очереди» — it waits for the chapter's first pass.
  if (comment.premise) return premiseLine(comment);
  switch (comment.status) {
    case 'new':
      return lineOf('ждёт рассмотрения', null, 'quiet');
    case 'batched':
    case 'delivered':
      return lineOf('в проходе триажа', null, 'live');
    case 'accepted':
      // BOOK-70: this one names a decision and a place (« · »), so it is a sentence, not a chip.
      return lineOf('принято · правка в очереди', comment.reason, 'live');
    case 'applied':
      // BOOK-58: the receipt of an entered variant names the chapter and the right that moved
      // with it — the bare «внесено в главу N» said half of what happened.
      return lineOf(
        comment.applied === null ? 'внесено' : receiptLine(String(comment.applied.chapter).padStart(2, '0')),
        comment.reason,
        'done',
        // A receipt only when it really names the chapter and the right; «внесено» is a chip.
        comment.applied !== null,
      );
    case 'superseded':
      return lineOf('снято: текст успел измениться', comment.reason, 'stopped');
    case 'rejected':
      return lineOf('отклонено', comment.reason, 'stopped');
    case 'quarantined':
      return lineOf('проверяется', comment.reason, 'stopped');
    case 'expired':
      return lineOf('не рассмотрено: проход не состоялся', comment.reason, 'stopped');
    case 'hidden':
      return lineOf('скрыто', comment.reason, 'stopped');
    default:
      return lineOf('ждёт рассмотрения', null, 'quiet');
  }
}

/**
 * BOOK-16 — the kind a reader brought, as the one plain word the thread prints beside the
 * decision («документ · принято · правка в очереди»). No id reaches the page and `null`
 * prints nothing at all, which is what a note and a pre-BOOK-16 row look like.
 */
export function interventionKindWord(comment: Pick<CommentDto, 'interventionKind'>): string | null {
  return interventionKindLabel(comment.interventionKind);
}

/** BOOK-7 — the four states of a premise, in the thread's own words. */
function premiseLine(comment: CommentDto): CommentLine {
  const chapter = comment.applied?.chapter ?? comment.chapter;
  switch (comment.status) {
    case 'applied':
      // The state already names the chapter and the edition; the reason would repeat it. It
      // names two things, so it is a sentence by the same cap (BOOK-70).
      return lineOf(`вошло в первую редакцию главы ${chapter}`, null, 'done', true);
    case 'superseded':
      return lineOf('замысел снят', comment.reason, 'stopped');
    case 'rejected':
      return lineOf('замысел не взят', comment.reason, 'stopped');
    default:
      return lineOf('принято в основу', comment.reason, 'live');
  }
}

/** `2026-10-25T12:04:11Z` → «25.10, 12:04» — absolute, because readers return days later. */
export function commentStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day}.${month}, ${time}`;
}

/** The anchor quote, shortened for a phone; never re-flowed into the comment body. */
export function anchorCopy(comment: CommentDto): string | null {
  if (!comment.anchor.resolved) return 'абзац изменился';
  const quote = comment.anchor.quote;
  if (quote === null || quote.length === 0) return null;
  return quote.length > 90 ? `${quote.slice(0, 89).trimEnd()}…` : quote;
}
