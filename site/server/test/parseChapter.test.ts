import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { blockId, normalizeChapterText, normalizeForHash, parseChapter, splitChapterBlocks } from '../src/ingest/parseChapter.ts';

describe('normalizeChapterText', () => {
  it('removes CRLF and trailing whitespace', () => {
    expect(normalizeChapterText('one  \r\ntwo\t\r\n')).toBe('one\ntwo\n');
  });
});

describe('splitChapterBlocks', () => {
  it('splits on blank lines and drops empty blocks', () => {
    expect(splitChapterBlocks('a\n\nb\n\n\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('keeps inner line breaks', () => {
    expect(splitChapterBlocks('a\nb\n\nc')).toEqual(['a\nb', 'c']);
  });
});

describe('normalizeForHash', () => {
  it('ignores re-wrapping and runs of whitespace', () => {
    expect(normalizeForHash('  одна\n строка ')).toBe(normalizeForHash('одна строка'));
  });
});

describe('parseChapter', () => {
  it('parses an empty file into no title, no blocks and no characters', () => {
    const parsed = parseChapter(1, '');
    expect(parsed.title).toBeNull();
    expect(parsed.titleProblems).toContain('title line is missing');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.chars).toBe(0);
    expect(parsed.text).toBe('');
  });

  it('takes line 1 as the title and the rest as blocks', () => {
    const parsed = parseChapter(8, 'Тестовая глава\r\n\r\nПервый абзац.\r\n\r\nВторой абзац.\r\n');
    expect(parsed.title).toBe('Тестовая глава');
    expect(parsed.titleProblems).toEqual([]);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]).toMatchObject({ i: 0, text: 'Первый абзац.' });
    expect(parsed.blocks[1]).toMatchObject({ i: 1, text: 'Второй абзац.' });
    expect(parsed.blocks[0]?.id).toMatch(/^ch08#[0-9a-f]{8}$/u);
    expect(parsed.blocks[0]?.hash).toMatch(/^[0-9a-f]{8}$/u);
    expect(parsed.chars).toBe('Первый абзац.'.length + 'Второй абзац.'.length);
  });

  it('does not count the title line in chars', () => {
    const parsed = parseChapter(2, `${'я'.repeat(80)}\n\n${'а'.repeat(100)}`);
    expect(parsed.title).toHaveLength(80);
    expect(parsed.chars).toBe(100);
  });

  it('accepts a title-only file: an empty chapter in progress', () => {
    const parsed = parseChapter(3, 'Тестовая глава');
    expect(parsed.title).toBe('Тестовая глава');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.chars).toBe(0);
  });

  it('publishes a chapter without a title line and reports the problem (F022)', () => {
    const raw = 'Первый абзац без заголовка, и он длиннее восьмидесяти знаков, чтобы заголовком уже не считаться.\n\nВторой абзац.';
    const parsed = parseChapter(4, raw);
    expect(parsed.title).toBeNull();
    expect(parsed.titleProblems.length).toBeGreaterThan(0);
    // A malformed line 1 is prose, not a title: no text is lost from the reader's page.
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]?.text.startsWith('Первый абзац')).toBe(true);
  });

  it('derives ids from content, not from position', () => {
    const before = parseChapter(3, 'Заголовок.\n\nПервый.\n\nВторой.');
    const after = parseChapter(3, 'Заголовок.\n\nНулевой.\n\nПервый.\n\nВторой.');
    expect(after.blocks.map((block) => block.id).slice(1)).toEqual(before.blocks.map((block) => block.id));
  });

  it('suffixes identical paragraphs inside one chapter', () => {
    const parsed = parseChapter(2, 'Заголовок.\n\nОдно и то же.\n\nОдно и то же.\n\nДругое.');
    expect(parsed.blocks[0]?.id).toMatch(/^ch02#[0-9a-f]{8}$/u);
    expect(parsed.blocks[1]?.id).toMatch(/-2$/u);
    expect(parsed.blocks[2]?.id).not.toMatch(/-2$/u);
  });

  it('hashes the file as written, while a block hash ignores re-wrapping', () => {
    const a = parseChapter(4, 'Заголовок.\n\nСтрока одна\nстрока два');
    const b = parseChapter(4, 'Заголовок.\n\nСтрока одна строка два');
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.blocks[0]?.hash).toBe(b.blocks[0]?.hash);
  });

  it('builds duplicate-free ids for a book-sized chapter', () => {
    const paragraphs = Array.from({ length: 141 }, (_, index) => `Абзац номер ${index + 1}.`);
    const parsed = parseChapter(1, `Заголовок.\n\n${paragraphs.join('\n\n')}`);
    expect(parsed.blocks).toHaveLength(141);
    expect(new Set(parsed.blocks.map((block) => block.id)).size).toBe(141);
  });
});

