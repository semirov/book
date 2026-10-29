// @vitest-environment jsdom
import { AUTHOR_COLORS, type CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Discussion } from './Discussion.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * BOOK-207 — the discussion shows the last five filings, newest first, and one door to the
 * rest. The five are the feed's own order; the door expands the same list in place, and the
 * header never counts a page it did not read in full.
 */
describe('the last five and the door to the rest (BOOK-207)', () => {
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (host !== null) {
      act(() => {
        host?.remove();
      });
    }
    host = null;
  });

  function comment(overrides: Partial<CommentDto> = {}): CommentDto {
    return {
      id: 'cmt_1',
      chapter: 8,
      anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
      author: 'Аня',
      authorColor: AUTHOR_COLORS[0],
      body: 'Тут дважды «слово».',
      proposedText: null,
      interventionKind: null,
      premise: false,
      status: 'new',
      frame: 'untouched',
      reason: null,
      createdAt: '2026-10-25T12:04:11Z',
      decidedAt: null,
      changeId: null,
      applied: null,
      refusal: null,
      attempt: null,
      ...overrides,
    };
  }

  function filingsOf(count: number): CommentDto[] {
    return Array.from({ length: count }, (_, index) =>
      comment({
        id: `cmt_${String(index + 1).padStart(3, '0')}`,
        body: `замечание номер ${index + 1}`,
        createdAt: `2026-10-2${index % 10}T12:04:11Z`,
      }),
    );
  }

  function mount(comments: readonly CommentDto[], complete: boolean): void {
    host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    act(() => {
      root.render(<Discussion depth={0} comments={comments} complete={complete} live />);
    });
  }

  function rows(): Element[] {
    return [...(host?.querySelectorAll('ol.comments > li.comment') ?? [])];
  }

  function meta(): string {
    return host?.querySelector('.sec-meta')?.textContent ?? '';
  }

  it('shows five rows, says «показаны последние 5» and opens the rest in place', () => {
    mount(filingsOf(7), true);
    expect(rows()).toHaveLength(5);
    expect(meta()).toBe('показаны последние 5');
    // The feed arrives oldest-first; the page prints the newest five, newest first.
    expect(rows()[0]?.getAttribute('data-comment-id')).toBe('cmt_007');
    expect(rows()[4]?.getAttribute('data-comment-id')).toBe('cmt_003');

    const door = host?.querySelector<HTMLButtonElement>('button.comments-all');
    expect(door?.textContent).toBe('все замечания');
    expect(door?.getAttribute('aria-expanded')).toBe('false');
    expect(door?.getAttribute('aria-controls')).toBe('discussion-list');
    expect(host?.querySelector('ol.comments')?.id).toBe('discussion-list');

    act(() => door?.click());
    expect(rows()).toHaveLength(7);
    expect(meta()).toBe('7 замечаний');
    expect(host?.querySelector('button.comments-all')?.textContent).toBe('свернуть');
    expect(host?.querySelector('button.comments-all')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('prints no door for exactly five, and counts them', () => {
    mount(filingsOf(5), true);
    expect(rows()).toHaveLength(5);
    expect(meta()).toBe('5 замечаний');
    expect(host?.querySelector('button.comments-all')).toBeNull();
  });

  it('prints no door for five on a partial page, and says the five it shows', () => {
    // The page may hold older filings, but no sixth row is here to reveal: the sentence is
    // «показаны последние 5» and the door waits for an «older filings» path (backlog).
    mount(filingsOf(5), false);
    expect(rows()).toHaveLength(5);
    expect(meta()).toBe('показаны последние 5');
    expect(host?.querySelector('button.comments-all')).toBeNull();
  });

  it('says «замечаний нет» for a complete empty thread', () => {
    mount([], true);
    expect(rows()).toHaveLength(0);
    expect(meta()).toBe('замечаний нет');
  });
});
