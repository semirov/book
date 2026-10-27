// @vitest-environment jsdom
import type { CommentDto } from '@book/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useReaderFeed } from './useReaderFeed.ts';

/**
 * BOOK-111 — the posted row reaches the feed in the same frame.
 *
 * The pure insert is proven in `lib/filings.test.ts`; this is the hook's half: the DTO lands in
 * the thread's feed and in its chapter's, the chapter is marked loaded (its marks are settled
 * from this row), and a second acceptance changes nothing. No request is made here — the 201
 * answer is the fact.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const POSTED: CommentDto = {
  attempt: null,
  id: 'cmt_01M5Z8HKWHPHZQDHP5MCXS5RB4',
  chapter: 65,
  anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#6f9bb5',
  body: 'А как?',
  proposedText: null,
  interventionKind: null,
  premise: true,
  status: 'new',
  reason: null,
  refusal: null,
  createdAt: '2026-10-27T18:04:17Z',
  decidedAt: null,
  changeId: null,
  applied: null,
};

let root: Root | null = null;
let container: HTMLDivElement;
let feed: ReturnType<typeof useReaderFeed>;

function Probe(): null {
  feed = useReaderFeed();
  return null;
}

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root?.render(createElement(Probe)));
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('acceptComment (BOOK-111)', () => {
  it('puts the posted DTO in the thread and in its chapter, and marks the chapter loaded', () => {
    act(() => feed.acceptComment(POSTED));
    expect(feed.comments.map((row) => row.id)).toEqual([POSTED.id]);
    expect(feed.chapterFeed[65]).toEqual({ items: [POSTED], loaded: true });
    // No other chapter is touched: a filing is one chapter's business.
    expect(feed.chapterFeed[8]).toBeUndefined();
  });

  it('is idempotent: a second acceptance — or the durable refresh — cannot duplicate the row', () => {
    act(() => feed.acceptComment(POSTED));
    const first = feed.comments;
    act(() => feed.acceptComment(POSTED));
    expect(feed.comments).toBe(first);
    expect(feed.chapterFeed[65]?.items).toHaveLength(1);
  });

  it('keeps the chapter’s existing rows and order, and keeps them loaded', () => {
    const older: CommentDto = { ...POSTED, id: 'cmt_older', createdAt: '2026-10-26T09:00:00Z' };
    act(() => {
      feed.acceptComment(older);
      feed.acceptComment(POSTED);
    });
    expect(feed.chapterFeed[65]?.items.map((row) => row.id)).toEqual(['cmt_older', POSTED.id]);
    expect(feed.chapterFeed[65]?.loaded).toBe(true);
  });
});
