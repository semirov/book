/**
 * The book model's two text rules that the ingest and the validator share (ARCHITECTURE §6C,
 * BOOK-6, owner 2026-10-28):
 *
 *   - **what a basis slot is**: an optional valid title line above *exactly* the frozen
 *     sentence, and nothing else. Not "starts with": a chapter that opens on the frame and
 *     writes on is written prose;
 *   - **what a contents row may print** when a chapter has no title: its first five words.
 *
 * One definition, two callers — a second reading of the same bytes is how the reader, the
 * `chars` count and F007/F022 came to disagree before.
 */

import { describe, expect, it } from 'vitest';

import {
  FRAME_FIRST_SENTENCE,
  FRAME_LAST_SENTENCE,
  isEmptySlot,
  isBasisOnly,
  openingOf,
  TOTAL_CHAPTERS,
} from '../src/book.ts';

const HEADING = 'Замечаний нет';

describe('a basis slot (BOOK-6, owner 2026-10-28)', () => {
  it('is a file that holds only its frozen sentence, with or without a heading above it', () => {
    for (const raw of [
      FRAME_FIRST_SENTENCE,
      `${FRAME_FIRST_SENTENCE}\n`,
      `${FRAME_FIRST_SENTENCE}\r\n`,
      `${HEADING}\n\n${FRAME_FIRST_SENTENCE}`,
      `${HEADING}\n\n${FRAME_FIRST_SENTENCE}\n`,
      `  ${HEADING}  \n\n  ${FRAME_FIRST_SENTENCE}  \n\n`,
    ]) {
      expect(isBasisOnly(1, raw), raw).toBe(true);
      expect(isEmptySlot(1, raw), raw).toBe(true);
    }
    // The finale reads the same way.
    expect(isBasisOnly(TOTAL_CHAPTERS, `${FRAME_LAST_SENTENCE}`)).toBe(true);
    expect(isBasisOnly(TOTAL_CHAPTERS, `Конец учёта\n\n${FRAME_LAST_SENTENCE}`)).toBe(true);
  });

  it('treats an absent or blank file as an empty slot, and a blank file is not a basis slot', () => {
    expect(isEmptySlot(1, '')).toBe(true);
    expect(isEmptySlot(1, '   \n\n')).toBe(true);
    expect(isBasisOnly(1, '')).toBe(false);
  });

  it('is not a basis slot when the frame is only the beginning — «starts with» is not the rule', () => {
    for (const raw of [
      `${FRAME_FIRST_SENTENCE}\n\nСвет был не для меня.`,
      `${FRAME_FIRST_SENTENCE} Я постоял и вышел.`,
      `${HEADING}\n\n${FRAME_FIRST_SENTENCE}\n\nСвет был не для меня.`,
    ]) {
      expect(isBasisOnly(1, raw), raw).toBe(false);
      expect(isEmptySlot(1, raw), raw).toBe(false);
    }
  });

  it('is not a basis slot when the heading itself is the frame or a malformed line', () => {
    // A ch42 that opens on its frame is malformed (F029) and its line is prose, not a heading.
    expect(isBasisOnly(TOTAL_CHAPTERS, `${FRAME_LAST_SENTENCE}\n\nОн сел у окна.`)).toBe(false);
    // A line 2 that is not blank is not a title line: the text below it is prose by the rule.
    expect(isBasisOnly(1, `${HEADING}\n${FRAME_FIRST_SENTENCE}`)).toBe(false);
  });

  it('is only for the two frame chapters: chapter 8 holding the sentence is a title line', () => {
    expect(isBasisOnly(8, FRAME_FIRST_SENTENCE)).toBe(false);
    expect(isEmptySlot(8, FRAME_FIRST_SENTENCE)).toBe(false);
  });
});

describe('openingOf — the contents’ excerpt (owner 2026-10-28)', () => {
  it('is the first five words of the prose, with an ellipsis when it goes on', () => {
    expect(openingOf('Свет был не для меня. Он был для камеры.')).toBe('Свет был не для меня.…');
    expect(openingOf('Я вошёл в пустую комнату. Её освещал яркий свет.')).toBe('Я вошёл в пустую комнату.…');
  });

  it('keeps a short opening whole — no ellipsis for a sentence that ends inside five words', () => {
    expect(openingOf('Свет погас.')).toBe('Свет погас.');
    expect(openingOf('Я вошёл в пустую комнату.')).toBe('Я вошёл в пустую комнату.');
  });

  it('is null for a slot with no text: a derived value, never an invented one', () => {
    expect(openingOf(null)).toBeNull();
    expect(openingOf(undefined)).toBeNull();
    expect(openingOf('')).toBeNull();
    expect(openingOf('   \n\n ')).toBeNull();
  });

  it('collapses whitespace: a rewrapped opening reads the same', () => {
    expect(openingOf('Свет  был\nне для меня.')).toBe('Свет был не для меня.');
  });
});
