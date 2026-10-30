// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { arrivalRuns, changedLines, measure } from './theatreLines.ts';

/**
 * BOOK-227 / BOOK-DOC-86 §9.13 — the sentence's geometry, read once.
 *
 * jsdom lays nothing out, so the boxes are injected: the paragraph's box, the paragraph's line
 * height, one rect per word and the sentence's own fragments. What this proves is what the reading
 * may never get wrong: **a line is a line, not a fragment** (Chrome hands back several rects for one
 * line box when a word is hyphenated at the break), and **the run is the sentence's own text** — the
 * `[data-s]` span also holds the filing's numeral and note, and with history off the text has no
 * `.sentence-door` wrapper to hide them behind.
 */

const LINE = 27.2;
const SENTENCE = 'Комната стояла в конце коридора и дверь была открыта';
const WORDS = SENTENCE.split(' ');
const PER = 5;

const rect = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  container.innerHTML = `<p class="p"><span data-s="0"><span class="sentence-door">${SENTENCE}</span><span class="theatre"></span></span></p>`;
  document.body.append(container);
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('p') ? document.body : (this.parentElement?.closest('.p') ?? null);
    },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('p')) return rect(0, 0, 342, 2 * LINE);
    // The baseline probe: an empty inline-block on the last line.
    if (this instanceof HTMLElement && this.style.cssText.includes('vertical-align: baseline')) {
      return { ...rect(0, 0, 0, 0), bottom: LINE + 22 } as DOMRect;
    }
    return rect(0, 0, 0, 0);
  });
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: `${String(LINE)}px` } as CSSStyleDeclaration);
  // Two lines, the first handed back twice at the same top: a hyphenated word at the break.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      if (this.toString() !== SENTENCE) return [] as unknown as DOMRectList;
      return [rect(0, 0, 160, LINE), rect(0, 160, 140, LINE), rect(LINE, 0, 400, LINE)] as unknown as DOMRectList;
    },
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      const index = WORDS.indexOf(this.toString());
      if (index < 0) return rect(0, 0, 0, 0);
      return rect(index < PER ? 0 : LINE, 4 + (index % PER) * 40, 40, LINE);
    },
  });
});

afterEach(() => {
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  delete (Range.prototype as unknown as Record<string, unknown>).getClientRects;
  delete (Range.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
});

describe('BOOK-227 — the sentence measured once', () => {
  it('counts line boxes, not fragments: a split rect cannot shift the rule', () => {
    const host = container?.querySelector<HTMLElement>('.theatre') ?? null;
    const geometry = measure(host);
    expect(geometry).not.toBeNull();
    // One rule per line box, and the second one stands a line below the first.
    expect(geometry?.lines).toHaveLength(2);
    expect(geometry?.lines[1]?.top).toBe(LINE);
    expect(geometry?.lines[1]?.width).toBe(400);
    // The sixth word leads the second line, and its rule is the second line's baseline + 4.
    expect(geometry?.words[5]?.line).toBe(1);
    expect(geometry?.ruleTops[0]).toBeCloseTo(26, 6);
    expect(geometry?.ruleTops[1]).toBeCloseTo(26 + LINE, 6);
  });

  it('a word hyphenated at the break ends on the next line, not in a union box', () => {
    // The last word is handed back as two fragments: the head on line one, the tail on line two.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        if (this.toString() === WORDS.at(-1)) return [rect(0, 300, 60, LINE), rect(LINE, 0, 40, LINE)] as unknown as DOMRectList;
        if (this.toString() === SENTENCE) return [rect(0, 0, 160, LINE), rect(0, 160, 140, LINE), rect(LINE, 0, 400, LINE)] as unknown as DOMRectList;
        return [] as unknown as DOMRectList;
      },
    });
    const host = container?.querySelector<HTMLElement>('.theatre') ?? null;
    const geometry = measure(host);
    const word = geometry?.words.at(-1);
    // The press stands where the word starts; the rule's end is where the word ends.
    expect(word?.width).toBe(60);
    expect(word?.line).toBe(0);
    expect(word?.right).toBe(40);
    expect(word?.endLine).toBe(1);
  });

  it('history off: the run is the sentence’s own text, never the margin’s', () => {
    // The shipped shape with `roving` false: an unclassed wrapper for the text, then the numeral
    // and the note inside the same `[data-s]` span. Measuring the span would take all four.
    if (container === null) throw new Error('no container');
    container.innerHTML = `<p class="p"><span data-s="0" data-quote="${SENTENCE}"><span>${SENTENCE}</span><span class="theatre"></span><span class="filing-mark filing-alive ink-live"><span class="filing-mark-num">№A7K</span></span><button type="button" class="margin-note"><span class="margin-note-word">идёт</span><span class="margin-note-next">читает триаж</span></button></span></p>`;
    const host = container.querySelector<HTMLElement>('.theatre') ?? null;
    const geometry = measure(host);
    // The pen's words are the sentence's nine, not the numeral's and the note's as well.
    expect(geometry?.words).toHaveLength(WORDS.length);
    expect(geometry?.lines).toHaveLength(2);
    expect(geometry?.words.at(-1)?.right).toBe(4 + 3 * 40 + 40);
    // And every word's box stands on the sentence's own columns.
    expect(geometry?.words.every((word) => word.left >= 0 && word.left < 200)).toBe(true);
  });

  it('walks the visible words in reading order, line by line', () => {
    const host = container?.querySelector<HTMLElement>('.theatre') ?? null;
    const geometry = measure(host);
    if (geometry === null) throw new Error('the sentence was not measured');
    const { runs, visible } = arrivalRuns(geometry);
    expect(visible).toHaveLength(WORDS.length);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.first).toBe(0);
    expect(runs[1]?.first).toBe(PER);
    // Nine words, five to a line: the last four stand on the second one.
    expect(runs[1]?.words.map((word) => word.line)).toEqual([1, 1, 1, 1]);
  });
});

describe('BOOK-227 §9.5 — the changed lines, from the write’s span', () => {
  /** Two measured lines of three words each: the boxes the renderer already walks. */
  const words = [
    { left: 0, top: 0, width: 30, line: 0, right: 30, endLine: 0 },
    { left: 40, top: 0, width: 30, line: 0, right: 70, endLine: 0 },
    { left: 80, top: 0, width: 30, line: 0, right: 110, endLine: 0 },
    { left: 0, top: 27, width: 30, line: 1, right: 30, endLine: 1 },
    { left: 40, top: 27, width: 30, line: 1, right: 70, endLine: 1 },
    { left: 80, top: 27, width: 30, line: 1, right: 110, endLine: 1 },
  ];
  const TEXT = 'один два три четыре пять шесть';

  it('counts the lines the run’s own words stand on', () => {
    expect(changedLines(words, TEXT, 'два')).toBe(1);
    expect(changedLines(words, TEXT, 'четыре пять')).toBe(1);
    expect(changedLines(words, TEXT, 'три четыре')).toBe(2);
    expect(changedLines(words, TEXT, TEXT)).toBe(2);
  });

  it('answers null when the run cannot be placed, so the caller keeps the sentence’s lines', () => {
    expect(changedLines(words, TEXT, 'седьмой')).toBeNull();
    expect(changedLines(words, TEXT, '')).toBeNull();
    expect(changedLines(words, TEXT, null)).toBeNull();
    expect(changedLines([], TEXT, 'два')).toBeNull();
    expect(changedLines(words, '', 'два')).toBeNull();
  });
});
