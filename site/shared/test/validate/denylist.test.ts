import { describe, expect, it } from 'vitest';

import {
  buildDenylistIndex,
  buildNameIndex,
  compilePatterns,
  findDenylisted,
  findDenylistedNames,
  findPatternHits,
  matchesDenylist,
} from '../../src/validate/index.ts';

const index = buildDenylistIndex(['Лев Толстой', 'Гарри Поттер', 'Советская']);

describe('matchesDenylist', () => {
  it('matches an entry through its case forms', () => {
    for (const form of ['Толстой', 'Толстого', 'Толстому', 'Толстым']) {
      expect(matchesDenylist(form, index)).toBe(true);
    }
  });

  it('indexes every word of a multi-word entry', () => {
    expect(matchesDenylist('Поттер', index)).toBe(true);
    expect(matchesDenylist('Гарри', index)).toBe(true);
  });

  it('does not match an invented name', () => {
    expect(matchesDenylist('Матвей', index)).toBe(false);
    expect(matchesDenylist('Кораблёв', index)).toBe(false);
  });
});

describe('findDenylisted', () => {
  it('reports a denylisted name anywhere, including the start of a sentence', () => {
    const hits = findDenylisted('Толстой вошёл. Потом заговорил Поттер.', index);
    expect(hits.map((hit) => hit.word)).toEqual(['Толстой', 'Поттер']);
    expect(hits[0]?.offset).toBe(0);
  });

  it('stays quiet on ordinary capitalized words', () => {
    expect(findDenylisted('Служебная строка. Потом вошёл Матвей.', index)).toEqual([]);
  });

  it('returns the offset of the word, not of the boundary', () => {
    const hits = findDenylisted('и Толстой', index);
    expect(hits[0]).toMatchObject({ word: 'Толстой', offset: 2 });
  });
});

describe('findDenylistedNames — a person matches only as a complete name', () => {
  const names = buildNameIndex(['Александр Лукашенко', 'Гарри Поттер']);

  it('catches the exact full name', () => {
    const hits = findDenylistedNames('Вчера Александр Лукашенко приехал в район на две минуты.', names);
    expect(hits.map((hit) => hit.word)).toEqual(['Александр Лукашенко']);
    expect(hits[0]?.offset).toBe(6);
  });

  it('does not catch a first name that starts a longer, different name', () => {
    expect(findDenylistedNames('Пришла Александра Фёдоровна и вымыла пол.', names)).toEqual([]);
  });

  it('does not catch one token of a multi-word entry', () => {
    expect(findDenylistedNames('Потом вошёл Александр и сел.', names)).toEqual([]);
    expect(findDenylistedNames('Он заговорил о Поттере и замолчал.', names)).toEqual([]);
  });

  it('does not catch a longer word that only starts with an entry', () => {
    expect(findDenylistedNames('Деревня Александровка стоит у реки.', buildNameIndex(['Александр']))).toEqual([]);
  });

  it('catches the name when a patronymic follows it', () => {
    const hits = findDenylistedNames('Александр Лукашенко Викторович вошёл в кабинет.', buildNameIndex(['Александр Лукашенко']));
    expect(hits.map((hit) => hit.word)).toEqual(['Александр Лукашенко']);
  });

  it('covers the case forms of every token', () => {
    const hits = findDenylistedNames('Он говорил об Александре Лукашенко.', names);
    expect(hits.map((hit) => hit.word)).toEqual(['Александре Лукашенко']);
  });

  it('keeps two names in one sentence apart', () => {
    expect(findDenylistedNames('Гарри Поттер, Александр Лукашенко и другие.', names)).toHaveLength(2);
  });

  it('drops an entry that has no tokens at all', () => {
    expect(buildNameIndex([' — ', '']).entries).toEqual([]);
  });
});

describe('compilePatterns', () => {  it('compiles valid sources case-insensitively and reports broken ones', () => {
    const compiled = compilePatterns(['экстремизм', '[broken']);
    expect(compiled.regexes).toHaveLength(1);
    expect(compiled.regexes[0]?.flags).toContain('i');
    expect(compiled.problems).toEqual(['pattern #2 is not a valid regular expression']);
  });
});

describe('findPatternHits', () => {
  it('finds every match with its offset and returns nothing when the pattern is absent', () => {
    const { regexes } = compilePatterns(['экстремизм']);
    expect(findPatternHits('Экстремизм и снова экстремизм.', regexes)).toHaveLength(2);
    expect(findPatternHits('обычный текст', regexes)).toEqual([]);
  });
});
