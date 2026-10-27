import { TOTAL_CHAPTERS, type CatalogEntry, type CommentDto } from '@book/shared';

import { filingNumber } from './filings.ts';
import { filingMarginalia } from './marginalia.ts';

/**
 * BOOK-7 / BOOK-DOC-34 §2.4 — the empty chapter's premise.
 *
 * A written chapter takes an intervention on its text. A slot with no text takes **one**
 * premise: the server's partial unique index admits the earliest and marks a later one
 * `superseded`, and the row must say so *before* the reader writes a second one. The frozen
 * frame of ch01/ch67 takes neither — it is not an empty chapter, it is a chapter that cannot
 * be written.
 */

export const PREMISE_EXISTS = 'у главы уже есть замысел';
export const PREMISE_HINT = 'это замысел главы, а не замечание к тексту: он станет первой редакцией, если его возьмут.';

/** Chapters that can take a premise: ch02..ch66, unwritten, and never a basis slot. */
export function canTakePremise(entry: Pick<CatalogEntry, 'n' | 'written' | 'basis'>): boolean {
  return entry.n >= 2 && entry.n <= TOTAL_CHAPTERS - 1 && !entry.written && !entry.basis;
}

/** The premise a chapter already holds: the earliest one that is not superseded. */
export function existingPremise(comments: readonly CommentDto[], chapter: number): CommentDto | null {
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
  return { line: PREMISE_EXISTS, detail: `первый замысел — замечание ${filingNumber(first)}` };
}

/**
 * The empty slot's row (BOOK-90 A) — one numeral, one field, and — while the slot holds a
 * premise — that premise's state word:
 *
 *   `02 ················································`
 *   `02 «смена переходит на ночь» ················ ждёт`
 *
 * The row is data, not copy: a chapter's number, the premise's own first line, and the word
 * the deck prints for its state. Why the word is there: an empty slot and a pending filing
 * must not read the same — the reader who already filed something saw «nothing at all» and
 * tapped again (BOOK-111, owner 2026-10-27). The word is `null` on an empty slot, and that is
 * the only shape the reading surface may print as a blank (BOOK-112, amended for this case).
 */
export type PremiseRow = {
  n: number;
  /** The existing premise's first line, or null for a slot that is still empty. */
  quote: string | null;
  /** The premise's state word («ждёт»), or null for a slot that still holds nothing. */
  word: string | null;
  actionable: boolean;
};

export function premiseRow(
  entry: Pick<CatalogEntry, 'n' | 'written' | 'basis'>,
  premise: CommentDto | null,
): PremiseRow | null {
  if (entry.written || entry.basis || entry.n < 2 || entry.n > TOTAL_CHAPTERS - 1) return null;
  return {
    n: entry.n,
    quote: premise === null ? null : firstLine(premise.body),
    word: premise === null ? null : filingMarginalia(premise).word,
    actionable: true,
  };
}

function firstLine(body: string): string {
  const flat = body.replace(/\s+/gu, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 89).trimEnd()}…` : flat;
}
