import { describe, expect, it } from 'vitest';

import { COMMENT_QUOTE_MAX_CHARS } from '@book/shared';

import { anchorFor, clampQuote, firstWord, reanchorAnchor, seamKey, sentenceAt, splitSentences, wordAt } from './seam.ts';

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

const PARAGRAPH =
  'Я вошёл в пустую комнату. Её освещал яркий свет — тот самый, что бывает в марте. ' +
  'Он не спросил ничего: «кто здесь?» — и сел у окна (см. выше). Потом стало тихо.';

describe('splitSentences', () => {
  it('splits on full stops, question and exclamation marks', () => {
    expect(splitSentences(PARAGRAPH).map((sentence) => sentence.text)).toEqual([
      'Я вошёл в пустую комнату.',
      'Её освещал яркий свет — тот самый, что бывает в марте.',
      'Он не спросил ничего: «кто здесь?» — и сел у окна (см. выше).',
      'Потом стало тихо.',
    ]);
  });

  it('keeps abbreviations and initials inside one sentence', () => {
    expect(splitSentences('Пришли А. С. Пушкин и т. д. Потом все ушли.').map((s) => s.text)).toEqual([
      'Пришли А. С. Пушкин и т. д.',
      'Потом все ушли.',
    ]);
    expect(splitSentences('См. выше: 21.10.2026 и 1.5 метра. Дальше тишина.').map((s) => s.text)).toEqual([
      'См. выше: 21.10.2026 и 1.5 метра.',
      'Дальше тишина.',
    ]);
  });

  it('keeps an ellipsis and a quoted question as one sentence', () => {
    expect(splitSentences('Он молчал… Потом спросил: «вы здесь?» Она кивнула.').map((s) => s.text)).toEqual([
      'Он молчал…',
      'Потом спросил: «вы здесь?»',
      'Она кивнула.',
    ]);
  });

  it('does not split on an em dash or inside a hyphenated word', () => {
    const sentences = splitSentences('Кто-то пришёл — и сел. Никто не ждал.');
    expect(sentences.map((s) => s.text)).toEqual(['Кто-то пришёл — и сел.', 'Никто не ждал.']);
  });

  it('returns offsets into the paragraph, trimmed of the spaces around a sentence', () => {
    const text = '  Первое.  Второе.  ';
    const [, second] = splitSentences(text);
    expect(text.slice(second?.start, second?.end)).toBe('Второе.');
  });
});

describe('wordAt', () => {
  const text = 'Кто-то пришёл в пустую комнату.';

  it('names the word under the offset', () => {
    expect(wordAt(text, 1)?.text).toBe('Кто-то');
    expect(wordAt(text, 12)?.text).toBe('пришёл');
    expect(wordAt(text, text.indexOf('пустую'))?.text).toBe('пустую');
  });

  it('takes the nearest word from a gap or past the end', () => {
    expect(wordAt(text, 6)?.text).toBe('Кто-то');
    expect(wordAt(text, text.length + 4)?.text).toBe('комнату');
    expect(wordAt('   ', 1)).toBeNull();
  });

  it('keeps a soft-hyphenated word whole, without the break character', () => {
    expect(wordAt('осве\u00adщал яркий', 3)?.text).toBe('освещал');
  });
});

describe('sentenceAt', () => {
  it('finds the sentence holding the offset and the nearest one otherwise', () => {
    expect(sentenceAt(PARAGRAPH, PARAGRAPH.indexOf('марте'))?.text).toContain('марте');
    expect(sentenceAt(PARAGRAPH, -5)?.text).toBe('Я вошёл в пустую комнату.');
    expect(sentenceAt('', 0)).toBeNull();
  });
});

