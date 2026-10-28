// @vitest-environment jsdom
import { AUTHOR_COLORS, type CommentDto, type HistoryRecordDto, type MyDecisionsDto } from '@book/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BREATHING_PX, applyStickyOffsets, gripHeight, offsetOf } from '../lib/headerOffset.ts';
import { PLACE_NOTE, type Place } from '../lib/place.ts';
import { currentFiling, hideFiling } from '../lib/useFiling.ts';
import { Discussion } from './Discussion.tsx';
import { OwnDecisions } from './OwnDecisions.tsx';
import { PlaceLink } from './PlaceLink.tsx';
import { RecordRow } from './RecordRow.tsx';

/**
 * BOOK-168 — the owner's two dead quotes became doors: «Я посмотрел на часы: девять сорок две.»
 * in the register, «— Заявителем лично.» in a premise row. jsdom has no layout, so the head,
 * the chapters, the paragraphs and the footer plate are stubbed boxes whose rect follows the
 * scroll, and the scroll the code asks for becomes `window.scrollY`: the landing is checked at
 * the reading line, the card on the post-scroll rect, and a lost paragraph in one honest line.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HEADER_PX = 56;
/** `--offset-top` as the page gets it: the measured head plus the site's breathing space. */
const OFFSET_TOP = offsetOf(HEADER_PX);
const VIEWPORT = { width: 390, height: 844 } as const;
const PLATE_PX = 80;
/** Where each stubbed article begins, in document pixels. */
const CHAPTER_TOP = { 3: 1100, 5: 2400, 8: 3300 } as const;
/** The paragraph the owner's first quote was filed on: chapter 3, block 12. */
const BLOCK_TOP = 1200;
/** The second paragraph a fetched filing names: chapter 8, block 2. */
const OWN_BLOCK_TOP = 3320;

let root: Root | null = null;
let container: HTMLDivElement;
let scrollY = 0;
const scrollTo = vi.fn((options: ScrollToOptions) => {
  scrollY = Number(options.top ?? 0);
});

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A box in document coordinates: its rect is what a browser would report at this scroll. */
function placeBox(element: HTMLElement, docTop: number, height: number): HTMLElement {
  element.getBoundingClientRect = () => rect(docTop - scrollY, height);
  return element;
}

function article(id: string, docTop: number): HTMLElement {
  const element = document.createElement('article');
  element.id = id;
  placeBox(element, docTop, 900);
  document.body.append(element);
  return element;
}

/** The page's anchors: a head, three chapters, and the two paragraphs a filing names. */
function mountPage(): void {
  const head = document.createElement('header');
  head.className = 'top';
  head.getBoundingClientRect = () => rect(0, HEADER_PX);
  document.body.append(head);

  for (const [n, top] of Object.entries(CHAPTER_TOP)) article(`ch-${n}`, top);

  const block = document.createElement('p');
  block.id = 'ch-3-b12';
  block.dataset.blockId = 'ch03#b12';
  block.textContent = 'Я посмотрел на часы: девять сорок две.';
  placeBox(block, BLOCK_TOP, 40);
  document.getElementById('ch-3')?.append(block);

  const own = document.createElement('p');
  own.id = 'ch-8-b2';
  own.dataset.blockId = 'ch08#b2';
  own.textContent = '— Заявителем лично.';
  placeBox(own, OWN_BLOCK_TOP, 40);
  document.getElementById('ch-8')?.append(own);

  applyStickyOffsets(document);
}

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 3,
    anchor: {
      blockId: 'ch03#b12',
      blockIndex: 12,
      quote: 'Я посмотрел на часы: девять сорок две.',
      prefix: null,
      suffix: null,
      resolved: true,
    },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'тут время не сходится',
    proposedText: null,
    interventionKind: null,
    frame: 'untouched',
    premise: false,
    status: 'new',
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

function record(overrides: Partial<HistoryRecordDto> = {}): HistoryRecordDto {
  return {
    hseq: 10,
    at: '2026-10-27T12:40:00Z',
    seq: 9,
    chapter: 3,
    premise: false,
    premiseLanded: false,
    alias: 'Аня',
    status: 'done',
    outcome: 'applied',
    reason: null,
    sourceCommentId: 'cmt_9',
    changeId: 'chg_9',
    ...overrides,
  };
}

