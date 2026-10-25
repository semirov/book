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
  it('parses an empty file into no blocks and no characters', () => {
    const parsed = parseChapter(1, '');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.chars).toBe(0);
    expect(parsed.text).toBe('');
  });

  it('parses one chapter with positions, hashes and ids', () => {
    const parsed = parseChapter(8, 'Первый абзац.\r\n\r\nВторой абзац.\r\n');
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]).toMatchObject({ i: 0, text: 'Первый абзац.' });
    expect(parsed.blocks[1]).toMatchObject({ i: 1, text: 'Второй абзац.' });
    expect(parsed.blocks[0]?.id).toMatch(/^ch08#[0-9a-f]{8}$/u);
    expect(parsed.blocks[0]?.hash).toMatch(/^[0-9a-f]{8}$/u);
    expect(parsed.chars).toBe('Первый абзац.'.length + 'Второй абзац.'.length);
  });

  it('derives ids from content, not from position', () => {
    const before = parseChapter(3, 'Первый.\n\nВторой.');
    const after = parseChapter(3, 'Нулевой.\n\nПервый.\n\nВторой.');
    expect(after.blocks.map((block) => block.id).slice(1)).toEqual(before.blocks.map((block) => block.id));
  });

  it('suffixes identical paragraphs inside one chapter', () => {
    const parsed = parseChapter(2, 'Одно и то же.\n\nОдно и то же.\n\nДругое.');
    expect(parsed.blocks[0]?.id).toMatch(/^ch02#[0-9a-f]{8}$/u);
    expect(parsed.blocks[1]?.id).toMatch(/-2$/u);
    expect(parsed.blocks[2]?.id).not.toMatch(/-2$/u);
  });

  it('hashes the file as written, while a block hash ignores re-wrapping', () => {
    const a = parseChapter(4, 'Строка одна\nстрока два');
    const b = parseChapter(4, 'Строка одна строка два');
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.blocks[0]?.hash).toBe(b.blocks[0]?.hash);
  });

  it('builds duplicate-free ids for a book-sized chapter', () => {
    const paragraphs = Array.from({ length: 141 }, (_, index) => `Абзац номер ${index + 1}.`);
    const parsed = parseChapter(1, paragraphs.join('\n\n'));
    expect(parsed.blocks).toHaveLength(141);
    expect(new Set(parsed.blocks.map((block) => block.id)).size).toBe(141);
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
