// @vitest-environment jsdom
import { IMPRINT_AUTHOR, IMPRINT_COPYRIGHT, type StateSnapshot } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureCounter } from '../lib/analytics.ts';
import { CONSENT_COPY, resetConsent, setConsent } from '../lib/consent.ts';
import { Colophon } from './Colophon.tsx';
import { ConsentBanner } from './ConsentBanner.tsx';

/**
 * BOOK-63 — the banner is book matter with two real buttons.
 *
 * The copy is the researcher's line verbatim, the link goes to /privacy, the choice is
 * made by a click (no pre-checked state, no «продолжая пользоваться»), the strip disappears
 * once a choice exists, and «изменить» in the colophon brings it back.
 *
 * BOOK-77 (F2): a withdrawal after a live tag reloads the page. jsdom cannot navigate, so the
 * test supplies the page — and reads the request the teardown makes.
 */

const state = {
  chapters: { total: 67, written: [], empty: [], count: 0, totalChars: 0 },
} as unknown as StateSnapshot;
const imprint = { author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT };

const COUNTER = '113820311';
const reload = vi.fn();
vi.stubGlobal('location', { hostname: 'book.semirov.dev', reload });
configureCounter(COUNTER);

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <>
        <ConsentBanner />
        <Colophon state={state} imprint={imprint} />
      </>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no button «${label}»`);
  return found;
}

function banner(): Element | null {
  return container.querySelector('[data-consent="ask"]');
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetConsent();
  document.head.querySelectorAll('script[src*="mc.yandex.ru"]').forEach((element) => element.remove());
  delete (globalThis as { ym?: unknown }).ym;
  localStorage.clear();
});

describe('the consent strip', () => {
  it('is book matter with the consent copy, two buttons and the privacy link', () => {
    mount();
    const element = banner();
    expect(element).not.toBeNull();
    expect(element?.getAttribute('style')).toBeNull();
    expect(container.textContent).toContain(CONSENT_COPY);
    expect(container.textContent).toContain('Разрешить');
    expect(container.textContent).toContain('Только необходимое');
    expect(container.querySelector('a[href="/privacy"]')).not.toBeNull();
    // Not a modal: no dialog role, no scrim, no modal flag.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('disappears on «Разрешить» and requests the tag once', () => {
    mount();
    act(() => button('Разрешить').click());
    expect(banner()).toBeNull();
    expect(document.querySelectorAll('script[src*="mc.yandex.ru"]')).toHaveLength(1);
  });

  it('disappears on «Только необходимое» and requests nothing', () => {
    mount();
    act(() => button('Только необходимое').click());
    expect(banner()).toBeNull();
    expect(document.querySelectorAll('script[src*="mc.yandex.ru"]')).toHaveLength(0);
  });

  it('comes back when the choice is reset from the colophon', () => {
    mount();
    act(() => button('Только необходимое').click());
    expect(container.textContent).toContain('аналитика: выключена · изменить');

    act(() => button('изменить').click());
    expect(banner()).not.toBeNull();
  });

  it('says «включена» in the colophon after a yes, and still offers the change', () => {
    mount();
    act(() => button('Разрешить').click());
    expect(container.textContent).toContain('аналитика: включена · изменить');
    act(() => button('изменить').click());
    expect(banner()).not.toBeNull();
  });

  it('is absent when the deployment has no counter at all', () => {
    act(() => configureCounter(null));
    mount();
    expect(banner()).toBeNull();
    expect(container.textContent).not.toContain('аналитика:');
    act(() => configureCounter(COUNTER));
  });

  it('does not ask again after a recorded choice on a fresh page', () => {
    setConsent('granted');
    mount();
    expect(banner()).toBeNull();
    act(() => root.unmount());
    container.remove();
    mount();
    expect(banner()).toBeNull();
  });
});
