import { describe, expect, it } from 'vitest';

import {
  REPLACE_SIMILARITY,
  normalizeForSimilarity,
  pairBySimilarity,
  textSimilarity,
} from '../../src/history/similarity.ts';

const PARAGRAPH = 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.';

describe('paragraph similarity (§6F.3)', () => {
  it('is 1 for the same text modulo whitespace, case and punctuation', () => {
    expect(textSimilarity(PARAGRAPH, `  ${PARAGRAPH.toUpperCase()}  `)).toBe(1);
    expect(normalizeForSimilarity('Текст — стоит; здесь!')).toBe('текст стоит здесь');
  });

  it('is 0 for texts that share nothing', () => {
    expect(textSimilarity('Тестовая глава', 'Совсем другие слова здесь')).toBeLessThan(0.2);
  });

  it('is high for a rewritten sentence and low for a different one', () => {
    const rewritten = `${PARAGRAPH} Тестовый абзац номер два. Это служебный текст, он не является текстом книги.`;
    expect(textSimilarity(PARAGRAPH, rewritten)).toBeGreaterThan(REPLACE_SIMILARITY);
    expect(textSimilarity(PARAGRAPH, 'Совершенно другой служебный текст.')).toBeLessThan(
      REPLACE_SIMILARITY,
    );
  });

  it('handles empty and one-character texts without dividing by zero', () => {
    expect(textSimilarity('', '')).toBe(1);
    expect(textSimilarity('', 'а')).toBe(0);
    expect(textSimilarity('а', 'а')).toBe(1);
  });

  it('pairs exact paragraphs first, then by similarity, deterministically', () => {
    const before = [
      { text: 'Первый служебный абзац для проверки.', hash: 'aaa' },
      { text: 'Второй служебный абзац про очередь и счёт.', hash: 'bbb' },
      { text: 'Третий служебный абзац про датчик и бланк.', hash: 'ccc' },
    ];
    const after = [
      { text: 'Третий служебный абзац про датчик и бланк.', hash: 'ccc' },
      { text: 'Первый служебный абзац для проверки с дополнением.', hash: 'ddd' },
    ];
    const pairs = pairBySimilarity(before, after);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { oldIndex: 2, newIndex: 0, score: 1 },
        expect.objectContaining({ oldIndex: 0, newIndex: 1 }),
      ]),
    );
    // Stable across runs: the greedy order is score, then position.
    expect(pairBySimilarity(before, after)).toEqual(pairs);
    // Old 1 has no plausible counterpart above the threshold.
    expect(pairs.some((pair) => pair.oldIndex === 1)).toBe(false);
  });
});
