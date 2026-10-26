import { describe, expect, it } from 'vitest';

import {
  ABOUT_MAX_CHARS,
  ABOUT_MIN_CHARS,
  TITLE_MAX_CHARS,
  countChars,
  foldRu,
  hasMarkdown,
  lineAt,
  manuscriptChapterFile,
  normalizeText,
  parseFrontMatter,
  parseTitleLine,
  splitBlocks,
  stemRu,
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
    expect(manuscriptChapterFile('00-front.md')).toBeNull();
    expect(manuscriptChapterFile('ch08.txt')).toBeNull();
  });
});

describe('hasMarkdown', () => {
  it('sees headings, links and footnotes', () => {
    expect(hasMarkdown('## Вторник')).toBe(true);
    expect(hasMarkdown('текст [ссылка](https://example.org)')).toBe(true);
    expect(hasMarkdown('текст[^1]')).toBe(true);
  });

  it('does not see an ordinary number sign inside a word', () => {
    expect(hasMarkdown('дом № 5 и #1 во дворе')).toBe(false);
  });
});

describe('parseTitleLine', () => {
  it('takes line 1 as the title and the rest as the body', () => {
    const parsed = parseTitleLine('Половик в тамбуре\n\nПервый абзац.\n\nВторой.');
    expect(parsed.title).toBe('Половик в тамбуре');
    expect(parsed.problems).toEqual([]);
    expect(splitBlocks(parsed.body)).toEqual(['Первый абзац.', 'Второй.']);
  });

  it('normalizes CRLF and trailing whitespace before reading line 1', () => {
    const parsed = parseTitleLine('  Половик в тамбуре  \r\n\r\nТекст.');
    expect(parsed.title).toBe('Половик в тамбуре');
  });

  it('reports a missing title and gives null', () => {
    const parsed = parseTitleLine('');
    expect(parsed.title).toBeNull();
    expect(parsed.problems).toContain('title line is missing');
  });

  it('rejects a title longer than the limit', () => {
    const parsed = parseTitleLine('я'.repeat(TITLE_MAX_CHARS + 1) + '\n\nТекст.');
    expect(parsed.title).toBeNull();
    expect(parsed.problems.join(' ')).toContain(`${TITLE_MAX_CHARS + 1} characters`);
  });

  it('accepts a title exactly at the limit', () => {
    const parsed = parseTitleLine('я'.repeat(TITLE_MAX_CHARS) + '\n\nТекст.');
    expect(parsed.title).toHaveLength(TITLE_MAX_CHARS);
    expect(parsed.problems).toEqual([]);
  });

  it('rejects markdown and a trailing colon', () => {
    expect(parseTitleLine('## Половик\n\nТекст.').problems).toContain('title contains markdown');
    expect(parseTitleLine('Половик:\n\nТекст.').problems).toContain('title ends with a colon');
  });

  it('requires line 2 to be blank', () => {
    const parsed = parseTitleLine('Половик\nПервый абзац без пустой строки.');
    expect(parsed.title).toBeNull();
    expect(parsed.problems).toContain('line 2 must be blank');
  });

  it('accepts a title-only file: the prose is simply empty', () => {
    const parsed = parseTitleLine('Половик в тамбуре');
    expect(parsed.title).toBe('Половик в тамбуре');
    expect(splitBlocks(parsed.body)).toEqual([]);
  });
});

const ABOUT =
  'Книга о том, как вещи научились обходиться без тех, кто их завёл. В ней нет героев — есть смены, ' +
  'заявки, очереди и бумаги, которые пережили своих составителей. Земля в ней больше не кормит: её ' +
  'обслуживают. Поля стали участками, участки — строками в реестре, реестр — тем, что закрывают само, ' +
  'без человека. Конец у этой книги один, и он не спрятан: шестьдесят семь глав пишутся в открытую.';

describe('parseFrontMatter', () => {
  it('reads the live title and the annotation', () => {
    const parsed = parseFrontMatter(`Земля, которая больше не кормит\n\n${ABOUT}`);
    expect(parsed.title).toBe('Земля, которая больше не кормит');
    expect(parsed.about).toBe(ABOUT);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.chars).toBe(ABOUT.length);
    expect(parsed.problems).toEqual([]);
    expect(parsed.chars).toBeGreaterThanOrEqual(ABOUT_MIN_CHARS);
    expect(parsed.chars).toBeLessThanOrEqual(ABOUT_MAX_CHARS);
  });

  it('keeps the title when only the annotation is malformed', () => {
    const parsed = parseFrontMatter('Земля\n\nСлишком короткая аннотация.');
    expect(parsed.title).toBe('Земля');
    expect(parsed.about).toBeNull();
    expect(parsed.problems.join(' ')).toContain('expected 300–900');
  });

  it('rejects an annotation above 900 characters', () => {
    const parsed = parseFrontMatter(`Земля\n\n${'я'.repeat(ABOUT_MAX_CHARS + 1)}`);
    expect(parsed.about).toBeNull();
    expect(parsed.problems.join(' ')).toContain(`${ABOUT_MAX_CHARS + 1} characters`);
  });

  it('rejects more than four annotation blocks', () => {
    const block = 'а'.repeat(100);
    const parsed = parseFrontMatter(`Земля\n\n${[block, block, block, block, block].join('\n\n')}`);
    expect(parsed.about).toBeNull();
    expect(parsed.problems.join(' ')).toContain('5 blocks');
  });

  it('rejects markdown in the annotation', () => {
    const parsed = parseFrontMatter(`Земля\n\n${ABOUT}\n\n[ссылка](https://example.org)`);
    expect(parsed.problems).toContain('annotation contains markdown');
  });

  it('requires a blank line 2 and a non-empty title', () => {
    expect(parseFrontMatter(`Земля\n${ABOUT}`).problems).toContain('line 2 must be blank');
    expect(parseFrontMatter(`\n\n${ABOUT}`).problems).toContain('title line is missing');
  });

  it('reports an empty file as missing title and annotation', () => {
    const parsed = parseFrontMatter('');
    expect(parsed.title).toBeNull();
    expect(parsed.about).toBeNull();
    expect(parsed.problems).toContain('title line is missing');
    expect(parsed.problems.join(' ')).toContain('0 blocks');
  });
});
