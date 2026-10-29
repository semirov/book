// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BREATHING_PX, gripHeight } from '../lib/headerOffset.ts';
import { PLACE_NOTE } from '../lib/place.ts';
import { currentFiling } from '../lib/useFiling.ts';
import { PlaceLink } from './PlaceLink.tsx';
import {
  BLOCK_TOP,
  CHAPTER_TOP,
  HEADER_PX,
  OFFSET_TOP,
  PLATE_PX,
  VIEWPORT,
  comment,
  jumpTo,
  mountPage,
  openPlacePage,
  placeBox,
  rect,
  scrollState,
  scrollTo,
  closePlacePage,
  type PlacePage,
} from './placeStub.ts';

/**
 * BOOK-168 — the door's landing: where the page moves, what the card is placed on, and the one
 * line it owes the reader when the place really is gone.
 *
 * jsdom has no layout: the head, the chapters and the paragraphs are stubs whose rect follows
 * the scroll (`placeStub.ts`), so every number here is the arithmetic `lib/place.ts` states.
 * The surfaces that carry the door (the register, the end matter, the chronicle's record row)
 * are proved in `placeDoor.dom.test.tsx`.
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

describe('a filing lands on the paragraph it quotes', () => {
  it('lands chapter 3 block 12 with its top at the reading line, and opens its card', async () => {
    mountPage();
    await page.render(<PlaceLink place={comment()}>«Я посмотрел на часы: девять сорок две.»</PlaceLink>);
    const link = linkOf();

    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('#ch-3-b12');
    expect(link.textContent).toBe('«Я посмотрел на часы: девять сорок две.»');

    await act(async () => { link.click(); });

    // top(#ch-3-b12) = 1 200 document px; the reading line is the measured head + breathing.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: BLOCK_TOP - OFFSET_TOP, behavior: 'auto' });
    const landedTop = document.getElementById('ch-3-b12')!.getBoundingClientRect().top;
    expect(Math.abs(landedTop - (HEADER_PX + BREATHING_PX))).toBeLessThanOrEqual(2);

    // The card is the filing's, placed on the post-scroll rect, and the link is its origin.
    const filing = currentFiling();
    expect(filing?.kind).toBe('filing');
    expect(filing?.comment?.id).toBe('cmt_1');
    expect(filing?.rect.top).toBe(landedTop);
    expect(filing?.origin).toBe(link);
    expect(panel()?.getAttribute('data-context')).toBe('filing');
    // BOOK-128 #3852 — the card is a block in the flow, not a placed layer: no measured class,
    // no portal at the document's end, and no inline box written over it.
    expect(panel()?.classList.contains('filing-panel-anchored')).toBe(false);
    // Review M5 — the card is a block **after** the row: a portal seat that is a sibling of the
    // paragraph (or list item), never a child of it and never a flex item.
    expect(panel()?.parentElement?.className).toBe('place-seat');
    expect(panel()?.closest('p, li')).toBeNull();
    expect(panel()?.getAttribute('style')).toBeNull();
    // A resolved block says nothing about a changed place.
    expect(panel()?.querySelector('.filing-place-note')).toBeNull();
  });

  it('returns focus to the door when the card closes', async () => {
    mountPage();
    await page.render(<PlaceLink place={comment()}>«— Заявителем лично.»</PlaceLink>);
    const link = linkOf();

    await act(async () => { link.click(); });
    expect(panel()).not.toBeNull();

    await act(async () => { (document.querySelector('.filing-close') as HTMLButtonElement).click(); });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(link);
    expect(currentFiling()).toBeNull();
  });
});

describe('the card is a block after the row, in every container that carries a door', () => {
  /** Render a door inside its real container, open it, and hand back the card. */
  async function openWith(node: ReactElement): Promise<HTMLElement> {
    mountPage();
    await page.render(node);
    const door = page.container.querySelector<HTMLAnchorElement>('a.place-link');
    if (door === null) throw new Error('no door');
    await act(async () => {
      door.click();
    });
    await page.settle();
    const card = panel();
    if (card === null) throw new Error('no card');
    return card;
  }

  const door = (): ReactElement => (
    <PlaceLink place={comment()}>«Я посмотрел на часы: девять сорок две.»</PlaceLink>
  );

  it('a Discussion quote: a div seat after the paragraph, never inside it', async () => {
    const card = await openWith(<p className="comment-quote">{door()}</p>);
    expect(card.parentElement?.tagName).toBe('DIV');
    expect(card.parentElement?.className).toBe('place-seat');
    expect(card.closest('p')).toBeNull();
    expect(page.container.querySelector('p.comment-quote')?.contains(card)).toBe(false);
  });

  it('an own decision intent: a div seat after the paragraph', async () => {
    const card = await openWith(<p className="own-decision-intent">{door()}</p>);
    expect(card.parentElement?.tagName).toBe('DIV');
    expect(card.closest('p')).toBeNull();
    expect(page.container.querySelector('p.own-decision-intent')?.contains(card)).toBe(false);
  });

  it('a chronicle row: an li seat, a block sibling of the flex row inside the list', async () => {
    const card = await openWith(
      <ol className="chr-list">
        <li className="chr-row" style={{ display: 'flex' }}>
          {door()}
        </li>
      </ol>,
    );
    const seat = card.parentElement;
    expect(seat?.tagName).toBe('LI');
    expect(seat?.className).toBe('place-seat');
    expect(card.closest('.chr-row')).toBeNull();
    expect(page.container.querySelector('li.chr-row')?.contains(card)).toBe(false);
    // A block sibling of the row, inside the list: a valid content model.
    const list = page.container.querySelector('ol.chr-list');
    expect(seat?.parentElement).toBe(list);
    expect(seat?.previousElementSibling).toBe(list?.querySelector('li.chr-row'));
  });
});

