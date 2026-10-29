// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setChangeOpener } from '../lib/changeDoor.ts';
import { formatDayMonth } from '../lib/format.ts';
import { FootJumps, type FootJumpsProps } from './FootJumps.tsx';

/**
 * BOOK-156 — the grip under a browser.
 *
 * The surface is extracted from `App`, so the three jumps and the row's own clock are provable
 * without a socket, the catalogue and the whole page. The thresholds are `lib/grip.test.ts`'s,
 * the geometry is `footJumpsGeom.test.ts`'s and the door is `footJumpsDoor.dom.test.tsx`'s;
 * this file proves the markup and the attributes the reader's eye reads.
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

describe('the grip is a landmark with real anchors', () => {
  it('renders one nav named «переходы» with #toc, #discussion and #pass as links', async () => {
    await render({ processing: true });
    const landmark = nav();
    expect(landmark.tagName).toBe('NAV');
    expect(landmark.getAttribute('aria-label')).toBe('переходы');
    expect(landmark.getAttribute('data-open')).toBe('false');
    expect(landmark.getAttribute('data-pass')).toBe('live');
    expect(landmark.getAttribute('data-watch')).toBe('off');
    // The nav is a programmatic focus target: the return lands here when the third cell has
    // no target of its own (#156 M2).
    expect(landmark.getAttribute('tabindex')).toBe('-1');
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a.foot-jump')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#toc', '#discussion', '#pass']);
    // The visible word is the item's own; the meta line under it is the state, not a second name.
    expect(links.map((link) => link.querySelector('.foot-jump-word')?.textContent)).toEqual([
      'оглавление',
      'обсуждение',
      'каретки',
    ]);
    // The words are the whole of the nav: no number, no colour word, no state word beside it.
    for (const word of ['лайв', 'онлайн', 'эфир', 'синяя', 'красная']) {
      expect(landmark.textContent ?? '').not.toContain(word);
    }
    expect(errorCount()).toBe(0);
  });

  it('drops the item whose target does not exist', async () => {
    // No reader change ever: the register is not rendered and the pass never ran.
    await render({ live: false });
    const hrefs = [...container.querySelectorAll<HTMLAnchorElement>('a.foot-jump')].map((link) =>
      link.getAttribute('href'),
    );
    expect(hrefs).toEqual(['#toc']);
    expect(container.querySelector('.foot-jump-pass')).toBeNull();
    // The nav says what is true: the third item is not there, so the state is `absent`.
    expect(nav().getAttribute('data-pass')).toBe('absent');
    expect(errorCount()).toBe(0);
  });

  it('renders nothing at all while the capacity plate owns the bottom', async () => {
    await render({ plate: true, processing: true });
    expect(container.innerHTML).toBe('');
    expect(errorCount()).toBe(0);
  });
});

describe('the third item tells the truth', () => {
  it('is an inert word — no href, not focusable — with «пока не писалась» when no pass is running', async () => {
    await render();
    const item = passItem();
    expect(item.tagName).toBe('SPAN');
    expect(item.hasAttribute('href')).toBe(false);
    expect(item.hasAttribute('tabindex')).toBe(false);
    expect(item.textContent).toBe('кареткипока не писалась');
    expect(nav().getAttribute('data-pass')).toBe('silent');
    expect(errorCount()).toBe(0);
  });

  it('points at the record and prints the pass’s day when nothing runs', async () => {
    await render({ change: CHANGE });
    const item = passItem();
    expect(item.tagName).toBe('A');
    expect(item.getAttribute('href')).toBe('?change=chg_7');
    expect(item.textContent).toBe('кареткиписалась · 25.10');
    expect(item.textContent).toContain(`писалась · ${formatDayMonth(CHANGE.decidedAt)}`);
    expect(nav().getAttribute('data-pass')).toBe('record');
    expect(errorCount()).toBe(0);
  });

  it('opens the change’s record from the carets without navigation', async () => {
    const open = vi.fn();
    setChangeOpener(open);
    try {
      await render({ change: CHANGE });
      const item = passItem() as HTMLAnchorElement;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      await act(async () => {
        item.dispatchEvent(event);
      });
      // The page's own door takes the click: no browser navigation, the record at the sentence.
      expect(event.defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith('chg_7');
    } finally {
      setChangeOpener(null);
    }
  });

  it('speaks the state in its accessible name, and the visible word is inside it', async () => {
    await render({ change: CHANGE });
    expect(passItem().getAttribute('aria-label')).toBe('каретки · писалась · 25.10');
    await render({ change: null });
    expect(passItem().getAttribute('aria-label')).toBe('каретки · пока не писалась');
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
