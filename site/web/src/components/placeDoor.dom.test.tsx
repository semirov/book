// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Place } from '../lib/place.ts';
import { currentFiling } from '../lib/useFiling.ts';
import { ChronicleRecords } from './Chronicle.tsx';
import { Discussion } from './Discussion.tsx';
import { PlaceLink } from './PlaceLink.tsx';
import { RecordRow } from './RecordRow.tsx';
import {
  CHAPTER_TOP,
  OFFSET_TOP,
  answer,
  closePlacePage,
  comment,
  mountPage,
  openPlacePage,
  record,
  scrollTo,
  type PlacePage,
} from './placeStub.ts';

/**
 * BOOK-168 — one door on every surface that quotes the book: the register's quote, the
 * chronicle's place cell, and a place whose chapter is not on this page at all. BOOK-207 moved
 * the reader's own intent to `#след`, whose rows use the same `PlaceLink`.
 *
 * The landing's arithmetic is proved in `placeLink.dom.test.tsx`; this file proves what each
 * surface does with it — and, for the chronicle, that a door which cannot land anywhere still
 * acts (the change card) instead of setting a fragment to nothing.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let page: PlacePage;
const linkOf = (): HTMLAnchorElement => {
  const link = page.container.querySelector('a.place-link');
  if (link === null) throw new Error('no place link');
  return link as HTMLAnchorElement;
};
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.filing-panel');

beforeEach(() => {
  page = openPlacePage();
});

afterEach(async () => {
  await closePlacePage(page);
});

describe('the same door on every surface that quotes the book', () => {
  it('the register’s quote is the door, and the row is not a second one', async () => {
    mountPage();
    await page.render(<Discussion depth={0} comments={[comment()]} live />);

    const link = linkOf();
    expect(link.getAttribute('href')).toBe('#ch-3-b12');
    expect(page.container.querySelector('.comment-quote a.place-link')).toBe(link);
    // One door per row: tapping the body is reading, not a second card of the same filing.
    await act(async () => { (page.container.querySelector('.comment-body') as HTMLElement).click(); });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(panel()).toBeNull();

    await act(async () => { link.click(); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(currentFiling()?.comment?.id).toBe('cmt_1');
    expect(panel()).not.toBeNull();
  });

  it('the record’s place cell is the door: the filing by id, else the change card', async () => {
    mountPage();
    vi.stubGlobal('fetch', vi.fn(async () => answer(comment({ id: 'cmt_9', chapter: 3 }))));
    const onOpenChange = vi.fn();

    await page.render(<RecordRow record={record()} onOpenChange={onOpenChange} />);
    const place = page.container.querySelector('a.chr-place') as HTMLAnchorElement;
    expect(place.getAttribute('href')).toBe('#ch-3');
    expect(place.textContent).toBe('глава 3');
    await act(async () => { place.click(); });
    await page.settle();
    expect(currentFiling()?.comment?.id).toBe('cmt_9');
    expect(onOpenChange).not.toHaveBeenCalled();

    // The card button is still the change's own door, and it does not move the page.
    await act(async () => { (page.container.querySelector('.chr-change') as HTMLButtonElement).click(); });
    expect(onOpenChange).toHaveBeenCalledWith('chg_9');
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('the chronicle’s record row: a place this page cannot show opens the change card', async () => {
    // The real record list, on the page it lives on — the chronicle holds records, not chapters,
    // so no `#ch-3` exists here at all (and none is fabricated for the test).
    const onOpenChange = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => answer(comment({ id: 'cmt_9', chapter: 3 }))));
    await page.render(
      <ChronicleRecords
        timeline={{ lastHseq: 10, lastAt: '2026-10-27T12:40:00Z', firstAt: null, at: '2026-10-27T12:40:00Z', items: [record()], nextBefore: null }}
        failed={false}
        onOpenChange={onOpenChange}
        onLoadChapter={() => undefined}
      />,
    );

    const place = page.container.querySelector('a.chr-place') as HTMLAnchorElement;
    expect(place.textContent).toBe('глава 3');
    await act(async () => { place.click(); });
    await page.settle();

    // Nothing moved — there is nothing on this page to move to — and the door did something:
    // the record's change card is open, never a fragment set to nothing.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith('chg_9');
  });

  it('a record with no filing lands the chapter and opens the page’s own card', async () => {
    mountPage();
    const onOpenChange = vi.fn();
    // No filing on this page: the record names the chapter and the change card.
    const only = record({ seq: 4, chapter: 5, premise: true, premiseLanded: true, sourceCommentId: null, changeId: 'chg_4' });
    await page.render(<RecordRow record={only} onOpenChange={onOpenChange} />);

    await act(async () => { (page.container.querySelector('a.chr-place') as HTMLAnchorElement).click(); });
    await page.settle();
    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[5] - OFFSET_TOP, behavior: 'auto' });
    expect(onOpenChange).toHaveBeenCalledWith('chg_4');
    expect(panel()).toBeNull();
  });
});

describe('a door whose chapter is not on this page', () => {
  it('opens the change card instead of setting a fragment that lands nowhere', async () => {
    mountPage();
    const unknown: Place = { chapter: 9, changeId: 'chg_9' };
    const onOpenChange = vi.fn();
    await page.render(
      <PlaceLink place={unknown} onOpenChange={onOpenChange}>
        глава 9
      </PlaceLink>,
    );
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { linkOf().dispatchEvent(event); });
    await page.settle();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith('chg_9');
  });

  it('keeps the copied fragment when there is no card to open', async () => {
    mountPage();
    const onLoadChapter = vi.fn();
    await page.render(
      <PlaceLink place={{ chapter: 9 }} onLoadChapter={onLoadChapter}>
        глава 9
      </PlaceLink>,
    );
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { linkOf().dispatchEvent(event); });
    await page.settle();

    // A chapter-level place has nothing to wait for: the chapter *is* the place, so the page is
    // not asked for prose and the door finds nothing to move. It keeps the fragment truthful
    // instead: a copied href still names a chapter of the book, even off this page.
    expect(onLoadChapter).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#ch-9');
  });
});
