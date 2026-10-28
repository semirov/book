import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { frameTextOf, isFrameParagraph } from './freeze.ts';

/**
 * BOOK-137 — the freeze is the sentence, not the chapter.
 *
 * The old test asserted the opposite (`isFrozenChapter(1) === true` for a *written* ch01), and
 * that claim is exactly what the owner met on the phone: his own prose answered «закреплено».
 */
describe('the frame is a sentence (BOOK-137)', () => {
  it('names the one canon sentence of ch01 and ch67, and no other chapter has one', () => {
    expect(frameTextOf(1)).toBe(FRAME_FIRST_SENTENCE);
    expect(frameTextOf(42)).toBe(FRAME_LAST_SENTENCE);
    expect(frameTextOf(2)).toBeNull();
    expect(frameTextOf(65)).toBeNull();
  });

  it('recognises the basis slot as the frame paragraph', () => {
    expect(isFrameParagraph(1, FRAME_FIRST_SENTENCE)).toBe(true);
    expect(isFrameParagraph(42, FRAME_LAST_SENTENCE)).toBe(true);
    // A rewrapped line is the same sentence: whitespace is not text.
    expect(isFrameParagraph(1, `  ${FRAME_FIRST_SENTENCE.replace(/ /gu, '\n')}  `)).toBe(true);
  });

  it('leaves a written ch01 body ordinary prose', () => {
    // The BOOK-32/BOOK-137 shape: the frame on line 1 and the author's own prose under it.
    expect(isFrameParagraph(1, `${FRAME_FIRST_SENTENCE} Я постоял и вышел.`)).toBe(false);
    expect(isFrameParagraph(1, 'Свет был включён до меня, и это было странно.')).toBe(false);
    expect(isFrameParagraph(1, '')).toBe(false);
  });

  it('never freezes a chapter whose text is not the sentence — ch65 included', () => {
    // Prod's own API has ch65 as `basis: false, written: true`; no path may close it.
    expect(isFrameParagraph(65, 'Свет был включён до меня, и это было странно.')).toBe(false);
    expect(isFrameParagraph(42, FRAME_FIRST_SENTENCE)).toBe(false);
    expect(isFrameParagraph(8, FRAME_LAST_SENTENCE)).toBe(false);
  });
});
