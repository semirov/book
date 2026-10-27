import { describe, expect, it } from 'vitest';

import { documentMoves, type ChapterTextChange } from '../../src/index/chronicle.ts';

const issued = (title: string): string => `${title}\n\nПриказ № 4 выдан утром.\n`;
const annulled = (title: string): string => `${title}\n\nПриказ № 4 отозван утром.\n`;

/** The three chapters a ripple rewrote, with one paper whose status moved in each. */
const THREE: ChapterTextChange[] = [
  { chapter: 44, before: issued('Сорок четвёртая'), after: annulled('Сорок четвёртая') },
  { chapter: 12, before: issued('Двенадцатая'), after: annulled('Двенадцатая') },
  { chapter: 19, before: issued('Девятнадцатая'), after: annulled('Девятнадцатая') },
];

describe('the document-status diff (BOOK-18 §3)', () => {
  it('turns three moved chapters into exactly one statement, in chapter order', () => {
    expect(documentMoves(THREE)).toEqual([
      { document: 'приказ № 4', surface: 'Приказ № 4', chapters: [12, 19, 44] },
    ]);
  });

  it('says nothing when the text touches no document status', () => {
    const unchanged: ChapterTextChange[] = [
      { chapter: 12, before: issued('Двенадцатая'), after: issued('Двенадцатая') },
      { chapter: 13, before: 'Тринадцатая\n\nКовалёв молчал.\n', after: 'Тринадцатая\n\nКовалёв молчал дольше.\n' },
    ];
    expect(documentMoves(unchanged)).toEqual([]);
    expect(documentMoves([])).toEqual([]);
  });

  it('says nothing for a chapter without a pre-image: no snapshot is not «everything appeared»', () => {
    expect(
      documentMoves([{ chapter: 2, before: null, after: annulled('Вторая') }]),
    ).toEqual([]);
    expect(
      documentMoves([{ chapter: 2, before: '   ', after: annulled('Вторая') }]),
    ).toEqual([]);
  });

  it('names every paper that moved, one entry each, and skips the generic «документ»', () => {
    const both: ChapterTextChange[] = [
      {
        chapter: 9,
        before: 'Девятая\n\nПриказ № 4 выдан. Справка выдана. Документ выдан.\n',
        after: 'Девятая\n\nПриказ № 4 отозван. Справка выдана. Документ отозван.\n',
      },
      { chapter: 10, before: 'Десятая\n\nСправка выдана.\n', after: 'Десятая\n\nСправка аннулирована.\n' },
    ];
    expect(documentMoves(both)).toEqual([
      { document: 'приказ № 4', surface: 'Приказ № 4', chapters: [9] },
      { document: 'справка', surface: 'Справка', chapters: [10] },
    ]);
  });

  it('counts a paper that the rewrite removed as a move, and one it introduced as well', () => {
    const changed: ChapterTextChange[] = [
      { chapter: 5, before: 'Пятая\n\nСправка выдана.\n', after: 'Пятая\n\nЗал был пуст.\n' },
      { chapter: 6, before: 'Шестая\n\nЗал был пуст.\n', after: 'Шестая\n\nПриказ № 7 выдан.\n' },
    ];
    expect(documentMoves(changed)).toEqual([
      { document: 'приказ № 7', surface: 'Приказ № 7', chapters: [6] },
      { document: 'справка', surface: 'Справка', chapters: [5] },
    ]);
  });

  it('keeps the statement to the paper and chapters: no entity and no gate word', () => {
    const text = JSON.stringify(documentMoves(THREE));
    expect(text).toContain('Приказ № 4');
    expect(text).not.toContain('Ковалёв');
    expect(text).not.toMatch(/editor|consultant|blocker|замечание/u);
  });
});