describe('a filing lands by its block id when the index is unknown', () => {
  it('finds the paragraph under [data-block-id], with and without CSS.escape', async () => {
    mountPage();
    const byId = comment({
      anchor: { blockId: 'ch03#b12', blockIndex: null, quote: 'Я посмотрел на часы.', prefix: null, suffix: null, resolved: true },
    });
    await page.render(<PlaceLink place={byId}>«Я посмотрел на часы.»</PlaceLink>);
    const link = linkOf();

    expect(link.getAttribute('href')).toBe('#ch-3');
    await act(async () => { link.click(); });
    expect(scrollTo).toHaveBeenCalledWith({ top: BLOCK_TOP - OFFSET_TOP, behavior: 'auto' });
    expect(currentFiling()?.comment?.id).toBe('cmt_1');
    expect(panel()?.querySelector('.filing-place-note')).toBeNull();

    // A browser without `CSS.escape`: the same paragraph, still found.
    scrollTo.mockClear();
    vi.stubGlobal('CSS', undefined);
    await act(async () => { link.click(); });
    expect(scrollTo).toHaveBeenCalledWith({ top: BLOCK_TOP - OFFSET_TOP, behavior: 'auto' });
  });
});

describe('a chapter-level premise lands on the chapter’s mouth', () => {
  it('lands #ch-5 at the reading line and opens the premise card', async () => {
    mountPage();
    const premise = comment({
      id: 'cmt_5',
      chapter: 5,
      premise: true,
      anchor: { blockId: null, blockIndex: null, quote: '— Заявителем лично.', prefix: null, suffix: null, resolved: true },
    });
    await page.render(<PlaceLink place={premise}>«— Заявителем лично.»</PlaceLink>);
    const link = linkOf();

    expect(link.getAttribute('href')).toBe('#ch-5');
    await act(async () => { link.click(); });

    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[5] - OFFSET_TOP, behavior: 'auto' });
    expect(currentFiling()?.comment?.id).toBe('cmt_5');
    expect(panel()).not.toBeNull();
    // A premise's home *is* the chapter: no honesty line, because nothing was lost.
    expect(panel()?.querySelector('.filing-place-note')).toBeNull();
  });
});

