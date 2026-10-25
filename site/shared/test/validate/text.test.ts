import { describe, expect, it } from 'vitest';

import {
  countChars,
  findWords,
  findPhrase,
  lineAt,
  manuscriptChapterFile,
  normalizeText,
  splitBlocks,
  stemRu,
  foldRu,
  FORBIDDEN_PROSE,
  PROCESS_PROSE,
} from '../../src/validate/index.ts';

describe('normalizeText', () => {
  it('turns CRLF into LF and drops trailing spaces', () => {
    expect(normalizeText('a  \r\nb\t\r\n')).toBe('a\nb\n');
  });

  it('keeps a lone CR safe', () => {
    expect(normalizeText('a\rb')).toBe('a\nb');
  });
});

describe('splitBlocks', () => {
  it('splits on blank lines, trims, drops empties', () => {
    expect(splitBlocks('one\n\ntwo\n\n\n  \nthree\n')).toEqual(['one', 'two', 'three']);
  });

  it('keeps inner newlines inside a paragraph', () => {
    expect(splitBlocks('line one\nline two\n\nsecond')).toEqual(['line one\nline two', 'second']);
  });

  it('returns nothing for an empty file', () => {
    expect(splitBlocks('')).toEqual([]);
    expect(splitBlocks('\n \n\t\n')).toEqual([]);
  });
});

describe('countChars', () => {
  it('counts spaces and drops separators, as the writing logs do', () => {
    expect(countChars(['ab cd', 'ef'])).toBe(7);
  });
});

describe('stemRu', () => {
  it('collapses the case forms of a first name', () => {
    expect(stemRu('Зоя')).toBe(stemRu('Зои'));
    expect(stemRu('Зоя')).toBe(stemRu('Зою'));
  });

  it('collapses a surname across endings', () => {
    expect(stemRu('Мельникова')).toBe(stemRu('Мельниковых'));
    expect(stemRu('Прокопьевна')).toBe(stemRu('Прокопьевну'));
  });

  it('folds ё and case', () => {
    expect(foldRu('Пётр')).toBe('петр');
  });
});

describe('findWords', () => {
  const find = (text: string, rule: (typeof FORBIDDEN_PROSE)[number]) => findWords(text, rule);

  it('matches a Cyrillic stem at a word start only', () => {
    const rule = FORBIDDEN_PROSE.find((item) => item.stem === 'цикл');
    expect(rule).toBeDefined();
    expect(find('начался цикл и циклы', rule!)).toHaveLength(2);
    expect(find('кислородный цикл', rule!)).toHaveLength(1);
  });

  it('does not over-match a short exact word', () => {
    const rule = FORBIDDEN_PROSE.find((item) => item.forms?.includes('бог'));
    expect(find('богатый двор', rule!)).toHaveLength(0);
    expect(find('бог и боги', rule!)).toHaveLength(2);
  });

  it('matches Latin process vocabulary case-insensitively', () => {
    const rule = PROCESS_PROSE.find((item) => item.latin === 'pass');
    expect(find('PASS и pass', rule!)).toHaveLength(2);
    expect(find('пассажир', rule!)).toHaveLength(0);
  });
});

describe('findPhrase', () => {
  it('is tolerant of case, ё and whitespace runs', () => {
    expect(findPhrase('РУКА  пошла\nи не дошла.', 'Рука пошла и не дошла')).toHaveLength(1);
  });

  it('finds every occurrence', () => {
    const text = 'рука пошла и не дошла, рука пошла и не дошла';
    expect(findPhrase(text, 'Рука пошла и не дошла')).toHaveLength(2);
  });
});

describe('lineAt', () => {
  it('counts 1-based lines', () => {
    const text = 'one\ntwo\nthree';
    expect(lineAt(text, 0)).toBe(1);
    expect(lineAt(text, 4)).toBe(2);
    expect(lineAt(text, 8)).toBe(3);
  });
});

describe('manuscriptChapterFile', () => {
  it('accepts chNN.md inside the range', () => {
    expect(manuscriptChapterFile('ch08.md')).toEqual({ n: 8 });
    expect(manuscriptChapterFile('ch67.md')).toEqual({ n: 67 });
  });

  it('reports a malformed chapter name', () => {
    expect(manuscriptChapterFile('ch1.md')).toEqual({ malformed: 'ch1.md' });
    expect(manuscriptChapterFile('ch001.md')).toEqual({ malformed: 'ch001.md' });
  });

  it('ignores files that are not chapter files at all', () => {
    expect(manuscriptChapterFile('PLAN.md')).toBeNull();
    expect(manuscriptChapterFile('ch08.txt')).toBeNull();
  });
});
