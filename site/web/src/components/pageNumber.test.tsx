// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PageNumber } from './PageNumber.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * BOOK-89, BOOK-104 — the leaf that prints the running page. It is presentational: the
 * number arrives from the header's `useReading`, so the leaf itself holds no scroll listener
 * and no arithmetic. Here it is handed one number at a time; the scroll-driven numbers are
 * proven with the header in `headerReading.dom.test.tsx`.
 */

let root: Root | null = null;
let container: HTMLDivElement;

function mount(page: number | null): void {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root?.render(<PageNumber page={page} />));
}

function folio(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.folio');
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PageNumber', () => {
  it('renders nothing where no page exists', () => {
    mount(null);
    expect(folio()).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('prints the bare numeral, hidden from assistive tech and carrying no style', () => {
    mount(7);
    const mark = folio();
    expect(mark).not.toBeNull();
    expect(mark?.tagName).toBe('SPAN');
    expect(mark?.className).toBe('folio');
    expect(mark?.textContent).toBe('7');
    expect(mark?.getAttribute('data-page')).toBe('7');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    // The page is a projection, not a laid-out box: no inline style, no «стр.», no total.
    expect(mark?.getAttribute('style')).toBeNull();
    expect(mark?.textContent).not.toMatch(/стр|с\.|из/u);
  });

  it('takes a new number without holding the old one', () => {
    mount(2);
    expect(folio()?.textContent).toBe('2');
    act(() => root?.render(<PageNumber page={3} />));
    expect(folio()?.textContent).toBe('3');
    expect(folio()?.getAttribute('data-page')).toBe('3');
    act(() => root?.render(<PageNumber page={null} />));
    expect(folio()).toBeNull();
  });
});
