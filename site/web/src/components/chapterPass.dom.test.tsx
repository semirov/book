// @vitest-environment jsdom
import type { BlockRevisingPayload, CatalogEntry, ChapterDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-156 (#3802 §4) — the live pass's own anchor.
 *
 * The grip's third item may only point at a promise the page keeps *now*: `#pass` exists on
 * the first line of the block a pass is revising, and nowhere else — no pass, no anchor.
 *
 * It lives in its own file because `chapterArticle.dom.test.tsx` sits at `arch`'s 500-line
 * ceiling; the mount is the same shape and the fixtures are local, so the two files cannot
 * drift into each other.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Comes into view at once: the prose is fetched and lands without a printing loop. */
class EagerObserver {
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ENTRY: CatalogEntry = {
  n: 1,
  part: 1,
  title: 'Тестовая глава',
  rev: 1,
  chars: 40,
  blocks: 2,
  written: true,
  basis: false,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const CHAPTER: ChapterDto = {
  n: 1,
  title: 'Тестовая глава',
  rev: 1,
  chars: 40,
  basis: false,
  blocks: [
    { id: 'ch01#aaaa1111', i: 0, text: 'Первая фраза главы.', hash: 'a' },
    { id: 'ch01#bbbb2222', i: 1, text: 'Второе предложение главы.', hash: 'b' },
  ],
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
};

let root: Root | null = null;
let view: HTMLDivElement | null = null;

/** Mount once, then re-render with another pass state: the chapter itself is kept. */
async function draw(revising: BlockRevisingPayload | null): Promise<HTMLDivElement> {
  if (view === null) {
    view = document.createElement('div');
    document.body.append(view);
    root = createRoot(view);
  }
  await act(async () => {
    root?.render(
      <ChapterArticle
        entry={ENTRY}
        revision={null}
        revising={revising}
        caret={null}
        fresh={false}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        history
      />,
    );
  });
  await flush();
  return view;
}

/** One pass frame: the block it is revising, and whether it is still live. */
function livePass(active: boolean): BlockRevisingPayload {
  return {
    n: 1,
    active,
    blockIds: ['ch01#bbbb2222'],
    cause: 'draft',
    changeId: 'chg_1',
    lane: 'forward',
    since: '2026-10-25T09:20:00Z',
    expiresAt: '2026-10-25T09:40:00Z',
  };
}

beforeEach(() => {
  stillMotion();
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => CHAPTER })));
  vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  view = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BOOK-156 — the live pass’s own anchor', () => {
  it('marks the live block’s first line with #pass, and drops it when the pass settles', async () => {
    const page = await draw(livePass(true));

    const anchor = page.querySelector('#pass');
    expect(anchor).not.toBeNull();
    // The anchor sits on the first line of the block the pass is revising, not on the chapter.
    expect(anchor?.nextElementSibling?.getAttribute('data-block-id')).toBe('ch01#bbbb2222');
    expect(anchor?.getAttribute('aria-hidden')).toBe('true');

    // The pass settled: no anchor, so the grip's third item can never point at `#pass`.
    await draw(null);
    expect(page.querySelector('#pass')).toBeNull();

    // A payload that is already settled carries no anchor either.
    await draw(livePass(false));
    expect(page.querySelector('#pass')).toBeNull();
  });
});
