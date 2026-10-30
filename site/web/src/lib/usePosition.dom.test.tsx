// @vitest-environment jsdom
import { TOTAL_CHAPTERS } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OFFSET_TOP_PROPERTY, applyStickyOffsets } from './headerOffset.ts';
import { landingLine } from './landing.ts';
import { ANCHOR_EPS } from './pageTrack.ts';
import { PLACE_KEY, readPlace } from './placeStore.ts';
import { placeAtLine, type Place } from './position.ts';
import { beginPrint, followingInk, reportCaret, resetPrintFollow, setPrintFollow } from './printFollow.ts';
import { forgetBootPlace, jumpToChapter, resumePending, usePosition } from './usePosition.ts';

/**
 * BOOK-209 — the position layer's wiring, proved on a page whose geometry this file owns.
 *
 * jsdom has no layout and no frame clock, so every rect comes from a table in document
 * coordinates (a rect is what a browser would report at this scroll) and `requestAnimationFrame`
 * is a queue drained by hand. What is proved: a contents tap records the place the reader is
 * leaving and pushes a real entry; `popstate` restores that place — the sentence, its delta, the
 * line — and wins over the fragment's nominal anchor; and a resume lands the remembered sentence,
 * falling back sentence → paragraph behind exactly one operator line.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HEAD = 56;
const VIEWPORT = 844;
const SCROLL_HEIGHT = 4_000;
const LINE = HEAD + 16;

/** The page: a head, two chapters with prose, and the gap between them. */
const BOOK = `
  <header class="top"></header>
  <article data-n="1" id="ch-1" data-rev="1">
    <header class="ch-h"></header>
    <p id="ch-1-b1" data-block-id="ch01#aaaaaaaa">
      <span data-s="0" data-quote="Первое предложение главы первой."></span>
      <span data-s="40" data-quote="Второе предложение главы первой."></span>
    </p>
  </article>
  <article data-n="2" id="ch-2" data-rev="1">
    <header class="ch-h"></header>
    <p id="ch-2-b1" data-block-id="ch02#bbbbbbbb">
      <span data-s="0" data-quote="Первое предложение главы второй."></span>
    </p>
  </article>
`;

/** Document coordinates per element; `.top` is sticky and always sits at the viewport's top. */
const BOXES: ReadonlyArray<readonly [string, number, number]> = [
  ['#ch-1', 900, 600],
  ['#ch-1 .ch-h', 900, 40],
  ['#ch-1-b1', 1_000, 200],
  ['#ch-1 [data-s="0"]', 1_000, 20],
  ['#ch-1 [data-s="40"]', 1_060, 20],
  ['#ch-2', 1_600, 500],
  ['#ch-2 .ch-h', 1_600, 40],
  ['#ch-2-b1', 1_700, 100],
  ['#ch-2 [data-s="0"]', 1_700, 20],
];

const scroll = { y: 0 };
let queued: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextId = 1;
const scrollTo = vi.fn((options: ScrollToOptions) => {
  scroll.y = Number(options.top ?? 0);
});
// Both shapes the page uses: the options form (a relative step by `top`) and the two-argument
// form the follow control writes while the ink prints (`scrollBy(0, delta)`).
const scrollBy = vi.fn((first: ScrollToOptions | number, delta: number | undefined = undefined) => {
  scroll.y += typeof first === 'number' ? delta ?? 0 : Number(first.top ?? 0);
});

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function stubLayout(): void {
  const head = document.querySelector<HTMLElement>('.top');
  if (head !== null) head.getBoundingClientRect = () => rect(0, HEAD);
  for (const [selector, top, height] of BOXES) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element !== null) element.getBoundingClientRect = () => rect(top - scroll.y, height);
  }
}

function mountPage(): void {
  document.body.innerHTML = BOOK;
  stubLayout();
  applyStickyOffsets(document);
}

/** Drain the page's frame queue, letting every microtask of the landing chain settle. */
async function pump(times = 10): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      const due = queued;
      queued = [];
      for (const entry of due) entry.callback(index * 16);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  });
}

function boxTop(selector: string): number {
  return document.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN;
}

function scrollToTop(top: number): void {
  scroll.y = top;
}