describe('parseChapter — a slot that is exactly its basis sentence (BOOK-6)', () => {
  it('reads the frozen frame as one paragraph, not as a title line', () => {
    const parsed = parseChapter(1, FRAME_FIRST_SENTENCE);
    expect(parsed.basis).toBe(true);
    expect(parsed.title).toBeNull();
    expect(parsed.titleProblems).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]).toMatchObject({ i: 0, text: FRAME_FIRST_SENTENCE });
    expect(parsed.blocks[0]?.id).toMatch(/^ch01#[0-9a-f]{8}$/u);
    // The basis sentence is not written prose: the book counts no characters for it.
    expect(parsed.chars).toBe(0);
  });

  it('takes the closing sentence of the last chapter, with or without a trailing newline', () => {
    for (const raw of [FRAME_LAST_SENTENCE, `${FRAME_LAST_SENTENCE}\n`, `${FRAME_LAST_SENTENCE}\r\n`]) {
      const parsed = parseChapter(TOTAL_CHAPTERS, raw);
      expect(parsed.basis).toBe(true);
      expect(parsed.title).toBeNull();
      expect(parsed.blocks.map((block) => block.text)).toEqual([FRAME_LAST_SENTENCE]);
      expect(parsed.chars).toBe(0);
    }
  });

  it('keeps a changed word a normal file: the title line rule still applies (F029 catches it)', () => {
    const changed = `${FRAME_FIRST_SENTENCE.slice(0, -1)} ночь.`;
    const parsed = parseChapter(1, changed);
    expect(parsed.basis).toBe(false);
    // Line 1 is still a title candidate, and no paragraph is invented for it.
    expect(parsed.title).toBe(changed);
    expect(parsed.blocks).toEqual([]);
  });

  it('is only for the two frame chapters: the same sentence in chapter 8 is a title line', () => {
    const parsed = parseChapter(8, FRAME_FIRST_SENTENCE);
    expect(parsed.basis).toBe(false);
    expect(parsed.title).toBe(FRAME_FIRST_SENTENCE);
    expect(parsed.blocks).toEqual([]);
  });

  it('does not turn a written chapter that opens with the frame into a basis slot', () => {
    const parsed = parseChapter(1, `${FRAME_FIRST_SENTENCE}\n\n${'Первый абзац. '.repeat(20)}`);
    expect(parsed.basis).toBe(false);
    expect(parsed.blocks.length).toBe(1);
    expect(parsed.chars).toBeGreaterThan(0);
  });

  it('treats a whitespace-only re-save as the same projection: no new sha, no new block', () => {
    const bare = parseChapter(1, FRAME_FIRST_SENTENCE);
    for (const raw of [`${FRAME_FIRST_SENTENCE}\n`, `${FRAME_FIRST_SENTENCE}\r\n`, `  ${FRAME_FIRST_SENTENCE}  \n\n`]) {
      const saved = parseChapter(1, raw);
      // Whitespace is not identity: the projection must not be re-written for a trailing newline.
      expect(saved.sha256).toBe(bare.sha256);
      expect(saved.blocks).toEqual(bare.blocks);
    }
  });
});

describe('blockId', () => {
  it('pads the chapter number to two digits', () => {
    expect(blockId(7, 'x', 0)).toMatch(/^ch07#/u);
    expect(blockId(67, 'x', 0)).toMatch(/^ch67#/u);
  });

  it('adds a one-based duplicate suffix', () => {
    expect(blockId(7, 'x', 1)).toMatch(/-2$/u);
  });
});