describe('clampQuote', () => {
  it('keeps a short sentence as it is, flattened', () => {
    expect(clampQuote(' a\n b ')).toBe('a\n b');
  });

  it('cuts a long sentence at a word, staying a substring of the paragraph', () => {
    const long = `${'слово '.repeat(80)}конец.`;
    const clamped = clampQuote(long);
    expect(clamped.length).toBeLessThanOrEqual(COMMENT_QUOTE_MAX_CHARS);
    // No ellipsis: the server resolves the anchor with `block.text.includes(quote)`.
    expect(long.includes(clamped)).toBe(true);
    expect(clamped.endsWith(' ')).toBe(false);
  });

  it('honours a smaller bound', () => {
    // 7 characters of «раз два три» is «раз два»; the trailing space goes with the cut.
    expect(clampQuote('раз два три', 7)).toBe('раз');
    expect('раз два три'.includes(clampQuote('раз два три', 7))).toBe(true);
    expect(clampQuote('раз два три', 8)).toBe('раз два');
  });
});

describe('anchorFor', () => {
  const text = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

  it('always carries block, quote and base revision, plus the affixes', () => {
    const anchor = anchorFor({ text, blockId: 'ch01#aa11bb22', baseRev: 3, offset: text.indexOf('комнату') });
    expect(anchor).toMatchObject({ blockId: 'ch01#aa11bb22', baseRev: 3, quote: 'Я вошёл в пустую комнату.' });
    expect(anchor?.prefix).toBe('');
    expect(anchor?.suffix.startsWith(' Её освещал')).toBe(true);
    expect(anchor?.word).toBe('комнату');
  });

  it('re-anchors a stale draft onto the sentence that exists now', () => {
    const previous = anchorFor({ text: TEXT, blockId: 'ch08#aa11bb22', baseRev: 3, offset: 0 });
    const moved = reanchorAnchor({
      text: 'Первый новый абзац. Я вошёл в пустую комнату. Её освещал яркий свет.',
      blockId: 'ch08#cc33dd44',
      baseRev: 4,
      previous,
    });
    expect(moved).toMatchObject({ blockId: 'ch08#cc33dd44', baseRev: 4, quote: 'Я вошёл в пустую комнату.' });
  });

  it('falls back to the nearest sentence, and has nothing for an empty paragraph', () => {
    const previous = anchorFor({ text: TEXT, blockId: 'ch08#aa11bb22', baseRev: 3, offset: 0 });
    const moved = reanchorAnchor({ text: 'Совсем другой текст.', blockId: 'ch08#cc33dd44', baseRev: 4, previous });
    expect(moved?.quote).toBe('Совсем другой текст.');
    expect(reanchorAnchor({ text: '   ', blockId: 'ch08#cc33dd44', baseRev: 4, previous })).toBeNull();
  });

  it('keys one seam by its chapter, block and sentence range', () => {
    const sentence = sentenceAt(TEXT, 0);
    expect(seamKey(1, 'ch01#aa11bb22', sentence!, 3)).toBe('ch1:ch01#aa11bb22:0-25@3');
    expect(seamKey(1, 'ch01#aa11bb22', sentence!)).toBe('ch1:ch01#aa11bb22:0-25@-');
  });

  it('clamps the quote and is null for an empty paragraph', () => {
    const long = `${'слово '.repeat(90)}конец.`;
    expect(anchorFor({ text: long, blockId: 'ch08#aa11bb22', baseRev: 1, offset: 0 })?.quote.length).toBeLessThanOrEqual(
      COMMENT_QUOTE_MAX_CHARS,
    );
    expect(anchorFor({ text: '', blockId: 'ch08#aa11bb22', baseRev: 1, offset: 0 })).toBeNull();
  });
});

describe('the first word of a stored quote (BOOK-111)', () => {
  it('names the word a surface may explain when all it holds is the quoted sentence', () => {
    expect(firstWord('Её освещал яркий свет.')).toBe('Её');
    // Punctuation and quotes are not a word: the door would lead to nothing.
    expect(firstWord('«Я» вошёл в комнату.')).toBe('Я');
    expect(firstWord('   ')).toBeNull();
    expect(firstWord('')).toBeNull();
    expect(firstWord(null)).toBeNull();
  });
});
