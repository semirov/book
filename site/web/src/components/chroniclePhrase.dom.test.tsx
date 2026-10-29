// @vitest-environment jsdom
import type { BookAtDto, HistoryRecordDto, HistoryTimelineDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Chronicle } from './Chronicle.tsx';

/**
 * BOOK-128 comment #3815 — a past chapter's phrase opens **in flow** under its paragraph.
 *
 * The chronicle has no margin channel, so `SentenceBlock` is a block after the `<p>` there: the
 * `⋯` door is the toggle, `Escape` puts the block away and hands focus back to that door, and
 * the paragraph above keeps its text. The reading surface's own geometry (the margin item) is
 * proven in `sentenceBlock.dom.test.tsx`.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TEXT = 'Он вошёл в комнату.';

function record(hseq: number, at: string): HistoryRecordDto {
  return {
    id: `chg_${String(hseq)}`,
    hseq,
    at,
    seq: hseq,
    chapter: 1,
    chapterTitle: null,
    premise: false,
    premiseLanded: false,
    alias: 'Филипп',
    cause: 'reader',
    status: 'done',
    outcome: 'applied',
    reason: null,
    changeId: 'chg_9',
    recordHref: '?change=chg_9',
    span: null,
  };
}

/** Newest first, as the API sends them: the rail needs a range to travel over. */
const PAGE: HistoryTimelineDto = {
  lastHseq: 10,
  lastAt: '2026-10-27T12:40:00Z',
  firstAt: '2026-10-21T06:12:00Z',
  at: '2026-10-27T12:40:00Z',
  items: [record(10, '2026-10-27T12:40:00Z'), record(7, '2026-10-26T06:00:00Z'), record(4, '2026-10-21T06:12:00Z')],
  nextBefore: null,
};

/** The book at the thumb's moment, with one written chapter to unfold. */
const BOOK: BookAtDto = {
  hseq: 7,
  at: '2026-10-26T06:00:00Z',
  front: { rev: 1, title: 'Книга момента', about: null },
  chapters: [{ n: 1, rev: 1, written: true, title: 'Начало', chars: TEXT.length }],
  lastHseq: 10,
};

const CHAPTER = {
  n: 1,
  hseq: 7,
  at: '2026-10-26T06:00:00Z',
  rev: 1,
  title: 'Начало',
  chars: TEXT.length,
  blocks: [{ id: 'ch01#aa11bb22', i: 0, text: TEXT, hash: 'a' }],
  cause: null,
};

function answer(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

const notFound = (): Response =>
  ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }) as unknown as Response;

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = String(input);
      // A 404 for the paragraph's chain is an answer: the facts are the pass's, no change behind.
      if (url.startsWith('/api/history/paragraphs/')) return Promise.resolve(notFound());
      if (url.startsWith('/api/history/chapters/')) return Promise.resolve(answer(CHAPTER));
      if (url.startsWith('/api/history/at/')) return Promise.resolve(answer(BOOK));
      return Promise.resolve(answer(PAGE));
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Chronicle catalog={[]} frontRev={1} tick={0} onOpenChange={() => undefined} started live />);
  });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle(turns = 6): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  });
}

/** Drag the rail to a moment and let the idle ask for it. */
async function seek(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="range"]');
  if (input === null) throw new Error('the rail is not rendered');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(120);
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

describe('a past chapter’s phrase, in flow', () => {
  it('opens the facts under the paragraph and closes back to the door', async () => {
    await settle();
    await seek('7');

    const details = container.querySelector<HTMLDetailsElement>('details.past-ch');
    expect(details, 'the past chapter is a fold').not.toBeNull();
    await act(async () => {
      if (details !== null) details.open = true;
      details?.dispatchEvent(new Event('toggle'));
    });
    await settle();

    const door = container.querySelector<HTMLElement>('.past-p .prov');
    expect(door?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      door?.click();
    });
    await settle();

    const block = container.querySelector<HTMLElement>('.sentence-block');
    expect(block, 'the facts are in flow, under the paragraph').not.toBeNull();
    expect(block?.className).toContain('sentence-flow');
    expect(container.querySelector('.past-p')?.nextElementSibling).toBe(block);
    expect(block?.textContent).toContain('фраза');
    // BOOK-68 keeps its absence line for a 404 in this layer: the log holds no row for the
    // paragraph, and the phrase does not print a hand it cannot back with one.
    expect(block?.textContent).toContain('у этой строки нет истории');
    // A past chapter has no margin: the block is not an item of the pass's ledger at all, so
    // the pass cannot place it against a line that is not there, and it is already opaque.
    expect(block?.hasAttribute('data-margin-item')).toBe(false);
    expect(block?.getAttribute('data-placed')).toBeNull();
    expect(block?.getAttribute('style')).toBeNull();
    // The sheet that keeps the block on the page is `reader.css`, and its contract — `.sentence-flow`
    // undoes the margin's absolute, transparent box outside every query — is proved in
    // `readerSheet.test.ts`. Here the claim is the block itself: it is not a ledger item.
    expect(door?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.filing-panel, .prov-panel')).toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(4);
    expect(container.querySelector('.sentence-block')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.past-p .prov'));
    // The paragraph behind is untouched: its own text plus the door it always carried.
    expect(container.querySelector('.past-p')?.textContent).toBe(`${TEXT}⋯`);
  });

  it('renders no door when the history is off', async () => {
    await act(async () => {
      root?.render(<Chronicle catalog={[]} frontRev={1} tick={0} onOpenChange={() => undefined} started live={false} />);
    });
    await settle();
    expect(container.querySelector('.past-p .prov')).toBeNull();
  });
});
