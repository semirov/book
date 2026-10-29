// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { attachMarginPass, runMarginPass, scheduleMarginPass } from './marginPass.ts';

/**
 * BOOK-90 §1.10 / AC3 — the DOM half of the pass.
 *
 * jsdom has no layout, so the boxes are supplied: every note is a child of a sentence span,
 * its paragraph is the offset parent, and the tail sits after the flow. What is proven here
 * is what the browser would do with those numbers — the top written through CSSOM (never a
 * `style` attribute in React markup), `data-placed` only after the top is written, and the
 * tail growing by the residual.
 *
 * BOOK-128 comment #3815 — the margin now also carries the word's record and the phrase's
 * facts. Both are ordinary items of the ledger when they are positioned, and neither is an item
 * at all when it is in flow (the phone's body under the strip): a `top` there would lift the
 * block out of the paragraph it belongs to.
 */

function box(top: number, height: number): DOMRect {
  return new DOMRect(0, top, 188, height);
}

type Fixture = { sentence: HTMLElement; note: HTMLElement; paragraph: HTMLElement };

function fixture(anchorTop: number, height: number, id: string): Fixture {
  const paragraph = document.createElement('p');
  paragraph.className = 'p';
  const sentence = document.createElement('span');
  sentence.setAttribute('data-s', '0');
  const note = document.createElement('button');
  note.className = 'margin-note';
  note.setAttribute('data-margin-item', 'note');
  note.setAttribute('data-id', id);
  // The sheet makes a margin item absolute at ≥1024; jsdom loads no sheet, so the fixture says
  // what the browser computes — anything else is in flow and is not an item of the pass.
  note.style.position = 'absolute';
  sentence.append(note);
  paragraph.append(sentence);
  document.body.append(paragraph);
  Object.defineProperty(note, 'offsetParent', { configurable: true, get: () => paragraph });
  Object.defineProperty(sentence, 'offsetTop', { configurable: true, get: () => anchorTop });
  Object.defineProperty(paragraph, 'offsetTop', { configurable: true, get: () => 0 });
  note.getBoundingClientRect = () => box(anchorTop, height);
  sentence.getBoundingClientRect = () => box(anchorTop, height);
  // The paragraph sits 50 px down the viewport: `top` is written against its padding box, so
  // every placed top must be offset by it exactly once.
  paragraph.getBoundingClientRect = () => box(50, 1_000);
  return { sentence, note, paragraph };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('runMarginPass', () => {
  it('writes each note’s top through CSSOM and reveals it only then', () => {
    const first = fixture(100, 96, 'a');
    const second = fixture(110, 117, 'b');
    runMarginPass(document);
    // The second collides with the first: 100 + 96 + 12 = 208. Both are relative to the
    // paragraph's own top (50), written through CSSOM.
    expect(first.note.style.top).toBe('50px');
    expect(second.note.style.top).toBe('158px');
    for (const { note } of [first, second]) {
      expect(note.getAttribute('data-placed')).toBe('true');
      expect(note.getAttribute('style')).toContain('top:');
    }
  });

  it('grows the margin tail by the residual and resets it when the margin empties', () => {
    const tail = document.createElement('div');
    tail.setAttribute('data-margin-tail', '');
    document.body.append(tail);
    tail.getBoundingClientRect = () => box(1_000, 0);
    const note = fixture(900, 117, 'a');
    const placed = runMarginPass(document);
    expect(placed.tail).toBe(17);
    expect(tail.style.height).toBe('17px');
    expect(note.note.style.top).toBe('850px');
    note.note.remove();
    expect(runMarginPass(document)).toEqual({ tops: [], tail: 0 });
    expect(tail.style.height).toBe('0px');
  });

  /** A mark of its own line in the same sentence, with its own anchor and height. */
  function markAt(fixture: Fixture, anchorTop: number, height = 44): HTMLElement {
    const { sentence, paragraph } = fixture;
    const mark = document.createElement('button');
    mark.className = 'filing-mark';
    mark.setAttribute('data-margin-item', 'mark');
    mark.style.position = 'absolute';
    sentence.prepend(mark);
    Object.defineProperty(mark, 'offsetParent', { configurable: true, get: () => paragraph });
    mark.getBoundingClientRect = () => box(anchorTop, height);
    return mark;
  }

  it('keeps one cursor per column: the note keeps its hairline tie beside a mark (BOOK-218)', () => {
    const owner = fixture(100, 96, 'a');
    // The line's box is 24 px high in the browser; jsdom has no sheet, so the fixture says so.
    owner.sentence.style.lineHeight = '24px';
    // A 40 × 44 target centred on the same line: 100 + 12 − 22 = 90.
    const mark = markAt(owner, 90);
    const second = fixture(160, 96, 'b');

    runMarginPass(document);

    // The mark is centred on its own line; the note of the same line keeps its own tie (100),
    // because the mark stands in another column and advances another cursor.
    expect(mark.style.top).toBe('40px'); // 90 − the paragraph's top (50)
    expect(second.sentence.style.lineHeight).toBe('');
    expect(owner.note.style.top).toBe('50px'); // 100 − 50 — not pushed by the mark
    // The next note still starts under the note above it: 100 + 96 + 12.
    expect(second.note.style.top).toBe('158px');
    for (const item of [mark, owner.note, second.note]) {
      expect(item.getAttribute('data-placed')).toBe('true');
    }
  });

  it('never lets a note move a mark', () => {
    const tall = fixture(100, 300, 'tall');
    const below = fixture(500, 44, 'mark-line');
    below.sentence.style.lineHeight = '24px';
    const mark = markAt(below, 500 + 12 - 22);

    runMarginPass(document);

    // The tall note reaches 400; the mark stays on its own line at 490, untouched.
    expect(mark.style.top).toBe('440px'); // 490 − 50
    expect(tall.note.style.top).toBe('50px'); // 100 − 50: the note's own tie
    expect(Number.parseFloat(below.note.style.top)).toBeGreaterThanOrEqual(0);
  });

  it('marks a fitting paragraph as a margin', () => {
    const { paragraph } = fixture(100, 96, 'a');
    runMarginPass(document);
    expect(paragraph.dataset.margin).toBe('margin');
  });

  it('leaves a fixed sheet alone and clears a channel top it no longer uses', () => {
    const { note } = fixture(100, 96, 'a');
    note.style.position = 'fixed';
    note.style.top = '40px';
    runMarginPass(document);
    expect(note.style.top).toBe('');
    expect(note.getAttribute('data-placed')).toBeNull();
  });

  it('skips a block in flow: the phone body keeps no channel top and no placement', () => {
    const { note } = fixture(100, 96, 'a');
    note.style.position = 'static';
    note.style.top = '40px';
    const placed = runMarginPass(document);
    expect(note.style.top).toBe('40px');
    expect(note.getAttribute('data-placed')).toBeNull();
    expect(placed.tops).toEqual([]);
  });

  it('stacks the word’s record 12 px under the note on the same line and never moves the note', () => {
    // One line, two items: a note and the word's record, at the same anchor (BOOK-128 §3).
    const { note, paragraph } = fixture(100, 96, 'a');
    const word = document.createElement('div');
    word.className = 'prov-block';
    word.setAttribute('data-margin-item', 'prov');
    word.style.position = 'absolute';
    // The record is the strip's child: its anchor is the strip's own top, just under the line.
    const strip = document.createElement('div');
    strip.className = 'seam';
    Object.defineProperty(strip, 'getBoundingClientRect', { configurable: true, value: () => box(100, 44) });
    strip.append(word);
    paragraph.after(strip);
    Object.defineProperty(word, 'offsetParent', { configurable: true, get: () => strip });
    Object.defineProperty(word, 'getBoundingClientRect', { configurable: true, value: () => box(100, 60) });

    runMarginPass(document);

    // The note keeps the line it belongs to: 100. The record starts 12 px under its bottom.
    expect(note.style.top).toBe('50px'); // 100 − the paragraph's top (50)
    expect(note.getAttribute('data-placed')).toBe('true');
    expect(word.style.top).toBe(`${100 + 96 + 12 - 100}px`); // 12 px under the note, in the strip
    expect(word.getAttribute('data-placed')).toBe('true');
    expect(Number.parseFloat(word.style.top)).toBeGreaterThan(96);
  });
});

describe('attachMarginPass', () => {
  it('queues one pass per commit and detaches the page listener with its last subscriber', async () => {
    const first = fixture(50, 96, 'a');
    const detach = attachMarginPass(document);
    // The pass is queued, not run in the layout effect: the frame gets one pass, not one per note.
    expect(first.note.style.top).toBe('');
    await Promise.resolve();
    expect(first.note.style.top).toBe('0px');
    detach();
    // A second subscriber keeps the same engine alive; the last one removes it.
    const again = attachMarginPass(document);
    await Promise.resolve();
    again();
    expect(first.note.style.top).toBe('0px');
  });

  it('coalesces several schedules in one commit into a single page-wide pass', async () => {
    const first = fixture(50, 96, 'a');
    let measured = 0;
    const box = first.note.getBoundingClientRect.bind(first.note);
    first.note.getBoundingClientRect = () => {
      measured += 1;
      return box();
    };
    scheduleMarginPass();
    scheduleMarginPass();
    scheduleMarginPass();
    await Promise.resolve();
    expect(measured).toBe(1);
  });

  it('marks a paragraph whose channel does not fit as a strip (measured, not a breakpoint)', () => {
    const wide = fixture(50, 96, 'a');
    wide.paragraph.getBoundingClientRect = () => new DOMRect(0, 50, 1_000, 1_000);
    scheduleMarginPass();
    return Promise.resolve().then(() => {
      expect(wide.paragraph.dataset.margin).toBe('strip');
    });
  });
});
