// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BOOK-63 — a chapter deep link opens once and reports only the chapter number.
 *
 * `#ch-12` is the element id the chapter already has; `#правка-…`, a typo and a number
 * outside the book open nothing and report nothing.
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({ matches: false, media: '', addEventListener: () => undefined, removeEventListener: () => undefined }));
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scroll, configurable: true });
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
    const chapter = document.createElement('section');
    chapter.id = 'ch-12';
    document.body.append(chapter);

    await act(async () => root.render(<Probe ready={false} />));
    expect(track).not.toHaveBeenCalled();

    await act(async () => root.render(<Probe ready />));
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
      expect(track, hash).not.toHaveBeenCalled();
    }
  });
});
