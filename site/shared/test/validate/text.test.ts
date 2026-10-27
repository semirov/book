import { describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '../../src/book.ts';
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
  parseChapterTitle,
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
    expect(stemRu('Тестова')).toBe(stemRu('Тестовой'));
    expect(stemRu('Тестова')).toBe(stemRu('Тестову'));
  });

  it('collapses a surname across endings', () => {
    expect(stemRu('Тестовский')).toBe(stemRu('Тестовских'));
    expect(stemRu('Тестовна')).toBe(stemRu('Тестовну'));
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
    const parsed = parseTitleLine('Тестовая глава\n\nПервый абзац.\n\nВторой.');
    expect(parsed.title).toBe('Тестовая глава');
    expect(parsed.problems).toEqual([]);
    expect(splitBlocks(parsed.body)).toEqual(['Первый абзац.', 'Второй.']);
  });

  it('normalizes CRLF and trailing whitespace before reading line 1', () => {
    const parsed = parseTitleLine('  Тестовая глава  \r\n\r\nТекст.');
    expect(parsed.title).toBe('Тестовая глава');
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
    expect(parseTitleLine('## Тестовая запись\n\nТекст.').problems).toContain('title contains markdown');
    expect(parseTitleLine('Тестовая глава:\n\nТекст.').problems).toContain('title ends with a colon');
  });

  it('requires line 2 to be blank', () => {
    const parsed = parseTitleLine('Тестовая глава\nПервый абзац без пустой строки.');
    expect(parsed.title).toBeNull();
    expect(parsed.problems).toContain('line 2 must be blank');
  });

  it('accepts a title-only file: the prose is simply empty', () => {
    const parsed = parseTitleLine('Тестовая глава');
    expect(parsed.title).toBe('Тестовая глава');
    expect(splitBlocks(parsed.body)).toEqual([]);
  });
});

describe('parseChapterTitle — the frame line is prose, not a title (BOOK-32)', () => {
  it('reads a ch01 that opens on the frame followed by a blank line as untitled prose', () => {
    const parsed = parseChapterTitle(1, `${FRAME_FIRST_SENTENCE}\n\nСвет был включён до меня.`);
    expect(parsed.title).toBeNull();
    expect(parsed.problems).toEqual([]);
    expect(parsed.body).toBe(`${FRAME_FIRST_SENTENCE}\n\nСвет был включён до меня.`);
    expect(splitBlocks(parsed.body)).toEqual([FRAME_FIRST_SENTENCE, 'Свет был включён до меня.']);
  });

  it('keeps a real title above the frame', () => {
    const parsed = parseChapterTitle(1, `Глава\n\n${FRAME_FIRST_SENTENCE} Потом он сел.`);
    expect(parsed.title).toBe('Глава');
    expect(splitBlocks(parsed.body)).toEqual([`${FRAME_FIRST_SENTENCE} Потом он сел.`]);
  });

  it('reads prose that continues on the frame line as prose too', () => {
    const parsed = parseChapterTitle(1, `${FRAME_FIRST_SENTENCE} Я постоял и вышел.`);
    expect(parsed.title).toBeNull();
    expect(parsed.body).toBe(`${FRAME_FIRST_SENTENCE} Я постоял и вышел.`);
  });

  it('does not extend the exemption to a rewritten or shortened frame', () => {
    for (const line of ['Я вошёл в тёмную комнату. Её освещал яркий свет.', 'Я вошёл в пустую комнату.']) {
      const parsed = parseChapterTitle(1, `${line}\n\nСвет был включён до меня.`);
      expect(parsed.title).toBe(line);
      expect(parsed.body).toBe('\nСвет был включён до меня.');
    }
  });

  it('is per chapter: the same sentence is a title in ch67 and in a chapter without a frame', () => {
    expect(parseChapterTitle(67, `${FRAME_FIRST_SENTENCE}\n\nТекст.`).title).toBe(FRAME_FIRST_SENTENCE);
    expect(parseChapterTitle(8, `${FRAME_FIRST_SENTENCE}\n\nТекст.`).title).toBe(FRAME_FIRST_SENTENCE);
    expect(parseChapterTitle(67, `${FRAME_LAST_SENTENCE}\n\nТекст.`).title).toBeNull();
  });

  it('leaves every other file to parseTitleLine', () => {
    expect(parseChapterTitle(5, '')).toEqual(parseTitleLine(''));
    expect(parseChapterTitle(5, 'Глава:\n\nТекст.')).toEqual(parseTitleLine('Глава:\n\nТекст.'));
  });
});

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

describe('parseFrontMatter', () => {
  it('reads the live title and the annotation', () => {
    const parsed = parseFrontMatter(`Без названия\n\n${ABOUT}`);
    expect(parsed.title).toBe('Без названия');
    expect(parsed.about).toBe(ABOUT);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.chars).toBe(ABOUT.length);
    expect(parsed.problems).toEqual([]);
    expect(parsed.chars).toBeGreaterThanOrEqual(ABOUT_MIN_CHARS);
    expect(parsed.chars).toBeLessThanOrEqual(ABOUT_MAX_CHARS);
  });

  it('keeps the title when only the annotation is malformed', () => {
    const parsed = parseFrontMatter('Название\n\nСлишком короткая аннотация.');
    expect(parsed.title).toBe('Название');
    expect(parsed.about).toBeNull();
    expect(parsed.problems.join(' ')).toContain(`expected ${ABOUT_MIN_CHARS}–${ABOUT_MAX_CHARS}`);
  });

  it('rejects an annotation above the character limit', () => {
    const parsed = parseFrontMatter(`Название\n\n${'я'.repeat(ABOUT_MAX_CHARS + 1)}`);
    expect(parsed.about).toBeNull();
    expect(parsed.problems.join(' ')).toContain(`${ABOUT_MAX_CHARS + 1} characters`);
  });

  it('rejects more than the block limit', () => {
    const block = 'а'.repeat(100);
    const blocks = Array.from({ length: 13 }, () => block);
    const parsed = parseFrontMatter(`Название\n\n${blocks.join('\n\n')}`);
    expect(parsed.about).toBeNull();
    expect(parsed.problems.join(' ')).toContain('13 blocks');
  });

  it('accepts the block limit itself: twelve paragraphs are valid', () => {
    const block = 'а'.repeat(100);
    const blocks = Array.from({ length: 12 }, () => block);
    const parsed = parseFrontMatter(`Название\n\n${blocks.join('\n\n')}`);
    expect(parsed.problems).toEqual([]);
    expect(parsed.blocks).toHaveLength(12);
  });

  it('rejects markdown in the annotation', () => {
    const parsed = parseFrontMatter(`Название\n\n${ABOUT}\n\n[ссылка](https://example.org)`);
    expect(parsed.problems).toContain('annotation contains markdown');
  });

  it('requires a blank line 2 and a non-empty title', () => {
    expect(parseFrontMatter(`Название\n${ABOUT}`).problems).toContain('line 2 must be blank');
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
