import { describe, expect, it } from 'vitest';

import { buildCastIndex, castFromDossiers, findUnknownNames, isAllowedName } from '../../src/validate/index.ts';

const index = buildCastIndex(['Зоя', 'Прокопьевна', 'Мельникова', 'Мельников', 'ФАП', 'Советская']);

describe('isAllowedName', () => {
  it('accepts a nominative name and its case forms', () => {
    for (const form of ['Зоя', 'Зои', 'Зою', 'Зоей']) {
      expect(isAllowedName(form, index)).toBe(true);
    }
  });

  it('accepts a surname beyond the endings in the stemmer list', () => {
    expect(isAllowedName('Мельниковых', index)).toBe(true);
    expect(isAllowedName('Мельниковой', index)).toBe(true);
  });

  it('accepts an abbreviation and a street', () => {
    expect(isAllowedName('ФАП', index)).toBe(true);
    expect(isAllowedName('Советской', index)).toBe(true);
  });

  it('rejects an unrelated name', () => {
    expect(isAllowedName('Матвей', index)).toBe(false);
    expect(isAllowedName('Кораблёв', index)).toBe(false);
  });
});

describe('findUnknownNames', () => {
  it('reports only mid-sentence capitals', () => {
    const hits = findUnknownNames('Инна пришла. Потом вошёл Матвей и сел.', index);
    expect(hits.map((hit) => hit.word)).toEqual(['Матвей']);
  });

  it('reports a name that opens a sentence when a second capital follows', () => {
    const hits = findUnknownNames('Матвей Кораблёв вошёл.', index);
    expect(hits.map((hit) => hit.word)).toEqual(['Матвей', 'Кораблёв']);
  });

  it('stays quiet on an ordinary sentence-initial capital', () => {
    expect(findUnknownNames('Снег лежал до утра.', index)).toEqual([]);
  });

  it('does not report allowlisted names in either position', () => {
    expect(findUnknownNames('Зоя Прокопьевна пришла.', index)).toEqual([]);
  });
});

describe('castFromDossiers', () => {
  it('reads the Имя: lines and splits them into parts', () => {
    const text = ['# Досье', '', 'Имя: Зоя Прокопьевна Мельникова. Возраст: 81.', 'Имя: Инна Аркадьевна Нестерова.'].join(
      '\n',
    );
    expect(castFromDossiers(text)).toEqual([
      'Аркадьевна',
      'Зоя',
      'Инна',
      'Мельникова',
      'Нестерова',
      'Прокопьевна',
    ]);
  });

  it('returns nothing when the file has no names', () => {
    expect(castFromDossiers('пусто')).toEqual([]);
  });
});
