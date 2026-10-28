// @vitest-environment jsdom
import type { CommentDto } from '@book/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  frame: null,
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

describe('the register’s completeness (BOOK-128 #3900 §1)', () => {
  /**
   * The API has no total: `nextBefore === null` is the only proof that the 20 loaded rows are
   * all of the thread. The hook carries that fact to the page, and it fails closed — a read
   * that never answered cannot make the feed complete.
   */
  function answer(page: { items: CommentDto[]; nextBefore: string | null }): void {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } }));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts incomplete, before any read has answered', () => {
    expect(feed.commentsComplete).toBe(false);
  });

  it('is complete only when the page has no next cursor', async () => {
    answer({ items: [], nextBefore: null });
    await act(async () => feed.refreshComments());
    expect(feed.commentsComplete).toBe(true);

    answer({ items: [POSTED], nextBefore: '2026-10-27T18:04:17Z' });
    await act(async () => feed.refreshComments());
    expect(feed.commentsComplete).toBe(false);
    expect(feed.comments).toHaveLength(1);
  });

  it('stays incomplete after a failed read, even once it was complete', async () => {
    answer({ items: [], nextBefore: null });
    await act(async () => feed.refreshComments());
    expect(feed.commentsComplete).toBe(true);

    vi.stubGlobal('fetch', async () => new Response('{"code":"x","message":"x"}', { status: 500 }));
    await act(async () => feed.refreshComments());
    expect(feed.commentsComplete).toBe(false);
  });
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

  it('replaces a revised filing in place: same id, same place, no second entry (BOOK-158)', () => {
    const older: CommentDto = { ...POSTED, id: 'cmt_older', createdAt: '2026-10-26T09:00:00Z' };
    act(() => {
      feed.acceptComment(older);
      feed.acceptComment(POSTED);
    });
    // The revise answer is the same row, reopened: same id, the reader's new words, the
    // refusal's line gone.
    const revised: CommentDto = {
      ...POSTED,
      status: 'new',
      body: 'смена переходит на ночь, а не на утро',
      hint: null,
      reason: null,
    };
    act(() => feed.acceptComment(revised));

    expect(feed.comments.map((row) => row.id)).toEqual(['cmt_older', POSTED.id]);
    expect(feed.comments[1]).toBe(revised);
    expect(feed.chapterFeed[65]?.items.map((row) => row.id)).toEqual(['cmt_older', POSTED.id]);
    expect(feed.chapterFeed[65]?.items[1]).toBe(revised);
  });
});
