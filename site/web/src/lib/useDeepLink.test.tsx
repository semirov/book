// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BOOK-63 — a chapter deep link opens once and reports only the chapter number.
 *
 * `#ch-12` is the element id the chapter already has; `?change=…` is another surface, and a typo or a number
 * outside the book open nothing and report nothing.
 *
 * BOOK-168 — a copied *place* names the paragraph (`#ch-3-b12`), and the address bar can change
 * while the page is open: both land with the page's own measurement, once, and a fragment that
 * moved nothing is not reported as an open. A cold place fragment jumps to the chapter's mouth
 * first (which starts the chapter's own read) and lands the paragraph when it arrives; a
 * back/forward re-runs the landing for the hash it names.
 */

vi.mock('./analytics.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./analytics.ts')>();
  return { ...actual, track: vi.fn() };
});

import { track } from './analytics.ts';
import { useDeepLink } from './useDeepLink.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ ready, restore }: { ready: boolean; restore?: (state: unknown) => boolean }) {
  useDeepLink(ready, restore);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const scroll = vi.fn();
/** The frames the page has not spent yet: a landing's wait is driven here, one frame at a time. */
let frames: FrameRequestCallback[] = [];

function box(element: HTMLElement, top: number, height: number): HTMLElement {
  element.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  return element;
}

/** The chapter slot the catalogue paints, with one paragraph inside it. */
function chapter(n: number, blockIndex: number | null = null): void {
  const section = document.createElement('section');
  section.id = `ch-${String(n)}`;
  box(section, 1000, 900);
  document.body.append(section);
  if (blockIndex === null) return;
  const paragraph = document.createElement('p');
  paragraph.id = `ch-${String(n)}-b${String(blockIndex)}`;
  box(paragraph, 1400, 40);
  section.append(paragraph);
}

/** jsdom fires `hashchange` as a task: one turn of the clock is enough to see it. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

/** Spend the frames a landing is waiting for: the page's clock, one frame at a time. */
async function pump(times: number): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      const due = frames;
      frames = [];
      for (const callback of due) callback(index * 16);
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  frames = [];
  vi.stubGlobal('matchMedia', () => ({ matches: false, media: '', addEventListener: () => undefined, removeEventListener: () => undefined }));
  // The jump is one `window.scrollTo` at the measured offset (`dom.ts` `scrollToChapter`): the
  // page, not the element, owns the arithmetic now.
  Object.defineProperty(window, 'scrollTo', { value: scroll, configurable: true });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 0 });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.location.hash = '';
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('useDeepLink', () => {
  it('opens the chapter once the catalogue is ready', async () => {
    window.location.hash = '#ch-12';
    chapter(12);

    await act(async () => root.render(<Probe ready={false} />));
    expect(track).not.toHaveBeenCalled();

    await act(async () => root.render(<Probe ready />));
    await settle();
    expect(track).toHaveBeenCalledWith('deep_link_open', { chapter: 12 });
    expect(scroll).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Probe ready />));
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('ignores a hash that is not a chapter of this book', async () => {
    for (const hash of ['#ch-0', '#ch-68', '#правка-cmt_1', '#чужое']) {
      window.location.hash = hash;
      await act(async () => root.render(<Probe ready={false} />));
      await act(async () => root.render(<Probe ready />));
      await settle();
      expect(track, hash).not.toHaveBeenCalled();
    }
  });

  it('lands the paragraph a place fragment names, on the reading line', async () => {
    window.location.hash = '#ch-3-b12';
    chapter(3, 12);

    await act(async () => root.render(<Probe ready />));
    await settle();

    expect(scroll).toHaveBeenCalledTimes(1);
    // The paragraph's top (1 400) at the reading line: no head on this page, so the landing air
    // alone (`LANDING_PX`, 16 px) — the same sum `landingScroll` states as numbers. One jump.
    expect(scroll.mock.calls[0]?.[0]).toEqual({ top: 1384, behavior: 'auto' });
    expect(track).toHaveBeenCalledWith('deep_link_open', { chapter: 3 });
  });

  it('jumps to the chapter’s mouth first when the paragraph has not been read yet', async () => {
    // A cold load: the chapter is on the page, its prose is not. The chapter's own read starts
    // when the slot comes near the viewport, so the landing goes there and waits.
    window.location.hash = '#ch-3-b12';
    chapter(3);

    await act(async () => root.render(<Probe ready />));
    await settle();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls[0]?.[0]).toEqual({ top: 984, behavior: 'auto' });
    expect(track).not.toHaveBeenCalled();

    // The read commits the paragraph a few frames later: the landing finishes on it.
    const paragraph = document.createElement('p');
    paragraph.id = 'ch-3-b12';
    box(paragraph, 1400, 40);
    document.getElementById('ch-3')?.append(paragraph);
    await pump(3);

    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll.mock.calls[1]?.[0]).toEqual({ top: 1384, behavior: 'auto' });
    expect(track).toHaveBeenCalledWith('deep_link_open', { chapter: 3 });
  });

  it('opens a fragment the address bar gains while the page is open', async () => {
    chapter(5);

    await act(async () => root.render(<Probe ready />));
    await settle();
    expect(track).not.toHaveBeenCalled();

    window.location.hash = '#ch-5';
    await settle();

    expect(track).toHaveBeenCalledWith('deep_link_open', { chapter: 5 });
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('re-runs the landing once for a back/forward, and not twice for the same hash', async () => {
    chapter(7);

    await act(async () => root.render(<Probe ready />));
    await settle();
    expect(scroll).not.toHaveBeenCalled();

    // Back/forward: the browser fires `popstate`, and the hash it restored is landed once.
    history.replaceState(null, '', '#ch-7');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(track).toHaveBeenCalledWith('deep_link_open', { chapter: 7 });
    expect(scroll).toHaveBeenCalledTimes(1);

    // The same hash again (another popstate on the same entry): nothing to act on.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('gives a popstate that carries a place to the position layer, and marks its hash acted on', async () => {
    // BOOK-209 — the entry's own place wins over the fragment's nominal anchor, and the
    // `hashchange` that follows the same entry is not a second open of the same chapter.
    chapter(7);
    const restore = vi.fn((state: unknown): boolean => state !== null);
    await act(async () => root.render(<Probe ready restore={restore} />));
    await settle();
    expect(scroll).not.toHaveBeenCalled();

    history.replaceState({ bookPlace: { chapter: 7 } }, '', '#ch-7');
    const state = { bookPlace: { chapter: 7 } };
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state }));
    });
    await settle();
    expect(restore).toHaveBeenCalledWith(state);
    // Claimed: the fragment is not landed here, the position layer owns the landing.
    expect(scroll).not.toHaveBeenCalled();

    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await settle();
    expect(scroll).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('consults the restore seam on every popstate, and lands the fragment when it declines', async () => {
    chapter(7);
    const restore = vi.fn(() => false);
    await act(async () => root.render(<Probe ready restore={restore} />));
    await settle();
    // The entry the browser restores names a chapter and carries no place of its own.
    history.replaceState(null, '', '#ch-7');

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    await settle();
    expect(restore).toHaveBeenCalledWith(null);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('deep_link_open', { chapter: 7 });
  });

  it('claims no open for a fragment that moved nothing', async () => {
    // No chapter 42 on this page: the link lands nowhere, so it is not reported as an open.
    window.location.hash = '#ch-42';
    await act(async () => root.render(<Probe ready />));
    await settle();

    expect(track).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });
});
