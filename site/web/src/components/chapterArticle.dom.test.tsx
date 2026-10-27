// @vitest-environment jsdom
import type { CatalogEntry } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { estimateChapterHeight } from '../lib/layout.ts';
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

describe('the chapter skeleton under a browser', () => {
  it('writes the reserved height onto the placeholder through CSSOM', async () => {
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={ENTRY} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} />);
    });

    const placeholder = container.querySelector<HTMLElement>('.ch-placeholder');
    expect(placeholder).not.toBeNull();
    const expected = estimateChapterHeight(ENTRY.chars, window.innerWidth || 390);
    expect(expected).toBeGreaterThan(1_000);
    expect(placeholder?.style.minHeight).toBe(`${expected}px`);
  });

  it('renders an empty slot with no placeholder at all', async () => {
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, written: false }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} />);
    });

    expect(container.querySelector('.ch-placeholder')).toBeNull();
  });
});