describe('a filing whose paragraph was rewritten', () => {
  it('lands on the chapter and says so, never on a block', async () => {
    mountPage();
    // The block is still on the page (`#ch-3-b12` exists) — a resolved:false anchor must not
    // use it: the quote is gone, and the text under that id is somebody else's.
    const stale = comment({
      anchor: {
        blockId: 'ch03#b12',
        blockIndex: 12,
        quote: 'Я посмотрел на часы: девять сорок две.',
        prefix: null,
        suffix: null,
        resolved: false,
      },
    });
    await page.render(<PlaceLink place={stale}>«Я посмотрел на часы: девять сорок две.»</PlaceLink>);
    const link = linkOf();

    expect(link.getAttribute('href')).toBe('#ch-3');
    await act(async () => { link.click(); });

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[3] - OFFSET_TOP, behavior: 'auto' });
    expect(panel()?.querySelector('.filing-place-note')?.textContent).toBe(PLACE_NOTE);
  });

  it('says nothing about a changed place when the block simply is not on the page', async () => {
    mountPage();
    // The chapter is loaded, the paragraph is not: the id and the data attribute both miss.
    const missing = comment({
      anchor: { blockId: 'ch03#b3', blockIndex: 3, quote: 'Свет был не для меня.', prefix: null, suffix: null, resolved: true },
    });
    await page.render(<PlaceLink place={missing}>«Свет был не для меня.»</PlaceLink>);
    const link = linkOf();
    expect(link.getAttribute('href')).toBe('#ch-3-b3');

    await act(async () => { link.click(); });
    await page.settle();
    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[3] - OFFSET_TOP, behavior: 'auto' });
    // An unread paragraph is not a lost anchor: nobody said the text changed, so no note is
    // printed (`anchor.resolved === false` is the only verdict that earns one).
    expect(panel()?.querySelector('.filing-place-note')).toBeNull();
  });

  it('asks the page for the chapter, then lands the paragraph the read delivers', async () => {
    mountPage();
    const late = comment({
      anchor: { blockId: 'ch03#b3', blockIndex: 3, quote: 'Свет был не для меня.', prefix: null, suffix: null, resolved: true },
    });
    const onLoadChapter = vi.fn((n: number) => {
      // The chapter's own read commits the prose: the paragraph appears with it.
      expect(n).toBe(3);
      const block = document.createElement('p');
      block.id = 'ch-3-b3';
      block.dataset.blockId = 'ch03#b3';
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
    // The chapter's mouth first — the jump that starts its read — then the paragraph itself.
    expect(scrollTo.mock.calls.map((call) => call[0]?.top)).toEqual([
      CHAPTER_TOP[3] - OFFSET_TOP,
      BLOCK_TOP - OFFSET_TOP,
    ]);
    expect(scrollTo.mock.calls.every((call) => call[0]?.behavior === 'auto')).toBe(true);
    expect(currentFiling()?.comment?.id).toBe('cmt_1');
    expect(currentFiling()?.rect.top).toBe(document.getElementById('ch-3-b3')!.getBoundingClientRect().top);
    expect(panel()?.querySelector('.filing-place-note')).toBeNull();
  });

  it('opens the card after the landing, never before the page has moved', async () => {
    mountPage();
    await page.render(<PlaceLink place={comment()}>«Я посмотрел на часы.»</PlaceLink>);
    // What the card looked like at the moment the page moved: nothing was open yet.
    const openAtScroll: unknown[] = [];
    scrollTo.mockImplementation((options: ScrollToOptions) => {
      openAtScroll.push(currentFiling());
      jumpTo(options);
    });
    try {
      await act(async () => { linkOf().click(); });
    } finally {
      scrollTo.mockImplementation(jumpTo);
    }

    expect(openAtScroll).toEqual([null]);
    expect(panel()).not.toBeNull();
  });

  it('lets a second tap take the landing: one card, one paragraph landing', async () => {
    mountPage();
    const late = comment({
      anchor: { blockId: 'ch03#b3', blockIndex: 3, quote: 'Свет был не для меня.', prefix: null, suffix: null, resolved: true },
    });
    // The read is held open, so the first door is still waiting when the second tap arrives.
    const pending: Array<() => void> = [];
    const onLoadChapter = (): Promise<void> =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    await page.render(
      <PlaceLink place={late} onLoadChapter={onLoadChapter}>
        «Свет был не для меня.»
      </PlaceLink>,
    );
    const link = linkOf();

    await act(async () => { link.click(); });
    await act(async () => { link.click(); });
    expect(pending).toHaveLength(2);

    // The read commits the paragraph, and both doors wake up: only the newest may land.
    const block = document.createElement('p');
    block.id = 'ch-3-b3';
    block.dataset.blockId = 'ch03#b3';
    placeBox(block, BLOCK_TOP, 40);
    document.getElementById('ch-3')?.append(block);
    for (const release of pending) release();
    await page.settle();

    const landings = scrollTo.mock.calls.map((call) => call[0]?.top);
    // One chapter jump per tap (the second tap is a new landing), one paragraph landing in all.
    expect(landings.filter((top) => top === BLOCK_TOP - OFFSET_TOP)).toHaveLength(1);
    expect(document.querySelectorAll('.filing-panel')).toHaveLength(1);
    expect(currentFiling()?.comment?.id).toBe('cmt_1');
    expect(panel()?.querySelector('.filing-place-note')).toBeNull();
  });
});

