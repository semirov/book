import { FAILED_ATTEMPT_LINE, type CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { filingMarginalia } from './marginalia.ts';
import { canTakePremise, PREMISE_EXISTS, PREMISE_HINT, premiseAction, premiseFiling, premiseRefusal, premiseRow } from './premise.ts';

function comment(overrides: Partial<CommentDto> & { id: string; chapter: number; createdAt: string }): CommentDto {
  return {
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в главе должен быть документ о переводе смены',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    frame: 'untouched',
    premise: true,
    reason: null,
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

describe('canTakePremise', () => {
  it('takes ch02..ch41 that have no text, and neither frozen nor written chapters', () => {
    expect(canTakePremise({ n: 2, written: false, basis: false })).toBe(true);
    expect(canTakePremise({ n: 41, written: false, basis: false })).toBe(true);
    expect(canTakePremise({ n: 1, written: false, basis: true })).toBe(false);
    expect(canTakePremise({ n: 42, written: false, basis: true })).toBe(false);
    // The finale is outside the range, basis flag or not.
    expect(canTakePremise({ n: 42, written: false, basis: false })).toBe(false);
    expect(canTakePremise({ n: 8, written: true, basis: false })).toBe(false);
    expect(canTakePremise({ n: 1, written: false, basis: false })).toBe(false);
  });
});

describe('premiseFiling and the refusal', () => {
  const first = comment({ id: 'cmt_1', chapter: 9, createdAt: '2026-10-20T09:00:00Z' });
  const later = comment({ id: 'cmt_2', chapter: 9, createdAt: '2026-10-21T09:00:00Z' });

  it('finds the earliest premise of that chapter, ignoring notes and other chapters', () => {
    expect(premiseFiling([later, first], 9)?.id).toBe('cmt_1');
    expect(premiseFiling([{ ...first, premise: false }], 9)).toBeNull();
    expect(premiseFiling([first], 10)).toBeNull();
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
      commentId: null,
      quote: null,
      word: null,
      note: null,
      reason: null,
      revise: null,
      attempt: null,
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
    const pending = comment({ id: 'cmt_pending', chapter: 40, createdAt: '2026-10-27T18:04:17Z' });
    expect(pending.premise).toBe(true);
    expect(premiseRow({ n: 40, written: false, basis: false }, pending)).toMatchObject({
      quote: 'в главе должен быть документ о переводе смены',
      word: 'ждёт',
    });
  });

  it('says under the row that the attempt came back empty, and only then (BOOK-136)', () => {
    const failed = comment({
      id: 'cmt_failed',
      chapter: 40,
      createdAt: '2026-10-27T18:04:17Z',
      attempt: 'failed',
    });
    // The word is «ждёт»; the line under it is the deck's one sentence, in the deck's words.
    expect(premiseRow({ n: 40, written: false, basis: false }, failed)).toMatchObject({
      word: 'ждёт',
      note: FAILED_ATTEMPT_LINE,
    });
    // A plain wait owes no note: the word is the whole fact.
    const waiting = comment({ id: 'cmt_wait', chapter: 40, createdAt: '2026-10-27T18:04:17Z' });
    expect(premiseRow({ n: 40, written: false, basis: false }, waiting)?.note).toBeNull();
    // A landed premise keeps its receipt: the attempt behind it is stale news.
    const landed = comment({
      id: 'cmt_landed',
      chapter: 40,
      createdAt: '2026-10-27T18:04:17Z',
      status: 'applied',
      applied: { chapter: 40, rev: 7 },
      attempt: 'failed',
    });
    expect(premiseRow({ n: 40, written: true, basis: false }, landed)?.note).toBeNull();
    // A refusal decided itself: its own sentence is the line, never the attempt's.
    const refused = comment({
      id: 'cmt_refused',
      chapter: 40,
      createdAt: '2026-10-27T18:04:17Z',
      status: 'rejected',
      reason: 'не беру: не из этой сцены',
      attempt: 'failed',
    });
    expect(premiseRow({ n: 40, written: false, basis: false }, refused)?.note).toBeNull();
  });

  it('gives a refused premise its reason and its way back (BOOK-158)', () => {
    const NOW = Date.parse('2026-10-28T12:00:00Z');
    const refused = comment({
      id: 'cmt_refused',
      chapter: 40,
      createdAt: '2026-10-27T18:04:17Z',
      status: 'rejected',
      reason: 'не беру: не из этой сцены',
      hint: 'сформулируйте одно событие этой главы, которого ещё нет в тексте',
      revise: { allowed: true, at: null, attemptsLeft: 2, closed: false, blocked: null },
    });
    const row = premiseRow({ n: 40, written: false, basis: false }, refused, [], NOW);
    // The row is where the premise lives, so it owes the refusal's own sentence.
    expect(row?.reason).toBe('не беру: не из этой сцены');
    expect(row?.revise).toEqual({
      hint: 'сформулируйте одно событие этой главы, которого ещё нет в тексте',
      allowed: true,
      blocked: null,
    });

    // A premise that merely waits says nothing about a refusal.
    const waiting = comment({ id: 'cmt_wait', chapter: 40, createdAt: '2026-10-27T18:04:17Z' });
    expect(premiseRow({ n: 40, written: false, basis: false }, waiting)?.reason).toBeNull();
    expect(premiseRow({ n: 40, written: false, basis: false }, waiting)?.revise).toBeNull();
  });

  it('has no row for a written chapter without a premise, and none for a frozen slot', () => {
    const frozen = comment({ id: 'cmt_f', chapter: 42, createdAt: '2026-10-20T09:00:00Z' });
    expect(premiseRow({ n: 7, written: true, basis: false }, null)).toBeNull();
    expect(premiseRow({ n: 1, written: false, basis: true }, null)).toBeNull();
    expect(premiseRow({ n: 42, written: false, basis: true }, frozen)).toBeNull();
  });

  it('keeps the row for a premise that entered a written chapter (BOOK-137)', () => {
    // The prod page: the chapter got text, and the premise vanished as a duplicate comment
    // block in the thread. The row is the filing's only home, written or not.
    const landed = comment({
      id: 'cmt_landed',
      chapter: 40,
      createdAt: '2026-10-27T18:04:17Z',
      status: 'applied',
      applied: { chapter: 40, rev: 7 },
    });
    expect(premiseRow({ n: 40, written: true, basis: false }, landed)).toMatchObject({
      n: 40,
      commentId: 'cmt_landed',
      word: 'внесено',
    });
    // Still no row for a written chapter that never held a premise.
    expect(premiseRow({ n: 40, written: true, basis: false }, null)).toBeNull();
  });

  it('puts the latest attempt on the row: one number, and nothing when none is loaded', () => {
    const premise = comment({ id: 'cmt_3', chapter: 7, createdAt: '2026-10-20T09:00:00Z', status: 'accepted' });
    const attempt = {
      premiseLanded: false,
      sourceCommentId: 'cmt_3',
      id: 'chg_7',
      seq: 1,
      chapter: 7,
      intent: 'документ о переводе смены',
      premise: true,
      status: 'pending' as const,
      frame: 'untouched' as const,
      frameMode: null,
      outcome: null,
      reason: null,
      position: null,
      enqueuedAt: '2026-10-20T09:05:00Z',
      decidedAt: null,
      chapters: [7],
      rewritten: [],
      steps: 0,
      modes: [],
      cascade: null,
    };
    expect(premiseRow({ n: 7, written: false, basis: false }, premise, [attempt])?.attempt).toEqual({
      id: 'chg_7',
      number: '001',
      // The same attempt as the log's raw sequence: a filing prints «№1», never «001».
      seq: 1,
    });
    // The comment's own `changeId` is the fallback link when the window misses the attempt.
    const linked = { ...premise, changeId: 'chg_7' };
    expect(premiseRow({ n: 7, written: false, basis: false }, linked)?.attempt).toEqual({ id: 'chg_7', number: null, seq: null });
  });

  it('shortens a long premise to its first line, written or not (BOOK-77)', () => {
    const long = comment({
      id: 'cmt_long',
      chapter: 40,
      createdAt: '2026-10-27T18:04:17Z',
      status: 'applied',
      applied: { chapter: 40, rev: 7 },
      body: `${'смена переходит на ночь '.repeat(6)}и остаётся там`,
    });
    const row = premiseRow({ n: 40, written: true, basis: false }, long);
    expect(row?.quote?.length).toBe(90);
    expect(row?.quote?.endsWith('…')).toBe(true);
  });
});
