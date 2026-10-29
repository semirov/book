/**
 * The quote arithmetic (BOOK-185, BOOK-DOC-77 §3): the sentence around a quote, cut on form.
 */

import { describe, expect, it } from 'vitest';

import { dateProven, evidenceOf, locate, monthOf, sentenceAround, SENTENCE_LIMIT } from '../../src/graph/quote.ts';

describe('the sentence around a quote', () => {
  it('cuts on . ! ? … and stays inside the block', () => {
    const text = 'Первое. Второе! Третье? «Четвёртое…» Пятое.';
    expect(sentenceAround(text, text.indexOf('Третье'), text.indexOf('Третье') + 6)).toBe('Третье?');
    expect(sentenceAround(text, text.indexOf('Четвёртое'), text.indexOf('Четвёртое') + 9)).toBe('«Четвёртое…»');
    expect(sentenceAround(text, 0, 6)).toBe('Первое.');
  });

  it('keeps the quote inside the 280-character window', () => {
    const filler = 'слово '.repeat(80);
    const text = `${filler}Номер 65/11877/арх${filler}`;
    const start = text.indexOf('Номер');
    const sentence = sentenceAround(text, start, start + 18);
    expect(sentence).toContain('Номер 65/11877/арх');
    expect(Array.from(sentence).length).toBeLessThanOrEqual(280);
  });

  it('keeps a quote that is longer than the window: the sentence is cut from the witness', () => {
    // BOOK-185 defect 6: a window slid over a long quote dropped the witness it was supposed to
    // hold, and the row's reading aid then quoted text the mention did not cover.
    const witness = 'Длинная цитата без единой точки '.repeat(20).trim();
    expect(Array.from(witness).length).toBeGreaterThan(SENTENCE_LIMIT);
    const text = `Начало блока. ${witness} Хвост блока.`;
    const start = text.indexOf(witness);
    const sentence = sentenceAround(text, start, start + witness.length);
    expect(Array.from(sentence).length).toBeLessThanOrEqual(SENTENCE_LIMIT);
    expect(witness.startsWith(sentence)).toBe(true);
  });
});

describe('a date and a month word', () => {
  it('names the month of a word and refuses a word that names none', () => {
    expect(monthOf('сентября')).toBe(9);
    expect(monthOf('мая')).toBe(5);
    expect(monthOf('очередь')).toBeNull();
  });

  it('refuses a key it cannot parse as a date', () => {
    expect(dateProven('не-дата', '14.09.2065')).toBe(false);
  });
});

describe('the evidence of one quote', () => {
  const text = 'Акт датирован 14.09.2065 по делу. Печать на месте.';

  it('keeps the model sentence only when the block holds it verbatim', () => {
    const located = locate('14.09.2065', [{ id: 'b1', text }]);
    if (located === null) throw new Error('the quote is in the block');
    const kept = evidenceOf(located, 'Акт датирован 14.09.2065 по делу.');
    expect(kept.sentence).toBe('Акт датирован 14.09.2065 по делу.');
    expect(kept.statement).toBe('Акт датирован 14.09.2065 по делу.');
  });

  it('reads the row from the block, not from a model paraphrase that mentions the witness', () => {
    // BOOK-185 defect 7: a paraphrase became the row's reading although the chapter never said it.
    const located = locate('14.09.2065', [{ id: 'b1', text }]);
    if (located === null) throw new Error('the quote is in the block');
    const paraphrase = 'Акт был датирован 14.09.2065, и это важно.';
    const evidence = evidenceOf(located, paraphrase);
    expect(evidence.sentence).toBe('Акт датирован 14.09.2065 по делу.');
    expect(evidence.statement).toBe('Акт датирован 14.09.2065 по делу.');
    // The paraphrase is not a substring of the block, and it says something the block does not.
    expect(text.includes(paraphrase)).toBe(false);
  });
});
