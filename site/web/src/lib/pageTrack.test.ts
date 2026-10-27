// @vitest-environment jsdom
import { PAGE_CHARS, type ChapterLength } from '@book/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  charsInBlocks,
  LINE_CHARS,
  readingLineY,
  steadyPosition,
  useRunningPage,
  type BlockSpan,
} from './pageTrack.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('readingLineY', () => {
  it('sits at 40 % of the viewport: 337.6 at 844, 360 at 900', () => {
    expect(readingLineY(844)).toBeCloseTo(337.6);
    expect(readingLineY(900)).toBe(360);
    expect(readingLineY(1000)).toBe(400);
  });

  it('keeps 96px clear of the sticky head and of the bottom edge', () => {
    expect(readingLineY(300)).toBe(120);
    expect(readingLineY(150)).toBe(96); // below 192 the floor wins, never a negative line
    expect(readingLineY(0)).toBe(96);
    expect(readingLineY(Number.NaN)).toBe(96);
  });
});

describe('charsInBlocks', () => {
  const spans: BlockSpan[] = [
    { top: 0, bottom: 100, chars: 900 },
    { top: 100, bottom: 300, chars: 1800 },
  ];

  it('counts nothing above the first block and everything below the last', () => {
    expect(charsInBlocks(spans, -10, 2700)).toBe(0);
    expect(charsInBlocks(spans, 0, 2700)).toBe(0);
    expect(charsInBlocks(spans, 300, 2700)).toBe(2700);
    expect(charsInBlocks(spans, 9_999, 2700)).toBe(2700);
  });

  it('interpolates inside a block from its own share of the chapter', () => {
    expect(charsInBlocks(spans, 50, 2700)).toBe(450);
    expect(charsInBlocks(spans, 200, 2700)).toBe(900 + 900);
    expect(charsInBlocks(spans, 299, 2700)).toBe(900 + 1791);
  });

  it('treats a broken character count as no prose', () => {
    const broken: BlockSpan[] = [
      { top: 0, bottom: 100, chars: 0 },
      { top: 100, bottom: 200, chars: Number.NaN },
    ];
    expect(charsInBlocks(broken, 50, 3600)).toBe(0);
    expect(charsInBlocks(broken, 150, 3600)).toBe(0);
    expect(charsInBlocks(broken, 250, 3600)).toBe(3600);
  });

  it('is zero for a chapter with no blocks — the prose has not arrived', () => {
    expect(charsInBlocks([], 400, 2700)).toBe(0);
    expect(charsInBlocks([], 400, 0)).toBe(0);
  });

  it('clamps into the chapter and never decreases as the line moves down', () => {
    let previous = -1;
    for (let line = -50; line <= 350; line += 1) {
      const value = charsInBlocks(spans, line, 2700);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2700);
      previous = value;
    }
    // A chapter shorter than the blocks claim is still only its own length.
    expect(charsInBlocks(spans, 999, 1000)).toBe(1000);
    expect(charsInBlocks(spans, 999, 0)).toBe(0);
  });
});

describe('steadyPosition', () => {
  it('commits the first measurement and a chapter change at once', () => {
    const first = { n: 1, chars: 10 };
    expect(steadyPosition(null, first)).toEqual(first);
    expect(steadyPosition({ n: 1, chars: 1_799 }, { n: 2, chars: 0 })).toEqual({ n: 2, chars: 0 });
  });

  it('holds a move under one line and commits a move past it', () => {
    const previous = { n: 1, chars: 1_800 };
    expect(steadyPosition(previous, { n: 1, chars: 1_800 + LINE_CHARS - 1 })).toBe(previous);
    expect(steadyPosition(previous, { n: 1, chars: 1_800 - LINE_CHARS + 1 })).toBe(previous);
    expect(steadyPosition(previous, { n: 1, chars: 1_800 + LINE_CHARS })).toEqual({ n: 1, chars: 1_800 + LINE_CHARS });
  });

  it('falls back to one line when the tolerance is not a positive number', () => {
    const previous = { n: 1, chars: 1_800 };
    expect(steadyPosition(previous, { n: 1, chars: 1_801 }, 0)).toBe(previous);
    expect(steadyPosition(previous, { n: 1, chars: 1_801 }, Number.NaN)).toBe(previous);
  });

  it('never flashes on a jitter of ±30 characters around a page boundary', () => {
    const boundary = PAGE_CHARS;
    let position = steadyPosition(null, { n: 1, chars: boundary - 10 });
    const first = position;
    for (const chars of [boundary + 20, boundary - 30, boundary + 5]) {
      position = steadyPosition(position, { n: 1, chars });
      expect(position).toBe(first);
    }
  });
});

