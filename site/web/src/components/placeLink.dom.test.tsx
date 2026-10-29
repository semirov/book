// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LANDING_PX } from '../lib/headerOffset.ts';
import { PLACE_NOTE } from '../lib/place.ts';
import { currentRecord, resetRecordMemory } from '../lib/record.ts';
import { currentFiling, hideFiling } from '../lib/useFiling.ts';
import { PlaceLink } from './PlaceLink.tsx';
import {
  BLOCK_TOP,
  CHAPTER_TOP,
  HEADER_PX,
  OFFSET_TOP,
  OWN_BLOCK_TOP,
  comment,
  jumpTo,
  mountPage,
  openPlacePage,
  placeBox,
  scrollState,
  scrollTo,
  closePlacePage,
  type PlacePage,
} from './placeStub.ts';

/**
 * BOOK-168 — the door's landing, and the **record** it opens.
 *
 * A filing with a sentence on the page lands on its paragraph (the measured jump of
 * `lib/place.ts`) and opens the record there, with the filing's body as the record's open one.
 * The one card remains only for the named exception: a premise, or an anchor the log says no
 * longer resolves to a sentence. jsdom has no layout, so every number is the stub's arithmetic.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TEXT_3 = 'Я посмотрел на часы: девять сорок две.';
const TEXT_8 = '— Заявителем лично.';

function chapter(n: number, blocks: Array<{ id: string; text: string }>): unknown {
  return {
    n,
    title: null,
    rev: 4,
    chars: blocks.reduce((sum, block) => sum + block.text.length, 0),
    basis: false,
    blocks: blocks.map((block, i) => ({ ...block, i, hash: `h${String(i)}` })),
    writtenAt: '2026-10-25T09:20:00Z',
    updatedAt: '2026-10-25T09:20:00Z',
  };
}

function answerChapters(): void {
  const answers: Record<string, unknown> = {
    '/api/chapters/3': chapter(3, [{ id: 'ch03#b12', text: TEXT_3 }]),
    '/api/chapters/8': chapter(8, [{ id: 'ch08#b2', text: TEXT_8 }]),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(answers).find((path) => url.endsWith(path));
      if (key === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(answers[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

let page: PlacePage;
const linkOf = (): HTMLAnchorElement => {
  const link = page.container.querySelector('a.place-link');
  if (link === null) throw new Error('no place link');
  return link as HTMLAnchorElement;
};
const card = (): HTMLElement | null => document.querySelector<HTMLElement>('.filing-panel');

beforeEach(() => {
  resetRecordMemory();
  answerChapters();
  page = openPlacePage();
});

afterEach(async () => {
  hideFiling();
  resetRecordMemory();
  await closePlacePage(page);
  vi.unstubAllGlobals();
});

describe('a filing lands on its paragraph and opens the record', () => {
  it('lands chapter 3 block 12 at the reading line and opens the record at the sentence', async () => {
    mountPage();
    await page.render(<PlaceLink place={comment()}>«Я посмотрел на часы: девять сорок две.»</PlaceLink>);
    const link = linkOf();
    expect(link.getAttribute('href')).toBe('#ch-3-b12');

    await act(async () => { link.click(); });
    await page.settle();

    // top(#ch-3-b12) = 1 200 document px; the reading line is the measured head + landing air.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: BLOCK_TOP - OFFSET_TOP, behavior: 'auto' });
    const landedTop = document.getElementById('ch-3-b12')!.getBoundingClientRect().top;
    expect(Math.abs(landedTop - (HEADER_PX + LANDING_PX))).toBeLessThanOrEqual(2);

    // The record, not a card: the filing's id and the sentence as it stands.
    expect(currentRecord()?.filing?.id).toBe('cmt_1');
    expect(currentRecord()?.anchor?.quote).toBe(TEXT_3);
    expect(currentRecord()?.origin).toBe(link);
    expect(card()).toBeNull();
  });

  it('finds the paragraph by [data-block-id] when the index is unknown', async () => {
    mountPage();
    const byId = comment({
      anchor: { blockId: 'ch03#b12', blockIndex: null, quote: TEXT_3, prefix: null, suffix: null, resolved: true },
    });
    await page.render(<PlaceLink place={byId}>«Я посмотрел на часы.»</PlaceLink>);
    expect(linkOf().getAttribute('href')).toBe('#ch-3');
    await act(async () => { linkOf().click(); });
    await page.settle();
    expect(scrollTo).toHaveBeenCalledWith({ top: BLOCK_TOP - OFFSET_TOP, behavior: 'auto' });
    expect(currentRecord()?.filing?.id).toBe('cmt_1');
  });

  it('asks the page for the chapter, then lands the paragraph the read delivers', async () => {
    mountPage();
    const late = comment({
      anchor: { blockId: 'ch03#b3', blockIndex: 3, quote: 'Свет был не для меня.', prefix: null, suffix: null, resolved: true },
    });
    const onLoadChapter = vi.fn((n: number) => {
      expect(n).toBe(3);
      const block = document.createElement('p');
      block.id = 'ch-3-b3';
      block.dataset.blockId = 'ch03#b3';
      block.textContent = 'Свет был не для меня.';
      placeBox(block, BLOCK_TOP, 40);
      document.getElementById('ch-3')?.append(block);
    });
    await page.render(
      <PlaceLink place={late} onLoadChapter={onLoadChapter}>
        «Свет был не для меня.»
      </PlaceLink>,
    );
    await act(async () => { linkOf().click(); });
    await page.settle();

    expect(onLoadChapter).toHaveBeenCalledWith(3);
    expect(scrollTo.mock.calls.map((call) => call[0]?.top)).toEqual([
      CHAPTER_TOP[3] - OFFSET_TOP,
      BLOCK_TOP - OFFSET_TOP,
    ]);
    expect(scrollTo.mock.calls.every((call) => call[0]?.behavior === 'auto')).toBe(true);
  });

  it('opens the record only after the page has moved', async () => {
    mountPage();
    await page.render(<PlaceLink place={comment()}>«Я посмотрел на часы.»</PlaceLink>);
    const seen: unknown[] = [];
    scrollTo.mockImplementation((options: ScrollToOptions) => {
      seen.push(currentRecord());
      jumpTo(options);
    });
    try {
      await act(async () => { linkOf().click(); });
      await page.settle();
    } finally {
      scrollTo.mockImplementation(jumpTo);
    }
    // The jump itself saw no record: the landing is measured first, the register follows.
    expect(seen[0]).toBeNull();
    expect(currentRecord()?.filing?.id).toBe('cmt_1');
    expect(scrollState.y).toBe(BLOCK_TOP - OFFSET_TOP);
  });

  it('an own decision’s block opens the record at its sentence', async () => {
    mountPage();
    const own = comment({
      id: 'cmt_8',
      chapter: 8,
      anchor: { blockId: 'ch08#b2', blockIndex: 2, quote: TEXT_8, prefix: null, suffix: null, resolved: true },
    });
    await page.render(<PlaceLink place={own}>«— Заявителем лично.»</PlaceLink>);
    await act(async () => { linkOf().click(); });
    await page.settle();
    expect(scrollTo).toHaveBeenCalledWith({ top: OWN_BLOCK_TOP - OFFSET_TOP, behavior: 'auto' });
    expect(currentRecord()?.filing?.id).toBe('cmt_8');
    expect(card()).toBeNull();
  });
});

describe('the named exception: a filing with no sentence keeps the one card', () => {
  it('lands a premise on the chapter’s mouth and opens its card', async () => {
    mountPage();
    const premise = comment({
      id: 'cmt_5',
      chapter: 5,
      premise: true,
      anchor: { blockId: null, blockIndex: null, quote: '— Заявителем лично.', prefix: null, suffix: null, resolved: true },
    });
    await page.render(<PlaceLink place={premise}>«— Заявителем лично.»</PlaceLink>);
    expect(linkOf().getAttribute('href')).toBe('#ch-5');
    await act(async () => { linkOf().click(); });
    await page.settle();

    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[5] - OFFSET_TOP, behavior: 'auto' });
    expect(currentRecord()).toBeNull();
    expect(currentFiling()?.comment.id).toBe('cmt_5');
    expect(card()?.querySelector('.filing-place-note')).toBeNull();
  });

  it('a stale anchor lands on the chapter and the card says the place changed', async () => {
    mountPage();
    const stale = comment({
      anchor: { blockId: 'ch03#b12', blockIndex: 12, quote: TEXT_3, prefix: null, suffix: null, resolved: false },
    });
    await page.render(<PlaceLink place={stale}>«{TEXT_3}»</PlaceLink>);
    await act(async () => { linkOf().click(); });
    await page.settle();

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[3] - OFFSET_TOP, behavior: 'auto' });
    expect(currentRecord()).toBeNull();
    expect(card()?.querySelector('.filing-place-note')?.textContent).toBe(PLACE_NOTE);
  });

  it('an unread paragraph is not a lost anchor: the card prints no note', async () => {
    mountPage();
    const missing = comment({
      anchor: { blockId: 'ch03#b3', blockIndex: 3, quote: 'Свет был не для меня.', prefix: null, suffix: null, resolved: true },
    });
    await page.render(<PlaceLink place={missing}>«Свет был не для меня.»</PlaceLink>);
    await act(async () => { linkOf().click(); });
    await page.settle();
    expect(currentRecord()).toBeNull();
    expect(card()?.querySelector('.filing-place-note')).toBeNull();
  });
});