const place = (overrides: Partial<Place> = {}): Place => ({
  chapter: 1,
  sentenceId: 'ch01#aaaaaaaa/s0',
  deltaPx: 0,
  at: '2026-10-29T08:00:00.000Z',
  ...overrides,
});

function ChapterLink() {
  return (
    <a
      id="toc-2"
      href="#ch-2"
      onClick={(event) => {
        if (jumpToChapter(2)) event.preventDefault();
      }}
    >
      глава 2
    </a>
  );
}

function Probe({ ready, signedIn = false }: { ready: boolean; signedIn?: boolean }) {
  usePosition(ready, signedIn);
  return <ChapterLink />;
}

let container: HTMLDivElement;
let root: Root | null = null;

function mount(ready: boolean, signedIn = false): void {
  act(() => root?.render(<Probe ready={ready} signedIn={signedIn} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetBootPlace();
  resetPrintFollow();
  window.sessionStorage.clear();
  window.localStorage.clear();
  scroll.y = 0;
  queued = [];
  nextId = 1;
  mountPage();
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scroll.y });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: SCROLL_HEIGHT });
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('scrollBy', scrollBy);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queued.push({ id: nextId, callback });
    nextId += 1;
    return nextId - 1;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queued = queued.filter((entry) => entry.id !== id);
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, media: '', addEventListener: () => undefined, removeEventListener: () => undefined }));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  resetPrintFollow();
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container.remove();
  // The history mocks of this file's own cases are undone before the entry is reset.
  vi.restoreAllMocks();
  window.location.hash = '';
  window.history.replaceState(null, '');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('a contents tap: the place is recorded, the entry is pushed', () => {
  it('records the place being left and pushes a real entry for the chapter it opens', async () => {
    // The reader is in ch01's first sentence: its top is above the line, so the delta is the
    // negative distance it stands from it (−12), and the place keeps the sign.
    scrollToTop(940);
    mount(true);
    await pump(0);

    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    await act(async () => document.getElementById('toc-2')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    // The place the reader left went into the entry they left…
    const recorded = replace.mock.calls.at(-1)?.[0] as { bookPlace?: Place } | undefined;
    expect(recorded?.bookPlace).toMatchObject({ chapter: 1, sentenceId: 'ch01#aaaaaaaa/s0', deltaPx: -12 });
    // …and the new entry is the chapter, with no place of its own yet.
    expect(push.mock.calls.at(-1)?.[0]).toEqual({ bookPlace: null });
    expect(push.mock.calls.at(-1)?.[2]).toBe('#ch-2');
    expect(window.location.hash).toBe('#ch-2');

    await pump(10);
    // The chapter's heading reached the line: the one measurement, not a literal.
    expect(boxTop('#ch-2 .ch-h')).toBeCloseTo(landingLine(), 1);
    expect(landingLine()).toBe(LINE);
  });

  it('does not swallow a click whose chapter is not on the page', async () => {
    mount(true);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const link = document.createElement('a');
    link.href = '#ch-9';
    link.textContent = 'глава 9';
    document.body.append(link);
    link.addEventListener('click', (caught) => {
      if (jumpToChapter(9)) caught.preventDefault();
    });
    await act(async () => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('back/forward: the place the reader left, not the anchor’s nominal one', () => {
  it('restores the recorded sentence and its delta, and ignores the fragment that follows', async () => {
    scrollToTop(940);
    mount(true);
    await pump(0);

    const replace = vi.spyOn(window.history, 'replaceState');
    await act(async () => document.getElementById('toc-2')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await pump(10);
    const recorded = (replace.mock.calls.at(-1)?.[0] as { bookPlace: Place }).bookPlace;
    expect(recorded).toMatchObject({ chapter: 1, sentenceId: 'ch01#aaaaaaaa/s0' });

    // Back: the browser hands the entry's own state to the page.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { bookPlace: recorded } }));
    });
    await pump(10);

    // The sentence is at the line plus the delta it was recorded with — the reader's own place,
    // not the chapter the address bar still names. Here the delta is negative (−12): the restore
    // leaves the sentence above the line instead of pulling it down, which is where it stood.
    expect(boxTop('#ch-1 [data-s="0"]')).toBeCloseTo(landingLine() + recorded.deltaPx, 1);
    // The `hashchange` that follows the same entry does not land the fragment over the place.
    const calls = scrollTo.mock.calls.length;
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await pump(10);
    expect(scrollTo.mock.calls.length).toBe(calls);
    expect(boxTop('#ch-1 [data-s="0"]')).toBeCloseTo(landingLine() + recorded.deltaPx, 1);
  });

  it('lets the fragment land when the entry carries no place', async () => {
    scrollToTop(940);
    mount(true);
    await pump(0);
    window.history.replaceState({ bookPlace: null }, '', '#ch-2');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { bookPlace: null } }));
    });
    await pump(10);
    expect(boxTop('#ch-2 .ch-h')).toBeCloseTo(landingLine(), 1);
  });
});

