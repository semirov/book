import { describe, expect, it } from 'vitest';

import { charsPerLine, estimateChapterHeight } from './layout.ts';

/**
 * BOOK-88/BOOK-91 — the placeholder estimate follows the prose block of `styles/base.css`.
 *
 * The prose is `min(640, viewport − 2 × gut)` at ≥1024 and `min(622, …)` at ≤1023 (the same
 * 71 ch at 17.5 px as 640 at 18), at 18 / 17.5 / 17 px, with a 32 px gutter (24 px below 600).
 * `charsPerLine` is that width divided by half an em, rounded down, times a 0.94
 * haircut: it may never over-estimate a line, because an over-estimate under-reserves the
 * placeholder and a chapter's arrival shifts every chapter below it.
 */

const PROSE = [
  // viewport, gutter, measure, font — the prose block the sheets declare.
  [1440, 32, 640, 18],
  [1024, 32, 640, 18],
  [768, 32, 622, 17.5],
  [600, 32, 622, 17.5],
  [390, 24, 622, 17],
  [320, 24, 622, 17],
] as const;

const proseWidth = (viewport: number, gutter: number, measure: number): number =>
  Math.min(measure, viewport - 2 * gutter);

describe('charsPerLine', () => {
  it('follows the prose block of the design (BOOK-88/BOOK-91)', () => {
    // 640 px at 18 px → 66; 622 px at 17.5 px → 66; 342 px at 17 px → 37; 272 px → 30.
    expect(charsPerLine(1440)).toBe(66);
    expect(charsPerLine(768)).toBe(66);
    expect(charsPerLine(390)).toBe(37);
    expect(charsPerLine(320)).toBe(30);
  });

  it('pins every breakpoint and the band interiors', () => {
    // 1023/1024 is the prose step, 599/600 the type-and-gutter step, 359/360 the phone floor.
    expect([charsPerLine(1023), charsPerLine(1024)]).toEqual([66, 66]);
    expect([charsPerLine(599), charsPerLine(600)]).toEqual([60, 57]);
    expect([charsPerLine(359), charsPerLine(360)]).toEqual([34, 34]);
    expect([360, 390, 600, 647, 768, 1024, 1440].map(charsPerLine)).toEqual([34, 37, 57, 62, 66, 66, 66]);
  });

  it('never over-estimates a line in any band', () => {
    // The direction that matters: the model must sit at or below `width / (font / 2)`.
    // An over-estimate is what reserves too little and shifts the page when the text lands.
    for (const [viewport, gutter, measure, font] of PROSE) {
      const cap = Math.floor(proseWidth(viewport, gutter, measure) / (font / 2));
      expect(charsPerLine(viewport), `${viewport}px`).toBeLessThanOrEqual(cap);
    }
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

  it('over-reserves a real chapter against its rendered height', () => {
    // Chapter 1 is 9 343 characters; it renders at ~11 060 px at 390. The placeholder must
    // not be shorter than that, or the arriving prose moves everything below it.
    const estimate = estimateChapterHeight(9343, 390);
    expect(estimate).toBeGreaterThanOrEqual(11060);
    expect(estimate).toBeLessThan(12500);
  });

  it('reserves less room on a wider column', () => {
    expect(estimateChapterHeight(9343, 1440)).toBeLessThan(estimateChapterHeight(9343, 390));
  });

  it('grows with the chapter', () => {
    expect(estimateChapterHeight(16000, 390)).toBeGreaterThan(estimateChapterHeight(8000, 390));
  });
});
