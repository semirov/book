import { interventionKindLabel, type CommentDto } from '@book/shared';

import { filingInk } from './filings.ts';
import {
  failedAttempt,
  filingConsequence,
  filingMarginalia,
  landedReceiptLine,
  refusalDetail,
} from './marginalia.ts';

/**
 * How a reader's own note is told apart from a decision (§11.6, §12.6).
 *
 * BOOK-90 — the **state** is one of the deck's words («ждёт» · «идёт» · «внесено», plus
 * «рассмотрено» and «отклонено»), read from `lib/marginalia.ts`; the **detail** carries the
 * fact that word cannot: a refusal's reason, a superseded anchor, a held check, an expired
 * pass, the receipt of a landed change.
 *
 * BOOK-70 — the state is printed once, in the form its own text asks for: a chip (12 px,
 * uppercase, one line) when the text fits one, a sentence (14 px, the book's voice, may wrap)
 * when it is a clause. Every state word fits a chip; the fact — a receipt («глава 3 · ревизия
 * 4»), a clause, a refusal's reason — lives in the detail line, so a state never has to
 * overflow to say what happened.
 */

/** The line a filing panel prints as a one-line chip; past it, the line is a sentence. */
export const CHIP_MAX_CHARS = 24;

export type CommentLine = {
  state: string;
  detail: string | null;
  tone: 'quiet' | 'live' | 'done' | 'stopped';
  /**
   * BOOK-70: a chip states one fact on one line and may not hold a clause, so the form is a
   * property of the text, decided once here. A `sentence` — a clause («снято: текст успел
   * измениться») — is printed at 14 px in the book's own voice and may wrap; a `chip` is 12 px,
   * uppercase, one line. The cap is the line: over 24 characters, or a ` · ` / `: ` in the text,
   * and the line is a sentence.
   */
  form: 'chip' | 'sentence';
};

/** The deck's fact, and the reader's own reason beside it when the record has one. */
function joinDetail(fact: string, reason: string | null): string {
  return reason === null || reason.length === 0 ? fact : `${fact} · ${reason}`;
}

/** `''` is the deck's own «no line»: the detail slot takes `null`, never an empty string. */
function nullIfEmpty(text: string): string | null {
  return text.length === 0 ? null : text;
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
      // A filing whose attempt came back empty still waits, and the human line under the word
      // is the deck's — the state word alone would hide the attempt. The row's own sentence is
      // a separate fact and keeps its place beside it, exactly as on an accepted row: the
      // attempt is the consequence, the reason is what the row itself said.
      return lineOf(
        word,
        comment.attempt === 'failed' ? joinDetail(filingConsequence(comment), comment.reason) : comment.reason,
        'quiet',
      );
    case 'batched':
    case 'delivered':
      // BOOK-136 — a filing already in the machinery can carry an attempt that came back empty:
      // the word says where the row stands, and the deck's sentence says what became of the
      // attempt. Nothing else is owed here — a batch is not a receipt.
      return lineOf(word, failedAttempt(comment) ? filingConsequence(comment) : null, 'live');
    case 'accepted':
      // BOOK-189: the accepted row has no reason of its own to add — the stale acceptance
      // sentence («входит в книгу») is not a fact about the writer's lane. One explanatory line
      // only: «пишется» while the writer is at it, «в очереди на запись» while the lane holds
      // it, or the failed-attempt sentence when the attempt behind it came back empty.
      //
      // B1 — the ink follows the line: a change that landed (or stopped) moved the row's state,
      // and its shape table already says which tone that is. A landing without a receipt, or a
      // retry the server explained elsewhere, leaves no line rather than an empty one.
      return lineOf(word, nullIfEmpty(filingConsequence(comment)), filingInk(comment).tone);
    case 'registered':
      // BOOK-137 — the paperwork's own line: «рассмотрено · оформление · фраза не изменилась»,
      // and nothing else. The reason is that same sentence on the row, so printing it too would
      // say «фраза не меняется» twice.
      return lineOf(word, filingConsequence(comment), 'done');
    case 'applied': {
      // BOOK-189 — the owner's row for a landing is one state word and one line: «внесено ·
      // глава 3 · ревизия 4», the same shape the margin note and the record print. No second
      // «внесено», no rights clause (the reader signed that when filing) and no stored reason.
      const receipt = landedReceiptLine(comment.applied);
      if (receipt !== null) return lineOf(word, receipt, 'done');
      // A legacy row with no receipt of its own: the note's own terminal, or the word alone. The
      // stored reason («входит в книгу») is not a fact about a landing, and never joined here.
      return lineOf(word, nullIfEmpty(filingConsequence(comment)), 'done');
    }
    case 'superseded':
      return lineOf(word, joinDetail('снято: текст успел измениться', comment.reason), 'stopped');
    case 'rejected':
      // BOOK-61, BOOK-189: the gate's own word is the state, and the public reason is the whole
      // line — a refusal is a decision, not a queue place, so «ждёт» never heads it. B's word is
      // stripped from its own sentence (`refusalDetail`), so the row never repeats it.
      return lineOf(word, refusalDetail(comment), 'stopped');
    case 'escalated':
      // BOOK-206: a legacy value the boot migration re-opens. It is neither decided nor refused,
      // so it keeps the undecided word and claims no fact — the old question is not a line the
      // reader is owed any more.
      return lineOf(word, null, 'live');
    case 'quarantined':
      // HELD: the word «проверяется» and the hold's own line, never the guard's taxonomy.
      return lineOf(word, filingConsequence(comment), 'stopped');
    case 'expired':
      return lineOf(word, joinDetail('правка не состоялась', comment.reason), 'stopped');
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
