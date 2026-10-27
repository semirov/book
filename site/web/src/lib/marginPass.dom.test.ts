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
