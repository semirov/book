import { describe, expect, it } from 'vitest';

import {
  buildDenylistIndex,
  compilePatterns,
  findDenylisted,
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
    expect(findDenylisted('Снег лежал до утра. Потом вошёл Матвей.', index)).toEqual([]);
  });

  it('returns the offset of the word, not of the boundary', () => {
    const hits = findDenylisted('и Толстой', index);
    expect(hits[0]).toMatchObject({ word: 'Толстой', offset: 2 });
  });
});

describe('compilePatterns', () => {
  it('compiles valid sources case-insensitively and reports broken ones', () => {
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
