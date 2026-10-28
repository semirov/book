// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePassStrip, currentPassStrip } from '../lib/usePassStrip.ts';
import { FootJumps, type FootJumpsProps } from './FootJumps.tsx';

/**
 * BOOK-156 — the door into the carets, under a browser.
 *
 * The clock is `lib/grip.test.ts`'s and the markup is `footJumps.dom.test.tsx`'s; this file
 * proves what neither of them can: that a tap inside the grip moves the page by a cut, that
 * a gesture mid-entrance is never fought, and that the way back is the same item — whichever
 * state the pass is in by the time the reader uses it (#3802 §1, §4; BOOK-156 fix M2).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DEFAULTS: FootJumpsProps = {
  live: true,
  processing: false,
  revising: false,
  chapter: null,
  change: null,
  plate: false,
};

const CHANGE = { id: 'chg_7', decidedAt: '2026-10-25T11:21:00Z', enqueuedAt: '2026-10-25T10:40:00Z' };

let root: Root | null = null;
let container: HTMLDivElement;
let scrollValue = 0;
let errorCount = (): number => 0;
let restoreConsole = (): void => undefined;

beforeEach(() => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  errorCount = () => spy.mock.calls.length;
  restoreConsole = () => spy.mockRestore();
  scrollValue = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollValue });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  closePassStrip();
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restoreConsole();
});

async function render(over: Partial<FootJumpsProps> = {}): Promise<HTMLDivElement> {
  await act(async () => {
    root?.render(<FootJumps {...DEFAULTS} {...over} />);
  });
  return container;
}

/** A box at `top`, 20 px tall: jsdom has no layout, so the test states the geometry it needs. */
function rectAt(top: number): DOMRect {
  return {
    top,
    bottom: top + 20,
    left: 0,
    right: 0,
    width: 0,
    height: 20,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A live pass's block: `#pass` is rendered by `ChapterArticle`, not by the grip. */
function appendPass(top: number): HTMLElement {
  const element = document.createElement('span');
  element.id = 'pass';
  element.getBoundingClientRect = () => rectAt(top);
  document.body.append(element);
  return element;
}

const nav = (): HTMLElement => container.querySelector('nav') as HTMLElement;
const passItem = (): HTMLElement => container.querySelector('.foot-jump-pass') as HTMLElement;

/** The stubbed `prefers-reduced-motion` answer, as `chapterArticle.dom.test.tsx:80` does it. */
function stillMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe('the door into the carets', () => {
  it('takes the reader to the live block’s first line in a cut, then returns the saved place', async () => {
    vi.useFakeTimers();
    scrollValue = 200;
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    await render({ processing: true });
    expect(document.getElementById('pass')).toBeNull();
    appendPass(500);

    const door = passItem() as HTMLAnchorElement;
    expect(door.tagName).toBe('A');
    expect(door.getAttribute('href')).toBe('#pass');

    await act(async () => {
      door.click();
    });
    expect(nav().getAttribute('data-watch')).toBe('entering');
    expect(container.querySelector('.foot-veil')).not.toBeNull();
    // Nothing has scrolled yet: the veil covers the cut, it does not start it.
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    // top(#pass) = 500 + 200 = 700; the head's offset is the token's fallback (64) + 16.
    expect(scrollTo).toHaveBeenCalledWith({ top: 620, behavior: 'auto' });
    expect(nav().getAttribute('data-watch')).toBe('on');
    // A link is not a toggle: the accessible name carries the state, not `aria-pressed`.
    expect(door.hasAttribute('aria-pressed')).toBe(false);
    expect(door.getAttribute('aria-label')).toBe('каретки — вернуться к месту чтения');

    // The quiet window ends; the bar's word is still «каретки» (one label, owner's rule).
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(door.querySelector('.foot-jump-word')?.textContent).toBe('каретки');

    await act(async () => {
      door.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    // The place is re-resolved: top(#pass) + dy, where dy was saved at the tap (200 − 700).
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: 'auto' });
    expect(nav().getAttribute('data-watch')).toBe('off');
    expect(document.activeElement).toBe(door);
    expect(errorCount()).toBe(0);
  });

  it('opens the pass strip on the live block before the cut, and still lands on #pass', async () => {
    vi.useFakeTimers();
    scrollValue = 200;
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    await render({ processing: true, chapter: 7 });
    const block = appendPass(500);
    block.setAttribute('data-pass-block', 'ch07#bbbb2222');
    expect(currentPassStrip()).toBeNull();

    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    // The strip is open on the block the page names, before a single pixel has moved.
    expect(currentPassStrip()).toEqual({ chapter: 7, blockId: 'ch07#bbbb2222' });
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    // The cut still lands on the pass's first line: the strip sits under the paragraph.
    expect(scrollTo).toHaveBeenCalledWith({ top: 620, behavior: 'auto' });
    expect(nav().getAttribute('data-watch')).toBe('on');
    expect(errorCount()).toBe(0);
  });

  it('lands the chapter’s head and claims nothing when the pass’s prose is not loaded', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    const onLoad = vi.fn();
    await render({ processing: true, chapter: 12, onLoad });
    const head = document.createElement('article');
    head.id = 'ch-12';
    head.getBoundingClientRect = () =>
      ({ top: 300, bottom: 900, left: 0, right: 0, width: 0, height: 600, x: 0, y: 300, toJSON: () => ({}) }) as DOMRect;
    document.body.append(head);

    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    expect(onLoad).toHaveBeenCalledWith(12);
    expect(scrollTo).toHaveBeenCalledWith({ top: 300 - 64, behavior: 'auto' });
    expect(nav().getAttribute('data-watch')).toBe('off');
    expect(errorCount()).toBe(0);
  });

  it('is a cut with no veil and no waiting under reduced motion', async () => {
    vi.useFakeTimers();
    stillMotion();
    scrollValue = 200;
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    await render({ processing: true });
    appendPass(500);

    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    // The final state at t = 0: no `entering`, no veil, the scroll already applied.
    expect(nav().getAttribute('data-watch')).toBe('on');
    expect(container.querySelector('.foot-veil')).toBeNull();
    expect(scrollTo).toHaveBeenCalledWith({ top: 620, behavior: 'auto' });
    expect(errorCount()).toBe(0);
  });

  it('clears the veil at once and lands the cut when the reader gestures mid-entrance', async () => {
    vi.useFakeTimers();
    scrollValue = 200;
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    await render({ processing: true });
    appendPass(500);
    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    expect(nav().getAttribute('data-watch')).toBe('entering');
    expect(container.querySelector('.foot-veil')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event('wheel'));
    });
    expect(nav().getAttribute('data-watch')).toBe('on');
    expect(container.querySelector('.foot-veil')).toBeNull();
    expect(scrollTo).toHaveBeenCalledWith({ top: 620, behavior: 'auto' });
    expect(errorCount()).toBe(0);
  });

  it('still returns the saved place and restores focus when the pass settles mid-watch', async () => {
    vi.useFakeTimers();
    scrollValue = 200;
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    await render({ processing: true });
    appendPass(500);
    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(nav().getAttribute('data-watch')).toBe('on');

    // The pass ends under the reader: the item becomes the record's link …
    await render({ processing: false, change: CHANGE });
    expect(nav().getAttribute('data-pass')).toBe('record');
    expect(nav().getAttribute('data-watch')).toBe('on');
    const record = passItem() as HTMLAnchorElement;
    expect(record.getAttribute('href')).toBe('#проход-chg_7');

    // … and it is still the way back, not a second door (#156 M2).
    await act(async () => {
      record.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: 'auto' });
    expect(nav().getAttribute('data-watch')).toBe('off');
    expect(document.activeElement).toBe(record);
    expect(errorCount()).toBe(0);
  });

  it('enters a new pass after a watch that was never returned, not the old place', async () => {
    vi.useFakeTimers();
    scrollValue = 200;
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    await render({ processing: true, chapter: 7 });
    const pass = appendPass(500);
    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(nav().getAttribute('data-watch')).toBe('on');
    // The entrance's own lockout has to be over before a second entrance can be asked for.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    // The pass settles, then a different one begins: another chapter, another change.
    await render({ processing: false, chapter: 7, change: CHANGE });
    pass.getBoundingClientRect = () => rectAt(900);
    await render({ processing: true, chapter: 12, change: { ...CHANGE, id: 'chg_8' } });
    expect(nav().getAttribute('data-watch')).toBe('off');

    // The item enters the new pass: the old saved place is not this entrance's exit.
    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    expect(nav().getAttribute('data-watch')).toBe('entering');
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    // top(#pass) = 900 + 200 = 1 100, less the head's 64 + 16.
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_020, behavior: 'auto' });
    expect(nav().getAttribute('data-watch')).toBe('on');
    expect(errorCount()).toBe(0);
  });

  it('cancels an entrance in flight when a different pass begins', async () => {
    vi.useFakeTimers();
    scrollValue = 200;
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    await render({ processing: true, chapter: 7 });
    appendPass(500);
    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    expect(nav().getAttribute('data-watch')).toBe('entering');
    expect(container.querySelector('.foot-veil')).not.toBeNull();

    // A new pass starts inside the 120 ms cut: the old entrance is cancelled, not landed.
    await render({ processing: true, chapter: 12, change: { ...CHANGE, id: 'chg_9' } });
    expect(nav().getAttribute('data-watch')).toBe('off');
    expect(container.querySelector('.foot-veil')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(nav().getAttribute('data-watch')).toBe('off');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(errorCount()).toBe(0);
  });

  it('restores focus to the nav itself when the third item goes inert under the reader', async () => {
    vi.useFakeTimers();
    scrollValue = 200;
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    await render({ processing: true, change: CHANGE });
    appendPass(500);
    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    await render({ processing: false, change: CHANGE });
    expect(nav().getAttribute('tabindex')).toBe('-1');

    await act(async () => {
      (passItem() as HTMLAnchorElement).click();
    });
    // The feed empties before the veil lifts: the cell has no target at all.
    await render({ processing: false, change: null });
    expect(passItem().tagName).toBe('SPAN');
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(document.activeElement).toBe(nav());
    expect(errorCount()).toBe(0);
  });
});
