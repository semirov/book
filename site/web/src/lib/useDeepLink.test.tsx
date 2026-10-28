// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BOOK-63 — a chapter deep link opens once and reports only the chapter number.
 *
 * `#ch-12` is the element id the chapter already has; `#правка-…`, a typo and a number
 * outside the book open nothing and report nothing.
 *
 * BOOK-168 — a copied *place* names the paragraph (`#ch-3-b12`), and the address bar can change
 * while the page is open: both land with the page's own measurement, once, and a fragment that
 * moved nothing is not reported as an open.
 */

vi.mock('./analytics.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./analytics.ts')>();
  return { ...actual, track: vi.fn() };
});

import { track } from './analytics.ts';
import { useDeepLink } from './useDeepLink.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ ready }: { ready: boolean }) {
  useDeepLink(ready);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const scroll = vi.fn();

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
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({ matches: false, media: '', addEventListener: () => undefined, removeEventListener: () => undefined }));
  // The jump is one `window.scrollTo` at the measured offset (`dom.ts` `scrollToChapter`): the
  // page, not the element, owns the arithmetic now.
  Object.defineProperty(window, 'scrollTo', { value: scroll, configurable: true });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 0 });
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
    // The paragraph's top (1 400) at the reading line: no head on this page, so the breathing
    // space alone (8 px) — the same sum `landingScroll` states as numbers.
    expect(scroll.mock.calls[0]?.[0]).toEqual({ top: 1392, behavior: 'smooth' });
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

  it('claims no open for a fragment that moved nothing', async () => {
    // No chapter 42 on this page: the link lands nowhere, so it is not reported as an open.
    window.location.hash = '#ch-42';
    await act(async () => root.render(<Probe ready />));
    await settle();

    expect(track).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });
});