/** jsdom has no layout: every rect the hook reads comes from this table. */
type Box = { top: number; height: number };

const VIEWPORT = 800; // the reading line is 320 (0.4 × 800)

const catalog: ChapterLength[] = [
  { n: 1, chars: 2 * PAGE_CHARS }, // two pages
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

/** How many times the leaf rendered: a flip is one render, a held page is none. */
let renders = 0;

function Probe({ catalog: chapters }: { catalog: readonly ChapterLength[] }) {
  renders += 1;
  const page = useRunningPage(chapters);
  return createElement('span', { className: 'probe' }, page === null ? 'none' : String(page));
}

let root: Root | null = null;
let container: HTMLDivElement;

function mount(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Probe, { catalog })));
}

function page(): string {
  return container.textContent ?? '';
}

function scrollTo(scroll: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: scroll });
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
  mount();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('useRunningPage', () => {
  it('shows nothing while the front matter or the contents own the reading line', () => {
    expect(page()).toBe('none');
  });

  it('derives the page from the chapter the reading line is in', () => {
    scrollTo(900); // line 1220 → 1620 characters into ch01
    expect(page()).toBe('1');
  });

  it('flips the page when the reader passes a page boundary', () => {
    scrollTo(900);
    expect(page()).toBe('1');
    scrollTo(980); // line 1300 → 1800 characters: the second page
    expect(page()).toBe('2');
  });

  it('holds the number under sub-line jitter across a boundary (hysteresis)', () => {
    scrollTo(980);
    expect(page()).toBe('2');
    scrollTo(960); // 1755 characters: 45 under the boundary, less than one line of jitter
    expect(page()).toBe('2');
    scrollTo(820); // 1440 characters: past the tolerance, back on the first page
    expect(page()).toBe('1');
  });

  it('writes no state when the position moves but the page does not flip', () => {
    scrollTo(900); // 1620 characters into ch01: page 1
    const before = renders;
    scrollTo(780); // 1440 characters: past the hysteresis, still the first page
    expect(page()).toBe('1');
    expect(renders).toBe(before);
    scrollTo(980); // 1800 characters: the boundary, so the page flips once
    expect(renders).toBe(before + 1);
  });

  it('shows a chapter’s start page when its prose is not loaded yet', () => {
    scrollTo(1900); // line 2220 → ch02, which has no blocks at all
    expect(page()).toBe('3');
  });

  it('shows nothing below the last chapter: the end matter has no page', () => {
    scrollTo(2400); // line 2720 → below ch02
    expect(page()).toBe('none');
  });

  it('walks back a chapter when the reader scrolls up, and clears the number past the book', () => {
    scrollTo(1900); // ch02
    expect(page()).toBe('3');
    scrollTo(900); // back up into ch01
    expect(page()).toBe('1');
    scrollTo(2400); // past the last chapter: the end matter owns the line
    expect(page()).toBe('none');
  });

  it('renders no number when the page has no chapters at all', () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(createElement(Probe, { catalog })));
    scrollTo(900);
    expect(page()).toBe('none');
  });

  it('shows the chapter’s start page for a block without a character count', () => {
    const second = document.querySelector('article[data-n="2"]');
    if (second !== null) second.innerHTML = '<p data-block-id="b"></p>';
    layout.set('block:b', { top: 2_100, height: 400 });
    stubLayout();
    resize();
    scrollTo(1900); // line 2220, inside the attribute-less block
    expect(page()).toBe('3');
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

  it('re-measures after a resize, so prose arriving above the reader shifts the page', () => {
    expect(page()).toBe('none');
    // ch01 moves to the top of the document, as it does once the cover is scrolled past and
    // the contents collapse: the same scroll position now sits inside a chapter.
    layout.set('article:1', { top: 0, height: 1_600 });
    layout.set('block:a', { top: 0, height: 1_600 });
    stubLayout();
    resize();
    expect(page()).toBe('1');
  });
});
