import type { CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { filingMarginalia } from './marginalia.ts';
import { canTakePremise, existingPremise, PREMISE_EXISTS, PREMISE_HINT, premiseAction, premiseRefusal, premiseRow } from './premise.ts';

function comment(overrides: Partial<CommentDto> & { id: string; chapter: number; createdAt: string }): CommentDto {
  return {
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в главе должен быть документ о переводе смены',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    premise: true,
    reason: null,
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

describe('canTakePremise', () => {
  it('takes ch02..ch66 that have no text, and neither frozen nor written chapters', () => {
    expect(canTakePremise({ n: 2, written: false, basis: false })).toBe(true);
    expect(canTakePremise({ n: 66, written: false, basis: false })).toBe(true);
    expect(canTakePremise({ n: 1, written: false, basis: true })).toBe(false);
    expect(canTakePremise({ n: 67, written: false, basis: true })).toBe(false);
    expect(canTakePremise({ n: 8, written: true, basis: false })).toBe(false);
    expect(canTakePremise({ n: 1, written: false, basis: false })).toBe(false);
  });
});

describe('existingPremise and the refusal', () => {
  const first = comment({ id: 'cmt_1', chapter: 9, createdAt: '2026-10-20T09:00:00Z' });
  const later = comment({ id: 'cmt_2', chapter: 9, createdAt: '2026-10-21T09:00:00Z' });

  it('finds the earliest premise of that chapter, ignoring notes and other chapters', () => {
    expect(existingPremise([later, first], 9)?.id).toBe('cmt_1');
    expect(existingPremise([{ ...first, premise: false }], 9)).toBeNull();
    expect(existingPremise([first], 10)).toBeNull();
  });

  it('refuses a second premise by name and points at the first', () => {
    expect(PREMISE_EXISTS).toBe('у главы уже есть замысел');
    expect(premiseRefusal(first)).toEqual({ line: PREMISE_EXISTS, detail: 'первый замысел — замечание №MT1' });
  });

  it('keeps the row copy honest about what a premise is', () => {
    expect(PREMISE_HINT).toContain('станет первой редакцией');
  });
});

describe('premiseAction', () => {
  it('opens the existing premise’s card, and the form only on an empty field', () => {
    expect(premiseAction(null)).toEqual({ kind: 'form' });
    expect(premiseAction(comment({ id: 'cmt_9', chapter: 7, createdAt: '2026-10-20T09:00:00Z' }))).toEqual({ kind: 'card' });
  });
});

describe('premiseRow', () => {
  it('shows a dotted empty field, and no word, while the slot holds nothing', () => {
    expect(premiseRow({ n: 7, written: false, basis: false }, null)).toEqual({
      n: 7,
      quote: null,
      word: null,
      actionable: true,
    });
  });

  it('shows the premise instead, with its own first line and its state word (BOOK-111)', () => {
    const premise = comment({ id: 'cmt_3', chapter: 7, createdAt: '2026-10-20T09:00:00Z', status: 'accepted' });
    expect(premiseRow({ n: 7, written: false, basis: false }, premise)).toMatchObject({
      quote: 'в главе должен быть документ о переводе смены',
      word: 'ждёт',
    });
    // The word is the deck's, from `filingMarginalia` — never a second copy of the vocabulary.
    expect(premiseRow({ n: 7, written: false, basis: false }, premise)?.word).toBe(filingMarginalia(premise).word);
    // An empty slot prints no word at all: the difference is the reader's own filing.
    expect(premiseRow({ n: 7, written: false, basis: false }, null)?.word).toBeNull();
  });

  it('gives an unwritten chapter’s pending filing the word it waits under (BOOK-111)', () => {
    // The prod incident: `premise: true, status: 'new'`, no change yet — the row said nothing,
    // so the empty slot read as empty and the next tap came back 409 DUPLICATE.
    const pending = comment({ id: 'cmt_pending', chapter: 65, createdAt: '2026-10-27T18:04:17Z' });
    expect(pending.premise).toBe(true);
    expect(premiseRow({ n: 65, written: false, basis: false }, pending)).toMatchObject({
      quote: 'в главе должен быть документ о переводе смены',
      word: 'ждёт',
    });
  });

  it('has no row for a written or frozen chapter', () => {
    expect(premiseRow({ n: 7, written: true, basis: false }, null)).toBeNull();
    expect(premiseRow({ n: 1, written: false, basis: true }, null)).toBeNull();
  });
});
