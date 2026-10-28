/**
 * BOOK-174 §5 — the sentence a filing lands in.
 *
 * The report names «глава 12 · абзац 4 · предложение 2», so the locator answers one question:
 * does the quote lie inside exactly one sentence, and which one (0-based)? Every rule below is
 * the book's own typography — a quoted question, an initial, a decimal, an abbreviation.
 *
 * `shared/src/sentences.ts` (BOOK-182, PR #89) supersedes this locator; it exists on this base
 * only to fill the display/anchor slot.
 */

import { describe, expect, it } from 'vitest';

import { locateSentence, sentenceEnds } from '../../src/feedback/sentenceLocator.ts';

const TEXT =
  'Он вошёл в регистратуру. Там сидела женщина с бланком. Срок — тридцать дней. Он спросил: «Ты придёшь?» — и сел.';

describe('sentenceEnds', () => {
  it('ends a sentence on a terminator run and keeps the closing quotes with it', () => {
    expect(sentenceEnds('Он вошёл. Она села.')).toEqual([9, 19]);
    expect(sentenceEnds('Он спросил: «Ты придёшь?» — и сел.')).toEqual([25, 34]);
  });

  it('carries a bare closing quote with the sentence it closes', () => {
    // No terminator inside the quotes, so the `»` is read by the scan itself.
    expect(sentenceEnds('Он сказал «иди» и сел.')).toEqual([22]);
  });

  it('never splits inside «…»: a quoted question is one sentence', () => {
    const ends = sentenceEnds('Он сказал: «Иди! И не оглядывайся!» Потом ушёл.');
    expect(ends).toEqual([35, 47]);
  });

  it('does not end a sentence on an initial, a decimal or an abbreviation', () => {
    expect(sentenceEnds('Пришёл И. Иванов и сел.')).toEqual([23]);
    expect(sentenceEnds('Это было 12.03.2026 утром.')).toEqual([26]);
    expect(sentenceEnds('Бланки, справки и т. д. лежали рядом.')).toEqual([37]);
  });
});

describe('locateSentence', () => {
  it('names the sentence a quote lies in', () => {
    expect(locateSentence(TEXT, 'Там сидела женщина с бланком.')).toBe(1);
    expect(locateSentence(TEXT, 'Срок — тридцать дней.')).toBe(2);
    expect(locateSentence(TEXT, 'женщина')).toBe(1);
  });

  it('answers null when the quote spans two sentences', () => {
    expect(locateSentence(TEXT, 'Он вошёл в регистратуру. Там сидела женщина с бланком.')).toBeNull();
  });

  it('answers null when the quote is absent, the block is missing or the quote is empty', () => {
    expect(locateSentence(TEXT, 'Такого предложения здесь нет.')).toBeNull();
    expect(locateSentence(null, 'Он вошёл в регистратуру.')).toBeNull();
    expect(locateSentence(TEXT, '   ')).toBeNull();
  });

  it('keeps a quoted question whole', () => {
    expect(locateSentence(TEXT, '«Ты придёшь?»')).toBe(3);
  });
});