describe('the landing never leaves the target under the footer grip', () => {
  it('measures the bands the page still has, and no surface that is not a band', () => {
    // BOOK-128 #3815 moved the word's and the phrase's records into the margin: the chain is not
    // a band over the bottom edge any more, so a page carrying one must not reserve its height.
    const gone = document.createElement('div');
    gone.className = 'chain';
    gone.getBoundingClientRect = () => rect(0, 400);
    document.body.append(gone);
    expect(gripHeight(document)).toBe(0);

    // A change has no band over the bottom edge any more; the notice's ticket still is one.
    const ticket = document.createElement('div');
    ticket.className = 'ticket';
    ticket.getBoundingClientRect = () => rect(0, 120);
    document.body.append(ticket);
    expect(gripHeight(document)).toBe(120);
  });
  it('clamps at the last scroll of the book and keeps the paragraph above the plate', async () => {
    mountPage();
    const plate = document.createElement('aside');
    plate.className = 'capacity-plate';
    plate.getBoundingClientRect = () => rect(VIEWPORT.height - PLATE_PX, PLATE_PX);
    document.body.append(plate);

    // The last paragraph of the book: the page's own margin tail reserves the band's room, so
    // the document ends 120 px under the block, not at the block.
    const TAIL_PX = 120;
    const LAST_TOP = 4200;
    document.body.append(document.createElement('div'));
    const last = document.getElementById('ch-8-b2') as HTMLElement;
    placeBox(last, LAST_TOP, 40);
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: LAST_TOP + 40 + TAIL_PX,
    });

    const filing = comment({
      chapter: 8,
      anchor: { blockId: 'ch08#b2', blockIndex: 2, quote: '— Заявителем лично.', prefix: null, suffix: null, resolved: true },
    });
    await page.render(<PlaceLink place={filing}>«— Заявителем лично.»</PlaceLink>);
    await act(async () => { linkOf().click(); });

    const lastScroll = LAST_TOP + 40 + TAIL_PX - VIEWPORT.height;
    expect(gripHeight(document)).toBe(PLATE_PX);
    // The jump wanted the reading line; the page could not travel that far.
    expect(scrollTo).toHaveBeenCalledWith({ top: lastScroll, behavior: 'auto' });
    const landedTop = last.getBoundingClientRect().top;
    expect(landedTop).toBeGreaterThan(OFFSET_TOP);
    // Above the band, not under it: the card is placed on this rect, so it covers no line.
    expect(landedTop).toBeLessThan(VIEWPORT.height - PLATE_PX);
    expect(currentFiling()?.rect.top).toBe(landedTop);
  });
});

describe('the landing is a jump, not a journey', () => {
  it('asks for an instant scroll even when the reader has no reduced-motion preference', async () => {
    mountPage();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    await page.render(<PlaceLink place={comment()}>«Я посмотрел на часы.»</PlaceLink>);
    await act(async () => { linkOf().click(); });
    // Measured in a real Chromium: a smooth landing over 108 000 px moved 5 px in 1.8 s and the
    // card opened at the colophon. The landing is one jump, so the rect the card gets is final.
    expect(scrollTo).toHaveBeenCalledWith({ top: BLOCK_TOP - OFFSET_TOP, behavior: 'auto' });
    expect(currentFiling()?.rect.top).toBe(document.getElementById('ch-3-b12')!.getBoundingClientRect().top);
  });
});

describe('the card never moves the page it was opened on', () => {
  it('takes focus without scrolling: the landing stands, and nothing asks the page to move again', async () => {
    mountPage();
    await page.render(<PlaceLink place={comment()}>«Я посмотрел на часы: девять сорок две.»</PlaceLink>);

    // Measured in a real Chromium (owner, 2026-10-28): the card is portaled to `document.body`,
    // and its own focus — a plain `focus()` scrolls the node into view — moved the page from the
    // landed paragraph (scrollY 16 420) to the end of the document (scrollY 112 652) with no
    // second `scrollTo`. Every focus the open performs is recorded here, with its options.
    const focuses: Array<FocusOptions | undefined> = [];
    const realFocus = HTMLElement.prototype.focus;
    const spy = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function (this: HTMLElement, options?: FocusOptions): void {
        focuses.push(options);
        realFocus.call(this, options);
      });
    try {
      await act(async () => { linkOf().click(); });
    } finally {
      spy.mockRestore();
    }

    // One scroll: the landing. The card's focus is the only other act, and it owns no scroll.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollState.y).toBe(BLOCK_TOP - OFFSET_TOP);
    expect(focuses).toEqual([{ preventScroll: true }]);
    // And the focus still went into the card: the page may not move, the reader still arrives.
    expect(document.activeElement).toBe(panel());
  });
});
