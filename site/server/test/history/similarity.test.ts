import { describe, expect, it } from 'vitest';

import {
  REPLACE_SIMILARITY,
  normalizeForSimilarity,
  pairBySimilarity,
  textSimilarity,
} from '../../src/history/similarity.ts';

const PARAGRAPH = 'Половик в тамбуре намок насквозь ещё в четверг, и с тех пор его никто не поднимал.';

describe('paragraph similarity (§6F.3)', () => {
  it('is 1 for the same text modulo whitespace, case and punctuation', () => {
    expect(textSimilarity(PARAGRAPH, `  ${PARAGRAPH.toUpperCase()}  `)).toBe(1);
    expect(normalizeForSimilarity('Он — стоял; у окна!')).toBe('он стоял у окна');
  });

  it('is 0 for texts that share nothing', () => {
    expect(textSimilarity('Половик в тамбуре', 'Смена кончилась в шесть')).toBeLessThan(0.2);
  });

  it('is high for a rewritten sentence and low for a different one', () => {
    const rewritten = `${PARAGRAPH} След от колеса остался с ночи.`;
    expect(textSimilarity(PARAGRAPH, rewritten)).toBeGreaterThan(REPLACE_SIMILARITY);
    expect(textSimilarity(PARAGRAPH, 'Двор был пуст, доска лежала на двух кирпичах.')).toBeLessThan(
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
      { text: 'Абзац один про половик и след от колеса.', hash: 'aaa' },
      { text: 'Абзац два про смену и лампу в коридоре.', hash: 'bbb' },
      { text: 'Абзац три про бумаги, которые пережили составителей.', hash: 'ccc' },
    ];
    const after = [
      { text: 'Абзац три про бумаги, которые пережили составителей.', hash: 'ccc' },
      { text: 'Абзац один про половик, след от колеса и грязь.', hash: 'ddd' },
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
