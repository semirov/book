import { interventionKindLabel, type CommentDto } from '@book/shared';

import { filingConsequence, filingMarginalia, landingReceipt, PREMISE_PENDING } from './marginalia.ts';

/**
 * How a reader's own note is told apart from a decision (§11.6, §12.6).
 *
 * BOOK-90 — the **state** is one of the three words («ждёт» · «идёт» · «внесено»), read from
 * `lib/marginalia.ts`; the **detail** carries the fact that word cannot: a refusal, a
 * superseded anchor, a held check, an expired pass, the receipt of a landed change. The
 * thread never collapses "accepted" into "applied": acceptance is a promise, application is
 * a later fact, and a note that was never considered says so. No gate vocabulary.
 */

export type CommentLine = { state: string; detail: string | null; tone: 'quiet' | 'live' | 'done' | 'stopped' };

/** The deck's fact, and the reader's own reason beside it when the record has one. */
function joinDetail(fact: string, reason: string | null): string {
  return reason === null || reason.length === 0 ? fact : `${fact} · ${reason}`;
}

export function commentStatusLine(comment: CommentDto): CommentLine {
  // BOOK-7: a premise never says «правка в очереди» — it waits for the chapter's first pass.
  if (comment.premise) return premiseLine(comment);
  const { word } = filingMarginalia(comment);
  switch (comment.status) {
    case 'new':
      return { state: word, detail: null, tone: 'quiet' };
    case 'batched':
    case 'delivered':
      return { state: word, detail: null, tone: 'live' };
    case 'accepted':
      return {
        state: word,
        detail: joinDetail(filingConsequence(comment), comment.reason),
        tone: 'live',
      };
    case 'applied': {
      // BOOK-58: the receipt of an entered variant names the chapter and the right that moved
      // with it — the state is the word «внесено», the receipt is its detail. A note moved no
      // right: its own terminal is «замечание сохранено».
      const receipt =
        comment.applied === null || comment.interventionKind === null
          ? filingConsequence(comment)
          : landingReceipt(comment.applied.chapter, comment.applied.rev);
      return { state: word, detail: joinDetail(receipt, comment.reason), tone: 'done' };
    }
    case 'superseded':
      return { state: word, detail: joinDetail('снято: текст успел измениться', comment.reason), tone: 'stopped' };
    case 'rejected':
      return { state: word, detail: joinDetail('отклонено', comment.reason), tone: 'stopped' };
    case 'quarantined':
      return { state: word, detail: joinDetail('проверяется перед триажем', comment.reason), tone: 'stopped' };
    case 'expired':
      return { state: word, detail: joinDetail('проход не состоялся', comment.reason), tone: 'stopped' };
    case 'hidden':
      return { state: word, detail: joinDetail('скрыто', comment.reason), tone: 'stopped' };
    default:
      return { state: word, detail: comment.reason, tone: 'quiet' };
  }
}

/**
 * BOOK-16 — the kind a reader brought, as the one plain word the thread prints beside the
 * decision («документ · идёт»). No id reaches the page and `null` prints nothing at all,
 * which is what a note and a pre-BOOK-16 row look like.
 */
export function interventionKindWord(comment: Pick<CommentDto, 'interventionKind'>): string | null {
  return interventionKindLabel(comment.interventionKind);
}

/** BOOK-7 — the four states of a premise, in the three words plus the fact (BOOK-90). */
function premiseLine(comment: CommentDto): CommentLine {
  const chapter = comment.applied?.chapter ?? comment.chapter;
  const { word } = filingMarginalia(comment);
  switch (comment.status) {
    case 'applied':
      // The state is the word; the edition it entered is the detail, and the reason would
      // only repeat it.
      return { state: word, detail: `вошло в первую редакцию главы ${chapter}`, tone: 'done' };
    case 'superseded':
      return { state: word, detail: joinDetail('замысел снят', comment.reason), tone: 'stopped' };
    case 'rejected':
      return { state: word, detail: joinDetail('замысел не взят', comment.reason), tone: 'stopped' };
    default:
      return { state: word, detail: joinDetail(PREMISE_PENDING, comment.reason), tone: 'live' };
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
