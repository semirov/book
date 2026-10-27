import { interventionKindLabel, type CommentDto } from '@book/shared';

import { filingConsequence, filingMarginalia, landingReceipt } from './marginalia.ts';

/**
 * How a reader's own note is told apart from a decision (§11.6, §12.6).
 *
 * BOOK-90 — the **state** is one of the three words («ждёт» · «идёт» · «внесено»), read from
 * `lib/marginalia.ts`; the **detail** carries the fact that word cannot: a refusal, a
 * superseded anchor, a held check, an expired pass, the receipt of a landed change.
 *
 * BOOK-70 — the state is printed once, in the form its own text asks for: a chip (12 px,
 * uppercase, one line) when the text fits one, a sentence (14 px, the book's voice, may wrap)
 * when it is a receipt or a clause. The three words always fit a chip; a clause lives in the
 * detail line, so a state never has to overflow to say what happened.
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

/** The deck's fact, and the reader's own reason beside it when the record has one. */
function joinDetail(fact: string, reason: string | null): string {
  return reason === null || reason.length === 0 ? fact : `${fact} · ${reason}`;
}

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
  const { word } = filingMarginalia(comment);
  switch (comment.status) {
    case 'new':
      // A filing whose attempt came back empty still waits, and the human line
      // under the word is the deck's — the state word alone would hide the attempt.
      return lineOf(word, comment.attempt === 'failed' ? filingConsequence(comment) : null, 'quiet');
    case 'batched':
    case 'delivered':
      return lineOf(word, null, 'live');
    case 'accepted':
      return lineOf(word, joinDetail(filingConsequence(comment), comment.reason), 'live');
    case 'applied': {
      // BOOK-58: the receipt of an entered variant names the chapter and the right that moved
      // with it — the state is the word «внесено», the receipt is its detail. A note moved no
      // right: its own terminal is «замечание сохранено».
      const receipt =
        comment.applied === null || comment.interventionKind === null
          ? filingConsequence(comment)
          : landingReceipt(comment.applied.chapter, comment.applied.rev);
      return lineOf(word, joinDetail(receipt, comment.reason), 'done');
    }
    case 'superseded':
      return lineOf(word, joinDetail('снято: текст успел измениться', comment.reason), 'stopped');
    case 'rejected':
      // BOOK-61: each refusal heads its line with the gate's own word. B's line is the fixed
      // sentence alone (nothing else — a model never writes it); C's keeps the auditor's reason.
      return comment.refusal === 'rights'
        ? lineOf(word, filingConsequence(comment), 'stopped')
        : lineOf(word, joinDetail(filingConsequence(comment), comment.reason), 'stopped');
    case 'quarantined':
      // HELD: the word «проверяется» and the hold's own line, never the guard's taxonomy.
      return lineOf(word, filingConsequence(comment), 'stopped');
    case 'expired':
      return lineOf(word, joinDetail('проход не состоялся', comment.reason), 'stopped');
    case 'hidden':
      return lineOf(word, joinDetail('скрыто', comment.reason), 'stopped');
    default:
      return lineOf(word, comment.reason, 'quiet');
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
  const { word } = filingMarginalia(comment);
  switch (comment.status) {
    case 'applied':
      // The state is the word; the edition it entered is the detail, and the reason would
      // only repeat it.
      return lineOf(word, filingConsequence(comment), 'done');
    case 'superseded':
      return lineOf(word, joinDetail('замысел снят', comment.reason), 'stopped');
    case 'rejected':
      return lineOf(word, joinDetail('замысел не взят', comment.reason), 'stopped');
    default:
      // The default is the deck's own line — «принято в основу, до первой
      // редакции», or the failed-attempt sentence when the linked change came back empty.
      return lineOf(word, joinDetail(filingConsequence(comment), comment.reason), 'live');
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
