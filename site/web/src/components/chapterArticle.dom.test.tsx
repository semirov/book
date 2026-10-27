// @vitest-environment jsdom
import type { CatalogEntry, ChapterDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { estimateChapterHeight } from '../lib/layout.ts';
import { CHAPTER_BOX_PX } from '../lib/skeleton.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-30 — the skeleton's height is a real CSSOM write.
 *
 * The server-render tests can only prove the markup has no style attribute; they would stay
 * green if the ref were dropped and the slot collapsed. This mounts the component in jsdom
 * and reads the inline style the browser actually gets.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The chapter never comes into view: the slot must reserve its height before any fetch. */
class IdleObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

/** Comes into view at once: the prose is fetched and the printing reveal starts. */
class EagerObserver {
  constructor(private readonly callback: (records: Array<{ isIntersecting: boolean }>) => void) {}
  observe(): void {
    this.callback([{ isIntersecting: true }]);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

const ENTRY: CatalogEntry = {
  n: 1,
  part: 1,
  title: 'Тестовая глава',
  rev: 1,
  chars: 22_628,
  blocks: 180,
  written: true,
  basis: false,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/**
 * BOOK-DOC-43 §4, §6, §7 — the chapter's wait (BOOK-66).
 *
 * The fetch stays pending until the test resolves it: the threshold is only provable while
 * nothing has landed. Two observers answer `isIntersecting: true`, because `load()` starts on
 * approach and a slot that never comes into view never waits. Reduced motion is stubbed on
 * purpose — the prose then arrives at once, so the commit that removes the placeholder is the
 * only thing under test (no printing loop, no rAF churn).
 */

/** The stubbed `prefers-reduced-motion` answer: the text lands set, not typing. */
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

class ApproachingObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

type Pending = { promise: Promise<Response>; resolve: (body: unknown) => void; reject: (error: Error) => void };

/** A request the test answers by hand: a deferred `fetch` keeps the wait open on purpose. */
function pendingFetch(): Pending {
  let settle: (body: unknown) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<Response>((resolve, reject) => {
    settle = (body) => resolve({ ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response);
    fail = (error) => reject(error);
  });
  return { promise, resolve: settle, reject: fail };
}

function chapter(n: number): ChapterDto {
  return {
    n,
    title: null,
    rev: 1,
    chars: 24,
    basis: false,
    blocks: [{ id: `ch${n}#1`, i: 0, text: 'Первая фраза главы.', hash: 'h1' }],
    writtenAt: '2026-10-25T09:20:00Z',
    updatedAt: '2026-10-25T09:20:00Z',
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the chapter wait under a browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stillMotion();
    vi.stubGlobal('IntersectionObserver', ApproachingObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing for 149 ms, then the form with one sentence, then the text', async () => {
    const wait = pendingFetch();
    const fetchMock = vi.fn(() => wait.promise);
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, n: 7 }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Nothing has waited long enough yet, and a request hangs while we count.
    expect(container.querySelector('.skel')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(149);
    });
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const skel = container.querySelector('.skel');
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute('data-lines')).toBe('8');
    expect(container.querySelectorAll('.skel-line')).toHaveLength(8);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('читаем главу 07');
    expect(container.querySelector('article')?.getAttribute('aria-busy')).toBe('true');

    // At 2 000 ms the same slot replaces the form's company with one plain sentence.
    await act(async () => {
      vi.advanceTimersByTime(1_851);
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'глава идёт дольше обычного · текст появится здесь же',
    );
    expect(container.querySelectorAll('.skel')).toHaveLength(1);

    // The text lands: the form goes in the same commit, with no fade out and no stale stage.
    await act(async () => {
      wait.resolve(chapter(7));
    });
    await flush();
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('article')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('drops the form the moment the fetch fails, and leaves the sentence and the retry', async () => {
    const wait = pendingFetch();
    vi.stubGlobal('fetch', vi.fn(() => wait.promise));
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, n: 7 }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(container.querySelector('.skel')).not.toBeNull();

    await act(async () => {
      wait.reject(new Error('offline'));
    });
    await flush();

    // A failure is not a longer wait: the error copy replaces the placeholder immediately.
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('.ch-placeholder')).toBeNull();
    expect(container.querySelector('.ch-fail')?.textContent).toContain('глава не загрузилась');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('article')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('keeps a basis slot silent: its frame is complete before the request', async () => {
    const wait = pendingFetch();
    vi.stubGlobal('fetch', vi.fn(() => wait.promise));
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, n: 67, written: false, basis: true, chars: 0, blocks: 1 }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });

    // The frozen frame is already the final text: a wait for its ids claims nothing.
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('article')?.hasAttribute('aria-busy')).toBe(false);
    await act(async () => {
      wait.resolve(chapter(67));
    });
    await flush();
  });
});

