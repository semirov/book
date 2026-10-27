import { interventionKindLabel, type CommentDto } from '@book/shared';

import { receiptLine } from './terms.ts';

/**
 * How a reader's own note is told apart from a decision (§11.6, §12.6).
 *
 * The thread never collapses "accepted" into "applied": acceptance is a promise, application
 * is a later fact, and a note that was never considered says so. The line is data-driven and
 * carries no gate vocabulary.
 */

export type CommentLine = { state: string; detail: string | null; tone: 'quiet' | 'live' | 'done' | 'stopped' };

export function commentStatusLine(comment: CommentDto): CommentLine {
  // BOOK-7: a premise never says «правка в очереди» — it waits for the chapter's first pass.
  if (comment.premise) return premiseLine(comment);
  switch (comment.status) {
    case 'new':
      return { state: 'ждёт рассмотрения', detail: null, tone: 'quiet' };
    case 'batched':
    case 'delivered':
      return { state: 'в проходе триажа', detail: null, tone: 'live' };
    case 'accepted':
      return {
        state: 'принято · правка в очереди',
        detail: comment.reason,
        tone: 'live',
      };
    case 'applied':
      return {
        // BOOK-58: the receipt of an entered variant names the chapter and the right that moved
        // with it — the bare «внесено в главу N» said half of what happened.
        state: comment.applied === null ? 'внесено' : receiptLine(String(comment.applied.chapter).padStart(2, '0')),
        detail: comment.reason,
        tone: 'done',
      };
    case 'superseded':
      return { state: 'снято: текст успел измениться', detail: comment.reason, tone: 'stopped' };
    case 'rejected':
      return { state: 'отклонено', detail: comment.reason, tone: 'stopped' };
    case 'quarantined':
      return { state: 'проверяется', detail: comment.reason, tone: 'stopped' };
    case 'expired':
      return { state: 'не рассмотрено: проход не состоялся', detail: comment.reason, tone: 'stopped' };
    case 'hidden':
      return { state: 'скрыто', detail: comment.reason, tone: 'stopped' };
    default:
      return { state: 'ждёт рассмотрения', detail: null, tone: 'quiet' };
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
      // The state already names the chapter and the edition; the reason would repeat it.
      return { state: `вошло в первую редакцию главы ${chapter}`, detail: null, tone: 'done' };
    case 'superseded':
      return { state: 'замысел снят', detail: comment.reason, tone: 'stopped' };
    case 'rejected':
      return { state: 'замысел не взят', detail: comment.reason, tone: 'stopped' };
    default:
      return { state: 'принято в основу', detail: comment.reason, tone: 'live' };
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
