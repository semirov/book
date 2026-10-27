// @vitest-environment jsdom
import { PAGE_CHARS, type CatalogEntry } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Header } from './Header.tsx';
import { PageNumber } from './PageNumber.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * BOOK-89 — the leaf that prints the running page. jsdom has no layout, so the geometry the
 * hook reads is stubbed: one chapter of two pages, starting below the opening screen.
 */

const VIEWPORT = 800;
/** One written chapter of two pages; `Header` wants the catalog entry, the leaf only its length. */
const catalog: CatalogEntry[] = [
  {
    n: 1,
    part: 1,
    title: null,
    rev: 1,
    chars: 2 * PAGE_CHARS,
    blocks: 1,
    written: true,
    basis: false,
    writtenAt: null,
    updatedAt: null,
    direction: 'forward',
  },
];

const layout = new Map<string, { top: number; height: number }>();

function stubRect(element: Element, key: string): void {
  const entry = layout.get(key) ?? { top: 0, height: 0 };
  element.getBoundingClientRect = () =>
    ({
      top: entry.top - window.scrollY,
      bottom: entry.top - window.scrollY + entry.height,
      height: entry.height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: entry.top - window.scrollY,
      toJSON: () => entry,
    }) as DOMRect;
}

let root: Root | null = null;
let container: HTMLDivElement;

function mount(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<PageNumber catalog={catalog} />));
}

function scrollTo(scroll: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: scroll });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

function folio(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.folio');
}

beforeEach(() => {
  document.body.innerHTML = `
    <article data-n="1" data-rev="1">
      <p data-block-id="a" data-chars="3600"></p>
    </article>
  `;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
  layout.clear();
  // The chapter opens below the cover and the contents: the folio has no page to show there.
  layout.set('article:1', { top: 500, height: 900 });
  layout.set('block:a', { top: 500, height: 900 });
  const article = document.querySelector('article');
  const block = document.querySelector('[data-block-id]');
  if (article !== null) stubRect(article, 'article:1');
  if (block !== null) stubRect(block, 'block:a');
  mount();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PageNumber', () => {
  it('renders nothing where no page exists', () => {
    expect(folio()).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('prints the bare numeral, hidden from assistive tech and carrying no style', () => {
    scrollTo(200); // line 520, inside the first chapter
    const mark = folio();
    expect(mark).not.toBeNull();
    expect(mark?.tagName).toBe('SPAN');
    expect(mark?.className).toBe('folio');
    expect(mark?.textContent).toBe('1');
    expect(mark?.getAttribute('data-page')).toBe('1');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    // The page is a projection, not a laid-out box: no inline style, no «стр.», no total.
    expect(mark?.getAttribute('style')).toBeNull();
    expect(mark?.textContent).not.toMatch(/стр|с\.|из/u);
  });

  it('follows the scroll to the chapter’s second page and writes no style on the way', () => {
    scrollTo(200);
    expect(folio()?.textContent).toBe('1');
    scrollTo(700); // line 1020 → past 1800 characters of the chapter
    expect(folio()?.textContent).toBe('2');
    expect(folio()?.getAttribute('data-page')).toBe('2');
    expect(folio()?.getAttribute('style')).toBeNull();
  });

  it('is mounted as the last item of the running head’s first row', () => {
    document.body.innerHTML = '';
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = `
      <article data-n="1" data-rev="1">
        <p data-block-id="a" data-chars="3600"></p>
      </article>
    `;
    const article = document.querySelector('article');
    const block = document.querySelector('[data-block-id]');
    if (article !== null) stubRect(article, 'article:1');
    if (block !== null) stubRect(block, 'block:a');

    const state = {
      engine: { status: 'unknown' },
      chapters: { count: 0 },
      activity: { lastFileChangeAt: null },
      queue: { depth: 0 },
      current: null,
      revising: [],
      unresolved: [],
    } as unknown as Parameters<typeof Header>[0]['state'];

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <Header state={state} ribbon={null} catalog={catalog} markers={[]} onOpenChange={() => undefined} />,
      ),
    );
    scrollTo(200);
    expect(container.querySelector('.top-row > .folio')).not.toBeNull();
  });
});
