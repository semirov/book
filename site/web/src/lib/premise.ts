import { TOTAL_CHAPTERS, type CatalogEntry, type ChangeSummaryDto, type CommentDto } from '@book/shared';

import { filingAttempt, filingNumber, type FilingAttempt } from './filings.ts';
import { failedAttempt, filingMarginalia } from './marginalia.ts';
import { reviseView, type ReviseView } from './revise.ts';

/**
 * BOOK-7 / BOOK-DOC-34 §2.4 — the chapter's premise, and the one place it is entered.
 *
 * A written chapter takes an intervention on its text. A slot with no text takes **one**
 * premise: the server's partial unique index admits the earliest and marks a later one
 * `superseded`, and the row must say so *before* the reader writes a second one. The frozen
 * frame of ch01/ch67 takes neither — it is not an empty chapter, it is a chapter that cannot
 * be written.
 *
 * BOOK-137 — **the premise row is the filing's home**, and on every chapter, written or not.
 * The reader's thread never lists a premise (`threadFilings` in `filings.ts`): a premise that
 * entered the first edition still has exactly one entry, the chapter's row, with one state
 * word and one number.
 */

export const PREMISE_EXISTS = 'у главы уже есть замысел';
export const PREMISE_HINT = 'это замысел главы, а не замечание к тексту: он станет первой редакцией, если его возьмут.';

/** Chapters that can take a premise: ch02..ch66, unwritten, and never a basis slot. */
export function canTakePremise(entry: Pick<CatalogEntry, 'n' | 'written' | 'basis'>): boolean {
  return entry.n >= 2 && entry.n <= TOTAL_CHAPTERS - 1 && !entry.written && !entry.basis;
}

/** The premise a chapter already holds: the earliest one that is not superseded. */
export function premiseFiling(comments: readonly CommentDto[], chapter: number): CommentDto | null {
  const rows = comments
    .filter((comment) => comment.premise && comment.chapter === chapter && comment.status !== 'superseded')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return rows[0] ?? null;
}

/**
 * What a tap on the slot does (BOOK-33): a slot that already holds a premise opens **that**
 * premise's card, and only an empty field opens the premise form. A second form would be
 * refused by the server and would also read as if nothing had been said yet.
 */
export function premiseAction(existing: CommentDto | null): { kind: 'card' | 'form' } {
  return existing === null ? { kind: 'form' } : { kind: 'card' };
}

/** What a second attempt is told, and where the first one is. */
export function premiseRefusal(first: CommentDto): { line: string; detail: string } {
  return { line: PREMISE_EXISTS, detail: `первый замысел — ${filingNumber(first)}` };
}

/**
 * The row (BOOK-90 A, BOOK-137) — one numeral, one field, and — while the chapter holds a
 * premise — that premise's own quote and its state word:
 *
 *   `02 ················································`
 *   `02 «смена переходит на ночь» ················ ждёт`
 *
 * The row is data, not copy: a chapter's number, the premise's own first line, and the word
 * the deck prints for its state. Why the word is there: an empty slot and a pending filing
 * must not read the same — the reader who already filed something saw «nothing at all» and
 * tapped again (BOOK-111, owner 2026-10-27). The word is `null` on an empty slot, and that is
 * the only shape the reading surface may print as a blank (BOOK-112, amended for this case).
 *
 * A **written** chapter keeps the row when it holds a premise: the filing must not leave the
 * page the moment the text arrives (BOOK-137). With no premise a written chapter has no row.
 */
export type PremiseRow = {
  n: number;
  /** The premise's id — the one `data-comment-id` this entry carries; null for an empty slot. */
  commentId: string | null;
  /** The existing premise's first line, or null for a slot that is still empty. */
  quote: string | null;
  /** The premise's state word («ждёт»), or null for a slot that still holds nothing. */
  word: string | null;
  /**
   * BOOK-136 — the one sentence a failed attempt owes the reader, under the row; null while a
   * premise waits normally (its word is the whole fact) and for one that has landed.
   */
  note: string | null;
  /**
   * BOOK-158 — why a refused premise was refused, in the server's own sentence. The row prints
   * it under the state word: «ждёт» alone would read as an ordinary wait, and the reader would
   * have no idea what to change. `null` for a premise no gate refused.
   */
  reason: string | null;
  /** BOOK-158 — the hint, the door and the limit that closes it, or null when nothing was refused. */
  revise: ReviseView | null;
  /** The latest attempt: the entry's one number and its one change door; null with no change. */
  attempt: FilingAttempt | null;
  actionable: boolean;
};

export function premiseRow(
  entry: Pick<CatalogEntry, 'n' | 'written' | 'basis'>,
  premise: CommentDto | null,
  changes: readonly ChangeSummaryDto[] = [],
  nowMs: number = Date.now(),
): PremiseRow | null {
  if (entry.basis || entry.n < 2 || entry.n > TOTAL_CHAPTERS - 1) return null;
  if (entry.written && premise === null) return null;
  return {
    n: entry.n,
    commentId: premise === null ? null : premise.id,
    quote: premise === null ? null : firstLine(premise.body),
    word: premise === null ? null : filingMarginalia(premise).word,
    note: premise === null ? null : rowNote(premise),
    reason: premise === null ? null : rowReason(premise),
    revise: premise === null ? null : reviseView(premise, nowMs),
    attempt: premise === null ? null : filingAttempt(premise, changes),
    actionable: true,
  };
}

function firstLine(body: string): string {
  const flat = body.replace(/\s+/gu, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 89).trimEnd()}…` : flat;
}

/**
 * BOOK-136 — a filing whose auxiliary attempt came back empty says so under its own row: the
 * word «ждёт» alone would read as an ordinary wait. The sentence is the deck's
 * (`filingMarginalia`), never assembled here, and a premise that landed owes no note at all.
 */
function rowNote(premise: CommentDto): string | null {
  return failedAttempt(premise) ? filingMarginalia(premise).consequence : null;
}

/**
 * BOOK-158 — why a refused premise was refused, in the server's sentence. The row prints it
 * under the state word; a premise that waits, lands or was never refused owes nothing here.
 */
function rowReason(premise: CommentDto): string | null {
  return premise.status === 'rejected' ? premise.reason : null;
}