describe('resume: the remembered place, once', () => {
  it('is pending only for a valid place and a load that opened on no fragment', () => {
    expect(resumePending()).toBe(false);
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place()));
    forgetBootPlace();
    expect(resumePending()).toBe(true);
    window.location.hash = '#ch-2';
    forgetBootPlace();
    expect(resumePending()).toBe(false);
    window.location.hash = '#правка-chg_1';
    forgetBootPlace();
    expect(resumePending()).toBe(false);
  });

  it('lands the chapter’s mouth, then the sentence with its delta', async () => {
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place({ deltaPx: 12 })));
    forgetBootPlace();
    mount(false);
    await pump(2);
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => root?.render(<Probe ready />));
    await pump(12);

    // The mouth first (that jump is what starts the chapter's read), then the sentence itself.
    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ top: 900 - LINE, behavior: 'auto' });
    expect(boxTop('#ch-1 [data-s="0"]')).toBeCloseTo(landingLine() + 12, 1);
  });

  it('falls back sentence → paragraph behind exactly one operator line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place({ sentenceId: 'ch01#aaaaaaaa/s999', deltaPx: 4 })));
    forgetBootPlace();

    await act(async () => root?.render(<Probe ready />));
    await pump(12);

    expect(info.mock.calls).toHaveLength(1);
    expect(info.mock.calls[0]?.[0]).toBe('position: resume fell back sentence→paragraph ch01#aaaaaaaa/s999');
    // The paragraph is the place that is still there, and the delta is kept.
    expect(boxTop('#ch-1-b1')).toBeCloseTo(landingLine() + 4, 1);
  });

  it('does not resume a load that arrived with a fragment', async () => {
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place()));
    forgetBootPlace();
    window.location.hash = '#ch-2';
    await act(async () => root?.render(<Probe ready />));
    await pump(12);
    // The fragment is the deep link's business: no resume landing happened on ch01.
    expect(boxTop('#ch-1 [data-s="0"]')).not.toBeCloseTo(landingLine(), 1);
  });
});

describe('capture', () => {
  it('writes no row where no chapter owns the line, so the cover keeps the place it had', async () => {
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place({ chapter: TOTAL_CHAPTERS, sentenceId: `ch${String(TOTAL_CHAPTERS)}` })));
    scrollToTop(0); // the cover: above the first chapter
    await act(async () => root?.render(<Probe ready />));
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    await pump(2);
    // No chapter owns the line at the top of this page.
    expect(placeAtLine(document, landingLine() + ANCHOR_EPS)).toBeNull();
    expect(readPlace()).toMatchObject({ chapter: TOTAL_CHAPTERS });
  });

  it('writes the place the reader scrolled to, into the store and into the entry', async () => {
    await act(async () => root?.render(<Probe ready />));
    scrollToTop(940);
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    await pump(2);
    expect(readPlace()).toMatchObject({ chapter: 1, sentenceId: 'ch01#aaaaaaaa/s0' });
    // The entry carries the same place: forward returns the reader here as well as back does.
    const held = (window.history.state as { bookPlace?: Place } | null)?.bookPlace;
    expect(held).toMatchObject({ chapter: 1, sentenceId: 'ch01#aaaaaaaa/s0' });
  });
});