describe('the chapter skeleton under a browser', () => {
  it('writes the reserved height onto the placeholder through CSSOM', async () => {
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={ENTRY} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });

    const placeholder = container.querySelector<HTMLElement>('.ch-placeholder');
    expect(placeholder).not.toBeNull();
    const expected = estimateChapterHeight(ENTRY.chars, window.innerWidth || 390);
    expect(expected).toBeGreaterThan(1_000);
    expect(placeholder?.style.minHeight).toBe(`${expected}px`);
  });

  it('floors a short written chapter’s box at the form’s height, so the text cannot move the page', async () => {
    // §3 as corrected: `max(estimate, 279)`. A 49-char chapter estimates 120 px, and the form
    // (8 × 1.68em + 2 × 1.02em of the prose size) is taller than that — it would overrun the
    // box and the arriving text would move everything below it. jsdom has no layout, so the
    // form's height is read from the same geometry `skeleton.css` sets.
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    const viewport = window.innerWidth || 390;
    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, chars: 49 }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });

    const prose = viewport < 600 ? 17 : viewport < 1024 ? 17.5 : 18;
    const form = 8 * 1.68 * prose + 2 * 1.02 * prose;
    expect(estimateChapterHeight(49, viewport)).toBe(120);
    expect(CHAPTER_BOX_PX).toBe(279);
    expect(form).toBeLessThanOrEqual(CHAPTER_BOX_PX);
    const placeholder = container.querySelector<HTMLElement>('.ch-placeholder');
    expect(placeholder?.style.minHeight).toBe(`${CHAPTER_BOX_PX}px`);
  });

  it('prints «печатается» as a separate chip while the text arrives, and never «не написана»', async () => {
    // BOOK-70: the header's state chip is its own span, apart from the data line. The reveal
    // starts only in a browser, so this is where the printing state can be observed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          n: 1,
          title: 'Тестовая глава',
          rev: 1,
          chars: 40,
          basis: false,
          blocks: [
            { id: 'ch01#aaaa1111', i: 0, text: 'Первое предложение главы, которое печатается.', hash: 'a' },
            { id: 'ch01#bbbb2222', i: 1, text: 'Второе предложение главы.', hash: 'b' },
          ],
          writtenAt: '2026-10-25T09:20:00Z',
          updatedAt: '2026-10-25T09:20:00Z',
        }),
      })),
    );
    vi.stubGlobal('IntersectionObserver', EagerObserver);
    // The reveal asks the media query; jsdom does not implement it, and a throw there would
    // land in the load's `catch` and read as a failed chapter.
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, chars: 40 }} revision={null} revising={null} caret={null} fresh composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });
    // The load is a promise: let it settle, then read the header.
    await flush();

    const print = container.querySelector('.ch-print');
    expect(print?.textContent).toBe('■ печатается');
    expect(print?.closest('.ch-data')).toBeNull();
    expect(container.querySelector('.ch-data')?.textContent).toContain('12:20');
    expect(container.textContent).not.toContain('не написана');
  });

  it('renders an empty slot with no placeholder at all', async () => {
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, written: false }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });

    expect(container.querySelector('.ch-placeholder')).toBeNull();
  });
});
