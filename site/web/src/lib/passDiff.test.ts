import { describe, expect, it } from 'vitest';

import { passRunOf, passSpanOf } from './passDiff.ts';
import { graphemes } from './reveal.ts';

/**
 * BOOK-121 — the span a pass wrote, found at grapheme level.
 *
 * The cases the engine can never see: a span that splits a surrogate pair or strands a combining
 * mark would be timed as two characters and painted as one, so every edge here is a cluster.
 */

describe('passSpanOf', () => {
  it('finds a Cyrillic replacement whole, with the place it holds in the new text', () => {
    const span = passSpanOf('брод был тихим', 'старая река, и вот брод');
    expect(span).toEqual({
      before: 'брод был тихим',
      after: 'старая река, и вот брод',
      kind: 'replacement',
      offset: 0,
    });
  });

  it('keeps the settled prefix and suffix out of the span', () => {
    const span = passSpanOf('Он шёл по берегу', 'Он бежал по берегу');
    expect(span).toEqual({ before: 'шё', after: 'бежа', kind: 'replacement', offset: 3 });
    const run = passRunOf('Он бежал по берегу', span!);
    expect(run).toEqual({ prefix: 'Он ', run: 'бежа', suffix: 'л по берегу' });
  });

  it('treats spaces as graphemes: an inserted and a deleted space are their own spans', () => {
    expect(passSpanOf('дом у реки', 'дом  у реки')).toEqual({
      before: '',
      after: ' ',
      kind: 'insertion',
      offset: 4,
    });
    expect(passSpanOf('дом  у реки', 'дом у реки')).toEqual({
      before: ' ',
      after: '',
      kind: 'deletion',
      offset: 4,
    });
  });

  it('keeps a ZWJ family emoji one grapheme, not five code points and two joiners', () => {
    const span = passSpanOf('свет 👨‍👩‍👧', 'свет 👨‍👩‍👧‍👦');
    expect(graphemes('👨‍👩‍👧')).toHaveLength(1);
    expect(span).toEqual({ before: '👨‍👩‍👧', after: '👨‍👩‍👧‍👦', kind: 'replacement', offset: 5 });
  });

  it('keeps a flag one grapheme: changing it replaces one cluster, not two halves', () => {
    const span = passSpanOf('🇷🇺', '🇷🇸');
    expect(graphemes('🇷🇺')).toHaveLength(1);
    expect(span).toEqual({ before: '🇷🇺', after: '🇷🇸', kind: 'replacement', offset: 0 });
  });

  it('never strands a combining mark: a bare base is a whole cluster, so the span is one', () => {
    const span = passSpanOf('и\u0301', 'и');
    expect(graphemes('и\u0301')).toHaveLength(1);
    // A code-point diff would delete U+0301 alone and leave the base standing; a cluster diff
    // replaces the marked letter with the bare one.
    expect(span).toEqual({ before: 'и\u0301', after: 'и', kind: 'replacement', offset: 0 });
  });

  it('names a pure insertion and a pure deletion at either end of the text', () => {
    expect(passSpanOf('абв', 'абвг')).toEqual({ before: '', after: 'г', kind: 'insertion', offset: 3 });
    expect(passSpanOf('Xабв', 'абв')).toEqual({ before: 'X', after: '', kind: 'deletion', offset: 0 });
    expect(passSpanOf('абв', 'Xабв')).toEqual({ before: '', after: 'X', kind: 'insertion', offset: 0 });
    // A whole block out of nothing and into nothing: still one span, never a "replacement".
    expect(passSpanOf('', 'брод')).toEqual({ before: '', after: 'брод', kind: 'insertion', offset: 0 });
    expect(passSpanOf('брод', '')).toEqual({ before: 'брод', after: '', kind: 'deletion', offset: 0 });
  });

  it('never lets the common prefix and suffix overlap', () => {
    // Three identical graphemes against two: the tail is the deletion, not the start.
    expect(passSpanOf('ааа', 'аа')).toEqual({ before: 'а', after: '', kind: 'deletion', offset: 2 });
    expect(passSpanOf('аа', 'ааа')).toEqual({ before: '', after: 'а', kind: 'insertion', offset: 2 });
  });

  it('answers null when nothing changed — including two empty texts', () => {
    expect(passSpanOf('брод был тихим', 'брод был тихим')).toBeNull();
    expect(passSpanOf('', '')).toBeNull();
  });
});

describe('passRunOf', () => {
  const span = passSpanOf('Он шёл по берегу', 'Он бежал по берегу')!;

  it('cuts the final text around the run', () => {
    expect(passRunOf('Он бежал по берегу', span)).toEqual({
      prefix: 'Он ',
      run: 'бежа',
      suffix: 'л по берегу',
    });
  });

  it('cuts a deletion at the place the ghost stands, with no run of its own', () => {
    const gone = passSpanOf('шум реки затих', 'шум затих')!;
    expect(gone).toEqual({ before: 'реки ', after: '', kind: 'deletion', offset: 4 });
    expect(passRunOf('шум затих', gone)).toEqual({ prefix: 'шум ', run: '', suffix: 'затих' });
  });

  it('refuses a span that does not describe this text, instead of painting a guess', () => {
    expect(passRunOf('Он бежал по берегу.', span)).not.toBeNull();
    expect(passRunOf('Он шёл по берегу', span)).toBeNull();
    expect(passRunOf('Он бе', span)).toBeNull();
    expect(passRunOf('Он бежал по берегу', { ...span, offset: -1 })).toBeNull();
    expect(passRunOf('Он бежал по берегу', { ...span, offset: 1.5 })).toBeNull();
    expect(passRunOf('Он бежал по берегу', { ...span, offset: 12 })).toBeNull();
  });
});
