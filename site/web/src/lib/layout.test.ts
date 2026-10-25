import { describe, expect, it } from 'vitest';

import { charsPerLine, estimateChapterHeight } from './layout.ts';

describe('charsPerLine', () => {
  it('follows the measure of the design', () => {
    expect(charsPerLine(320)).toBe(30);
    expect(charsPerLine(390)).toBe(34);
    expect(charsPerLine(768)).toBe(56);
    expect(charsPerLine(1440)).toBe(60);
  });
});

describe('estimateChapterHeight', () => {
  it('is zero for an empty chapter', () => {
    expect(estimateChapterHeight(0, 390)).toBe(0);
    expect(estimateChapterHeight(Number.NaN, 390)).toBe(0);
  });

  it('reserves at least a paragraph', () => {
    expect(estimateChapterHeight(10, 390)).toBeGreaterThanOrEqual(120);
  });

  it('is close to the rendered height of a real chapter', () => {
    // The measured height of chapter 1 (9 343 characters) at 390 px is ~11 060 px.
    const estimate = estimateChapterHeight(9343, 390);
    expect(estimate).toBeGreaterThan(9000);
    expect(estimate).toBeLessThan(12500);
  });

  it('reserves less room on a wider column', () => {
    expect(estimateChapterHeight(9343, 1440)).toBeLessThan(estimateChapterHeight(9343, 390));
  });

  it('grows with the chapter', () => {
    expect(estimateChapterHeight(16000, 390)).toBeGreaterThan(estimateChapterHeight(8000, 390));
  });
});
