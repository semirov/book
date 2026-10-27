import { describe, expect, it } from 'vitest';

import type { CommentDto } from '@book/shared';

import { anchorCopy, CHIP_MAX_CHARS, commentStamp, commentStatusLine } from './commentView.ts';

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
    expect(commentStatusLine(comment({ status: 'new' })).state).toBe('ждёт рассмотрения');
    expect(commentStatusLine(comment({ status: 'accepted', changeId: 'chg_1', reason: 'принято' }))).toMatchObject({
      state: 'принято · правка в очереди',
      detail: 'принято',
      tone: 'live',
      form: 'sentence',
    });
    expect(
      commentStatusLine(comment({ status: 'applied', applied: { chapter: 8, rev: 3 }, reason: 'внесено' })).state,
    ).toBe('внесено в главу 08 · право на ваш текст перешло автору книги');
  });

  it('tells a premise’s four states without a queue place (BOOK-7)', () => {
    expect(commentStatusLine(comment({ premise: true, status: 'accepted', changeId: 'chg_1', reason: 'входит в книгу' }))).toEqual({
      state: 'принято в основу',
      detail: 'входит в книгу',
      tone: 'live',
      form: 'chip',
    });
    expect(
      commentStatusLine(
        comment({ premise: true, status: 'applied', chapter: 5, changeId: 'chg_1', reason: 'вошло в первую редакцию главы 5' }),
      ),
    ).toEqual({ state: 'вошло в первую редакцию главы 5', detail: null, tone: 'done', form: 'sentence' });
    expect(
      commentStatusLine(comment({ premise: true, status: 'superseded', reason: 'у главы уже есть замысел' })),
    ).toEqual({ state: 'замысел снят', detail: 'у главы уже есть замысел', tone: 'stopped', form: 'chip' });
    expect(commentStatusLine(comment({ premise: true, status: 'rejected', reason: 'не беру: не из этой сцены' }))).toEqual({
      state: 'замысел не взят',
      detail: 'не беру: не из этой сцены',
      tone: 'stopped',
      form: 'chip',
    });
  });

  it('decides the form of the line from its own text (BOOK-70)', () => {
    // A receipt names two things (the chapter and the right that moved with it): a sentence the
    // panel may wrap, not a one-line chip.
    const applied = commentStatusLine(comment({ status: 'applied', applied: { chapter: 7, rev: 2 }, reason: null }));
    expect(applied.form).toBe('sentence');
    expect(applied.state).toContain('внесено в главу 07');
    // Without the record of where it landed, the state is the one word — a chip.
    const bare = commentStatusLine(comment({ status: 'applied', applied: null, reason: null }));
    expect(bare).toMatchObject({ state: 'внесено', form: 'chip' });
    // A clause is a sentence even when it is short: the ` · ` and the `: ` are the clause's own
    // punctuation, and only a chip stays on one line without them.
    expect(commentStatusLine(comment({ status: 'accepted' })).form).toBe('sentence');
    expect(commentStatusLine(comment({ status: 'superseded' })).form).toBe('sentence');
    expect(commentStatusLine(comment({ status: 'expired' })).form).toBe('sentence');
    // Every other state is a chip, and the form is computed here — nowhere else.
    for (const status of ['new', 'batched', 'delivered', 'applied', 'rejected', 'quarantined', 'hidden'] as const) {
      const line = commentStatusLine(comment({ status }));
      expect(line.form, status).toBe('chip');
      expect(line.state.length, status).toBeLessThanOrEqual(CHIP_MAX_CHARS);
    }
  });

  it('says "not considered" instead of pretending', () => {
    expect(commentStatusLine(comment({ status: 'expired' })).state).toContain('не рассмотрено');
    expect(commentStatusLine(comment({ status: 'rejected', reason: 'вне рамок: форма книги' }))).toMatchObject({
      state: 'отклонено',
      detail: 'вне рамок: форма книги',
      tone: 'stopped',
      form: 'chip',
    });
    expect(commentStatusLine(comment({ status: 'quarantined' })).state).toBe('проверяется');
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