/** `answer`, as the other DOM tests state it: the API reads `ok`, `status` and `json()`. */
const answer = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

async function render(node: ReactElement): Promise<void> {
  root = createRoot(container);
  await act(async () => { root?.render(node); });
}

const linkOf = (): HTMLAnchorElement => {
  const link = container.querySelector('a.place-link');
  if (link === null) throw new Error('no place link');
  return link as HTMLAnchorElement;
};

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.filing-panel');

beforeEach(() => {
  scrollY = 0;
  scrollTo.mockClear();
  hideFiling();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  vi.stubGlobal('scrollTo', scrollTo);
  // The fixture asks for an instant landing: the arithmetic is what this file measures.
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
  // jsdom has no layout: a document with no measurable height has no ceiling to clamp at.
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 0 });
  container = document.body.appendChild(document.createElement('div'));
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  hideFiling();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a filing lands on the paragraph it quotes', () => {
  it('lands chapter 3 block 12 with its top at the reading line, and opens its card', async () => {
    mountPage();
    await render(<PlaceLink place={comment()}>«Я посмотрел на часы: девять сорок две.»</PlaceLink>);
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
    expect(panel()?.classList.contains('filing-panel-anchored')).toBe(true);
    // A resolved block says nothing about a changed place.
    expect(panel()?.querySelector('.filing-place-note')).toBeNull();
  });

  it('returns focus to the door when the card closes', async () => {
    mountPage();
    await render(<PlaceLink place={comment()}>«— Заявителем лично.»</PlaceLink>);
    const link = linkOf();

    await act(async () => { link.click(); });
    expect(panel()).not.toBeNull();

    await act(async () => { (document.querySelector('.filing-close') as HTMLButtonElement).click(); });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(link);
    expect(currentFiling()).toBeNull();
  });
});

describe('a filing lands by its block id when the index is unknown', () => {
  it('finds the paragraph under [data-block-id], with and without CSS.escape', async () => {
    mountPage();
    const byId = comment({
      anchor: { blockId: 'ch03#b12', blockIndex: null, quote: 'Я посмотрел на часы.', prefix: null, suffix: null, resolved: true },
    });
    await render(<PlaceLink place={byId}>«Я посмотрел на часы.»</PlaceLink>);
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
    await render(<PlaceLink place={premise}>«— Заявителем лично.»</PlaceLink>);
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
    await render(<PlaceLink place={stale}>«Я посмотрел на часы: девять сорок две.»</PlaceLink>);
    const link = linkOf();

    expect(link.getAttribute('href')).toBe('#ch-3');
    await act(async () => { link.click(); });

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[3] - OFFSET_TOP, behavior: 'auto' });
    expect(panel()?.querySelector('.filing-place-note')?.textContent).toBe(PLACE_NOTE);
  });

  it('says the same when the anchor resolves but its block is not on the page', async () => {
    mountPage();
    // The chapter is loaded, the paragraph is not: the id and the data attribute both miss.
    const missing = comment({
      anchor: { blockId: 'ch03#b3', blockIndex: 3, quote: 'Свет был не для меня.', prefix: null, suffix: null, resolved: true },
    });
    await render(<PlaceLink place={missing}>«Свет был не для меня.»</PlaceLink>);
    const link = linkOf();
    expect(link.getAttribute('href')).toBe('#ch-3-b3');

    await act(async () => { link.click(); });
    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[3] - OFFSET_TOP, behavior: 'auto' });
    expect(panel()?.querySelector('.filing-place-note')?.textContent).toBe(PLACE_NOTE);
  });
});

