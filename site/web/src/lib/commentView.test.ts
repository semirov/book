import { describe, expect, it } from 'vitest';

import type { CommentDto } from '@book/shared';

import { anchorCopy, commentStamp, commentStatusLine } from './commentView.ts';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 8,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'Тут дважды «слово».',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'new',
    reason: null,
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

describe('comment thread copy (§11.6)', () => {
  it('never collapses acceptance into application', () => {
    // BOOK-90: one of the three words; the fact that word cannot carry is the detail.
    expect(commentStatusLine(comment({ status: 'new' })).state).toBe('ждёт');
    expect(commentStatusLine(comment({ status: 'accepted', changeId: 'chg_1', reason: 'принято' }))).toMatchObject({
      state: 'идёт',
      detail: 'замечание в очереди · принято',
      tone: 'live',
    });
    expect(
      commentStatusLine(comment({ status: 'applied', applied: { chapter: 8, rev: 3 }, reason: 'внесено' })),
    ).toMatchObject({
      state: 'внесено',
      detail: 'замечание сохранено · внесено',
      tone: 'done',
    });
    // An intervention moved the right with the text; a note never did.
    expect(
      commentStatusLine(
        comment({ status: 'applied', interventionKind: 'testimony', applied: { chapter: 8, rev: 3 } }),
      ).detail,
    ).toBe('внесено в главу 08 · право на ваш текст перешло автору книги · ревизия 3');
  });

  it('tells a premise’s four states without a queue place (BOOK-7)', () => {
    expect(commentStatusLine(comment({ premise: true, status: 'accepted', changeId: 'chg_1', reason: 'входит в книгу' }))).toEqual({
      state: 'ждёт',
      detail: 'принято в основу, до первой редакции · входит в книгу',
      tone: 'live',
    });
    expect(
      commentStatusLine(
        comment({ premise: true, status: 'applied', chapter: 5, changeId: 'chg_1', reason: 'вошло в первую редакцию главы 5' }),
      ),
    ).toEqual({ state: 'внесено', detail: 'вошло в первую редакцию главы 5', tone: 'done' });
    expect(
      commentStatusLine(comment({ premise: true, status: 'superseded', reason: 'у главы уже есть замысел' })),
    ).toEqual({ state: 'ждёт', detail: 'замысел снят · у главы уже есть замысел', tone: 'stopped' });
    expect(commentStatusLine(comment({ premise: true, status: 'rejected', reason: 'не беру: не из этой сцены' }))).toEqual({
      state: 'ждёт',
      detail: 'замысел не взят · не беру: не из этой сцены',
      tone: 'stopped',
    });
  });

  it('says "not considered" instead of pretending', () => {
    expect(commentStatusLine(comment({ status: 'expired' }))).toMatchObject({
      state: 'ждёт',
      detail: 'проход не состоялся',
    });
    expect(commentStatusLine(comment({ status: 'rejected', reason: 'вне рамок: форма книги' }))).toMatchObject({
      state: 'ждёт',
      detail: 'отклонено · вне рамок: форма книги',
      tone: 'stopped',
    });
    expect(commentStatusLine(comment({ status: 'quarantined' }))).toMatchObject({
      state: 'ждёт',
      detail: 'проверяется перед триажем',
    });
  });

  it('formats a stamp and an anchor quote', () => {
    expect(commentStamp('2026-10-25T12:04:11Z')).toMatch(/^25\.10, \d{2}:\d{2}$/u);
    expect(commentStamp('not a date')).toBe('not a date');
    expect(anchorCopy(comment())).toBeNull();
    expect(
      anchorCopy(
        comment({
          anchor: { blockId: 'ch08#1', blockIndex: 0, quote: 'П'.repeat(200), prefix: null, suffix: null, resolved: true },
        }),
      ),
    ).toHaveLength(90);
    expect(
      anchorCopy(
        comment({
          anchor: { blockId: 'ch08#1', blockIndex: 0, quote: 'старое', prefix: null, suffix: null, resolved: false },
        }),
      ),
    ).toBe('абзац изменился');
  });
});