describe('one line, both directions', () => {
  it('stores the delta from the landing line and restores the anchor to the same top', async () => {
    mount(true);
    await pump(0);
    // The line (72) falls between the two sentences of ch01: the place takes the first one
    // below it, so the delta is a positive distance and a biased line would show up as 2 px.
    scrollToTop(980);
    await act(async () => window.dispatchEvent(new Event('scroll')));
    await pump(2);
    const kept = readPlace();
    expect(kept).toMatchObject({ chapter: 1, sentenceId: 'ch01#aaaaaaaa/s40', deltaPx: 8 });
    const before = boxTop('#ch-1 [data-s="40"]');
    expect(before).toBeCloseTo(landingLine() + 8, 1);

    // The reader jumps away and comes back through the entry that carries the place.
    await act(async () => document.getElementById('toc-2')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await pump(10);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { bookPlace: kept } }));
    });
    await pump(10);
    expect(boxTop('#ch-1 [data-s="40"]')).toBeCloseTo(before, 1);
  });
});

describe('the landing line the layer measures', () => {
  it('reads the head the page measured, not a literal', () => {
    // `applyStickyOffsets` wrote the token from the same head: the two agree by construction.
    expect(document.documentElement.style.getPropertyValue(OFFSET_TOP_PROPERTY)).toBe(`${String(LINE)}px`);
    expect(landingLine()).toBe(LINE);
  });
});

describe('a reload', () => {
  it('asks the page for its anchor, not the engine for a remembered offset', async () => {
    // The browser's own restore is a pixel; a place is a sentence. `manual` is set once, at the
    // layer, so a reload never lands at an offset the prose has moved under.
    Reflect.deleteProperty(window.history, 'scrollRestoration');
    mount(true);
    await pump(0);
    expect(window.history.scrollRestoration).toBe('manual');
  });
});

/**
 * BOOK-220 × BOOK-209 — the follow control and the place do not fight. «следить» scrolls only
 * while something prints and stops on a hand scroll; the place restores on navigation and back.
 * So a restore never lands while a print is followed (the follow's own scroll would undo it in
 * the next frame), and the follow never calls the position layer at all.
 */
describe('a followed print and the place', () => {
  it('does not land an entry’s place while the ink is followed', async () => {
    scrollToTop(940);
    mount(true);
    await pump(0);
    const stop = beginPrint();
    setPrintFollow(true);
    expect(followingInk()).toBe(true);

    const before = scroll.y;
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { bookPlace: place({ deltaPx: 12 }) } }));
    });
    await pump(10);

    // The page did not move: the follow owns it, and a restore would be undone next frame.
    expect(scroll.y).toBe(before);
    expect(scrollTo).not.toHaveBeenCalled();
    stop();
  });

  it('does not spend the resume while the ink is followed', async () => {
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place({ deltaPx: 12 })));
    forgetBootPlace();
    const stop = beginPrint();
    setPrintFollow(true);

    await act(async () => root?.render(<Probe ready />));
    await pump(12);

    expect(scrollTo).not.toHaveBeenCalled();
    // The one resume is spent unused: nothing lands under the control once the print ends.
    expect(resumePending()).toBe(false);
    stop();
  });

  it('lands the place again as soon as the print stops being followed', async () => {
    mount(true);
    await pump(0);
    const stop = beginPrint();
    setPrintFollow(true);

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { bookPlace: place({ deltaPx: 12 }) } }));
    });
    await pump(10);
    expect(boxTop('#ch-1 [data-s="0"]')).not.toBeCloseTo(landingLine() + 12, 1);

    stop();
    setPrintFollow(false);
    expect(followingInk()).toBe(false);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { bookPlace: place({ deltaPx: 12 }) } }));
    });
    await pump(10);
    expect(boxTop('#ch-1 [data-s="0"]')).toBeCloseTo(landingLine() + 12, 1);
  });

  it('moves the page itself without a landing: the follow never calls the position layer', async () => {
    mount(true);
    await pump(0);
    const stop = beginPrint();
    setPrintFollow(true);
    scrollToTop(0);
    // A caret far below the 45 % line: one `scrollBy(0, delta)`, no `scrollTo`, no landing chain.
    reportCaret(1_000, VIEWPORT, 0);
    await pump(10);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    // The caret's centre on the 45 % line, and nothing else moved the page.
    expect(scroll.y).toBeCloseTo(1_000 - VIEWPORT * 0.45, 1);
    expect(scrollTo).not.toHaveBeenCalled();
    stop();
  });
});