describe('the landing never leaves the target under the footer grip', () => {
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
    await render(<PlaceLink place={filing}>«— Заявителем лично.»</PlaceLink>);
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

describe('the same door on every surface that quotes the book', () => {
  it('the register’s quote is the door, and the row is not a second one', async () => {
    mountPage();
    await render(<Discussion depth={0} comments={[comment()]} live />);

    const link = linkOf();
    expect(link.getAttribute('href')).toBe('#ch-3-b12');
    expect(container.querySelector('.comment-quote a.place-link')).toBe(link);
    // One door per row: tapping the body is reading, not a second card of the same filing.
    await act(async () => { (container.querySelector('.comment-body') as HTMLElement).click(); });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(panel()).toBeNull();

    await act(async () => { link.click(); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(currentFiling()?.comment?.id).toBe('cmt_1');
    expect(panel()).not.toBeNull();
  });

  it('the reader’s own intent is the door, read by id and landed on the block', async () => {
    mountPage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        answer(
          comment({
            id: 'cmt_A',
            chapter: 8,
            anchor: { blockId: 'ch08#b2', blockIndex: 2, quote: '— Заявителем лично.', prefix: null, suffix: null, resolved: true },
          }),
        ),
      ),
    );
    const decisions: MyDecisionsDto = {
      items: [
        {
          commentId: 'cmt_A',
          changeId: 'chg_A',
          chapter: 8,
          intent: 'внести документ о регистрации сенсора',
          premise: false,
          outcome: 'applied',
          reason: null,
          chapters: [8],
          waves: 1,
          blocks: 3,
          shareAtDecision: null,
          decidedAt: '2026-10-25T12:30:00Z',
        },
      ],
      open: [],
      share: 0.004,
    };
    await render(<OwnDecisions decisions={decisions} />);
    const link = linkOf();

    expect(link.getAttribute('href')).toBe('#ch-8');
    expect(link.closest('.own-decision-intent')).not.toBeNull();
    await act(async () => { link.click(); });
    // The DTO carries no anchor: one read by id, then the paragraph it names.
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/comments/cmt_A', expect.anything());
    expect(scrollTo).toHaveBeenCalledWith({ top: OWN_BLOCK_TOP - OFFSET_TOP, behavior: 'auto' });
    expect(currentFiling()?.comment?.id).toBe('cmt_A');
  });

  it('the record’s place cell is the door: the filing by id, else the change card', async () => {
    mountPage();
    vi.stubGlobal('fetch', vi.fn(async () => answer(comment({ id: 'cmt_9', chapter: 3 }))));
    const onOpenChange = vi.fn();

    await render(<RecordRow record={record()} onOpenChange={onOpenChange} />);
    const place = container.querySelector('a.chr-place') as HTMLAnchorElement;
    expect(place.getAttribute('href')).toBe('#ch-3');
    expect(place.textContent).toBe('глава 3');
    await act(async () => { place.click(); });
    expect(currentFiling()?.comment?.id).toBe('cmt_9');
    expect(onOpenChange).not.toHaveBeenCalled();

    // The card button is still the change's own door, and it does not move the page.
    await act(async () => { (container.querySelector('.chr-change') as HTMLButtonElement).click(); });
    expect(onOpenChange).toHaveBeenCalledWith('chg_9');
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('a record with no filing lands the chapter and opens the page’s own card', async () => {
    mountPage();
    const onOpenChange = vi.fn();
    // No filing on this page: the record names the chapter and the change card.
    const only = record({ seq: 4, chapter: 5, premise: true, premiseLanded: true, sourceCommentId: null, changeId: 'chg_4' });
    await render(<RecordRow record={only} onOpenChange={onOpenChange} />);

    await act(async () => { (container.querySelector('a.chr-place') as HTMLAnchorElement).click(); });
    expect(scrollTo).toHaveBeenCalledWith({ top: CHAPTER_TOP[5] - OFFSET_TOP, behavior: 'auto' });
    expect(onOpenChange).toHaveBeenCalledWith('chg_4');
    expect(panel()).toBeNull();
  });
});

describe('the landing honours the reader’s motion setting', () => {
  it('asks for a smooth travel when no reduced-motion preference is set', async () => {
    mountPage();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    await render(<PlaceLink place={comment()}>«Я посмотрел на часы.»</PlaceLink>);
    await act(async () => { linkOf().click(); });
    expect(scrollTo).toHaveBeenCalledWith({ top: BLOCK_TOP - OFFSET_TOP, behavior: 'smooth' });
  });
});

describe('a door whose chapter is not on this page', () => {
  it('leaves the browser’s own fragment jump alone', async () => {
    mountPage();
    const unknown: Place = { chapter: 9, changeId: 'chg_9' };
    const onOpenChange = vi.fn();
    await render(
      <PlaceLink place={unknown} onOpenChange={onOpenChange}>
        глава 9
      </PlaceLink>,
    );
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { linkOf().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
