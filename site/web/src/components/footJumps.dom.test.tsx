// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FootJumps, type FootJumpsProps } from './FootJumps.tsx';

/**
 * BOOK-156 / BOOK-207 — the grip under a browser.
 *
 * The surface is extracted from `App`, so the three jumps and the row's own clock are provable
 * without a socket, the catalogue and the whole page. The thresholds are `lib/grip.test.ts`'s
 * and the geometry is `footJumpsGeom.test.ts`'s; this file proves the markup the reader meets:
 * `оглавление · обсуждение · след`, the `след` item always present, and the row's own clock.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DEFAULTS: FootJumpsProps = { live: true, plate: false };

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

const nav = (): HTMLElement => container.querySelector('nav') as HTMLElement;

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

describe('the grip is a landmark with real anchors', () => {
  it('renders one nav named «переходы» with #toc, #discussion and #след as links', async () => {
    await render();
    const landmark = nav();
    expect(landmark.tagName).toBe('NAV');
    expect(landmark.getAttribute('aria-label')).toBe('переходы');
    expect(landmark.getAttribute('data-open')).toBe('false');
    expect(landmark.getAttribute('tabindex')).toBe('-1');
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a.foot-jump')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#toc', '#discussion', '#след']);
    expect(links.map((link) => link.querySelector('.foot-jump-word')?.textContent)).toEqual([
      'оглавление',
      'обсуждение',
      'след',
    ]);
    // No state word, no cell, no numeral beside the words.
    for (const word of ['каретки', 'пока не писалась', 'пишется', 'писалась']) {
      expect(landmark.textContent ?? '').not.toContain(word);
    }
    expect(errorCount()).toBe(0);
  });

  it('keeps «след» when there is no reader change, and drops «обсуждение»', async () => {
    await render({ live: false });
    const hrefs = [...container.querySelectorAll<HTMLAnchorElement>('a.foot-jump')].map((link) =>
      link.getAttribute('href'),
    );
    expect(hrefs).toEqual(['#toc', '#след']);
    expect(errorCount()).toBe(0);
  });

  it('renders nothing at all while the capacity plate owns the bottom', async () => {
    await render({ plate: true });
    expect(container.innerHTML).toBe('');
    expect(errorCount()).toBe(0);
  });
});

describe('the row', () => {
  it('opens on a tap on the paper, on focus, and closes at 3 200 ms and on 48 px of scroll', async () => {
    vi.useFakeTimers();
    await render();
    const expander = container.querySelector<HTMLButtonElement>('.foot-jumps-open');
    expect(expander?.getAttribute('tabindex')).toBe('-1');
    expect(expander?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => {
      expander?.click();
    });
    expect(nav().getAttribute('data-open')).toBe('true');

    await act(async () => {
      vi.advanceTimersByTime(3_200);
    });
    expect(nav().getAttribute('data-open')).toBe('false');

    // A keyboard reader who tabs in gets the row at once (the 320 ms lockout has passed).
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const toc = container.querySelector<HTMLAnchorElement>('a[href="#toc"]');
    await act(async () => {
      toc?.focus();
    });
    expect(nav().getAttribute('data-open')).toBe('true');
    expect(nav().getAttribute('data-cut')).toBe('true');

    // A 48 px scroll closes it; 400 ms of fake time keeps the 320 ms lockout out of the way.
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    scrollValue = 48;
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(nav().getAttribute('data-open')).toBe('false');
    expect(errorCount()).toBe(0);
  });

  it('still closes after 3 200 ms under reduced motion — a dwell is not motion', async () => {
    vi.useFakeTimers();
    stillMotion();
    await render();
    const expander = container.querySelector<HTMLButtonElement>('.foot-jumps-open');
    await act(async () => {
      expander?.click();
    });
    expect(nav().getAttribute('data-open')).toBe('true');
    // `prefers-reduced-motion` zeroes the durations, never the timer the reader's quiet asks for.
    await act(async () => {
      vi.advanceTimersByTime(3_200);
    });
    expect(nav().getAttribute('data-open')).toBe('false');
    expect(errorCount()).toBe(0);
  });

  it('closes on blur and on an outside pointerdown the page still receives', async () => {
    vi.useFakeTimers();
    await render();
    const toc = container.querySelector<HTMLAnchorElement>('a[href="#toc"]');
    await act(async () => {
      toc?.focus();
    });
    expect(nav().getAttribute('data-open')).toBe('true');

    // A focus that leaves the nav is a blur: the row closes (past the 320 ms lockout).
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const away = document.createElement('button');
    document.body.append(away);
    await act(async () => {
      away.focus();
    });
    expect(nav().getAttribute('data-open')).toBe('false');

    // Open again, past the lockout, then tap the prose: the row closes and the tap is the
    // page's — a capture listener that called `preventDefault` would eat «вмешаться».
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => {
      toc?.focus();
    });
    expect(nav().getAttribute('data-open')).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    let reached = 0;
    const prose = document.createElement('p');
    prose.addEventListener('pointerdown', () => {
      reached += 1;
    });
    document.body.append(prose);
    const tap = new Event('pointerdown', { bubbles: true, cancelable: true });
    await act(async () => {
      prose.dispatchEvent(tap);
    });
    expect(nav().getAttribute('data-open')).toBe('false');
    expect(reached).toBe(1);
    expect(tap.defaultPrevented).toBe(false);
    expect(errorCount()).toBe(0);
  });

  it('lands a deferred entrance after a flick without waiting for another scroll', async () => {
    vi.useFakeTimers();
    await render();
    // A flick: 300 px in 100 ms is 3 000 px/s, and no sample says the page has stopped.
    scrollValue = 300;
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    scrollValue = 600;
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });

    // A tap on the paper arrives while the momentum is still «running»: remembered, not applied.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.foot-jumps-open')?.click();
    });
    expect(nav().getAttribute('data-open')).toBe('false');

    // One 100 ms tick is enough: a stale sample is stillness (BOOK-156 fix B1).
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(nav().getAttribute('data-open')).toBe('true');
    expect(errorCount()).toBe(0);
  });
});
