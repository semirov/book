// @vitest-environment jsdom
import { PAGE_CHARS, type ChapterLength } from '@book/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useReading } from './pageTrack.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * BOOK-104 — the hook's half of the model: one line at the head's edge, one `{ n, page }`
 * pair, and a state write only when the pair moves. jsdom has no layout, so every rect comes
 * from the table below; the page geometry itself is proven pure in `pageTrack.test.ts`.
 */

/** jsdom has no layout: every rect the hook reads comes from this table. */
type Box = { top: number; height: number };

const VIEWPORT = 800;

const catalog: ChapterLength[] = [
  { n: 1, chars: 2 * PAGE_CHARS }, // two pages: 3600 characters
  { n: 2, chars: 1_800 }, // one page, and its prose has not arrived
];

/** ch01 is one 3600-character block; ch02 is present but empty until the resize test fills it. */
const BOOK = `
  <article data-n="1" data-rev="1">
    <p data-block-id="a" data-chars="3600"></p>
  </article>
  <article data-n="2" data-rev="1"></article>
`;

const layout = new Map<string, Box>();

function box(selector: string): Box | null {
  return layout.get(selector) ?? null;
}

function rectOf(entry: Box): DOMRect {
  // The table holds document coordinates; a browser returns viewport ones.
  const top = entry.top - window.scrollY;
  return {
    top,
    bottom: top + entry.height,
    height: entry.height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => entry,
  } as DOMRect;
}

/** Identity for a node in the table: `article` → `article:1`, a block → `block:a`. */
function key(element: Element): string | null {
  const chapter = element.getAttribute('data-n');
  if (chapter !== null) return `article:${chapter}`;
  const block = element.getAttribute('data-block-id');
  return block === null ? null : `block:${block}`;
}

function stubLayout(): void {
  for (const element of document.querySelectorAll<HTMLElement>('article[data-n], [data-block-id]')) {
    const keyOf = key(element);
    const entry = keyOf === null ? null : box(keyOf);
    element.getBoundingClientRect = () => rectOf(entry ?? { top: 0, height: 0 });
  }
}

/** How many times the probe rendered: a flip is one render, a held page is none. */
let renders = 0;

function Probe({ catalog: chapters }: { catalog: readonly ChapterLength[] }) {
  renders += 1;
  const reading = useReading(chapters);
  const n = reading.n === null ? 'none' : String(reading.n);
  const page = reading.page === null ? 'none' : String(reading.page);
  return createElement('span', { className: 'probe' }, `${n}/${page}`);
}

let root: Root | null = null;
let container: HTMLDivElement;

function mountBook(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Probe, { catalog })));
}

function shown(): string {
  return container.textContent ?? '';
}

/** The reading line is 66 from the top: a scroll of `line - 66` puts it at document `line`. */
function lineTo(line: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: line - 66 });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

function resize(): void {
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  document.body.innerHTML = BOOK;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  Object.assign(window, {
    // Run the frame at once: the id is 0 because the hook resets its own handle when the
    // callback starts, and a synchronous stub must leave the handle free for the next frame.
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
  layout.clear();
  // The cover and the contents sit above ch01, so the line starts where no chapter owns it.
  layout.set('article:1', { top: 500, height: 1_600 });
  layout.set('block:a', { top: 500, height: 1_600 });
  layout.set('article:2', { top: 2_100, height: 400 });
  stubLayout();
  mountBook();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('useReading', () => {
  it('names no chapter while the front matter or the contents own the line', () => {
    expect(shown()).toBe('none/none');
  });

  it('names the chapter at the line and its start page where the prose has not arrived', () => {
    lineTo(500); // the first pixel of ch01: an empty chapter opens its page at once
    expect(shown()).toBe('1/1');
    lineTo(2_100); // ch02, which has no blocks at all
    expect(shown()).toBe('2/3');
  });

  it('flips the page when the reader passes a page boundary', () => {
    lineTo(500); // 0 characters into ch01
    expect(shown()).toBe('1/1');
    lineTo(1_300); // 1800 characters: the second page
    expect(shown()).toBe('1/2');
  });

  it('holds the page under sub-line jitter across a boundary (hysteresis)', () => {
    lineTo(1_300); // exactly 1800 characters
    expect(shown()).toBe('1/2');
    lineTo(1_290); // 1777 characters: 23 under the boundary, less than one line
    expect(shown()).toBe('1/2');
    lineTo(1_216); // 1611 characters: past the tolerance, back on the first page
    expect(shown()).toBe('1/1');
  });

  it('changes the chapter at once, one pixel past the boundary, with no hysteresis', () => {
    lineTo(2_099); // the last pixel of ch01
    expect(shown()).toBe('1/2');
    lineTo(2_100); // the first pixel of ch02
    expect(shown()).toBe('2/3');
    lineTo(2_099);
    expect(shown()).toBe('1/2');
  });

  it('writes no state when the position moves but neither number changes', () => {
    lineTo(500);
    const before = renders;
    lineTo(560); // 135 characters further into ch01: still page 1
    expect(shown()).toBe('1/1');
    expect(renders).toBe(before);
    lineTo(1_300); // 1800 characters: the page flips once
    expect(renders).toBe(before + 1);
  });

  it('shows nothing below the last chapter: the end matter has no page', () => {
    lineTo(2_600);
    expect(shown()).toBe('none/none');
  });

  it('walks back a chapter when the reader scrolls up, and clears the pair past the book', () => {
    lineTo(2_100);
    expect(shown()).toBe('2/3');
    lineTo(500);
    expect(shown()).toBe('1/1');
    lineTo(2_600);
    expect(shown()).toBe('none/none');
  });

  it('renders no chapter when the page has no slots at all', () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(createElement(Probe, { catalog })));
    lineTo(900);
    expect(shown()).toBe('none/none');
  });

  it('shows the chapter’s start page for a block without a character count', () => {
    const second = document.querySelector('article[data-n="2"]');
    if (second !== null) second.innerHTML = '<p data-block-id="b"></p>';
    layout.set('block:b', { top: 2_100, height: 400 });
    stubLayout();
    resize();
    lineTo(2_110); // inside the attribute-less block
    expect(shown()).toBe('2/3');
  });

  it('rescans the slots when the catalog changes: a chapter created live is named', () => {
    document.body.insertAdjacentHTML('beforeend', '<article data-n="3" data-rev="1"></article>');
    layout.set('article:3', { top: 2_500, height: 400 });
    stubLayout();
    act(() => root?.render(createElement(Probe, { catalog: [...catalog, { n: 3, chars: 0 }] })));
    lineTo(2_500);
    expect(shown()).toBe('3/4');
  });

  it('cancels a pending frame on unmount', () => {
    act(() => root?.unmount());
    root = null;
    container = document.createElement('div');
    document.body.append(container);
    const cancel = vi.fn();
    Object.assign(window, { requestAnimationFrame: () => 7, cancelAnimationFrame: cancel });
    root = createRoot(container);
    act(() => root?.render(createElement(Probe, { catalog })));
    act(() => root?.unmount());
    root = null;
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('re-measures after a resize, so prose arriving above the reader shifts the chapter', () => {
    expect(shown()).toBe('none/none');
    // ch01 moves to the top of the document: the same scroll position now sits inside it.
    layout.set('article:1', { top: 0, height: 1_600 });
    layout.set('block:a', { top: 0, height: 1_600 });
    stubLayout();
    resize();
    expect(shown()).toBe('1/1');
  });
});
