import { AUTHOR_COLORS, type CommentDto, type HistoryRecordDto } from '@book/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

import { applyStickyOffsets, offsetOf } from '../lib/headerOffset.ts';
import { hideFiling } from '../lib/useFiling.ts';

/**
 * BOOK-168 — the page a place door is proved on, shared by `placeLink.dom.test.tsx` (the
 * landing's arithmetic) and `placeDoor.dom.test.tsx` (the surfaces that carry the door).
 *
 * jsdom has no layout, so the head, the chapters, the paragraphs and the footer band are stubs
 * whose rect follows the scroll: the scroll the code asks for becomes `window.scrollY`, and a
 * landing is checked against the reading line. A frame is immediate here, so a test proves the
 * **order** of the door's acts — ask, wait, land — and not half a second of it.
 *
 * Nothing in this module asserts: the two files make the claims.
 */

export const HEADER_PX = 56;
/** `--offset-top` as the page gets it: the measured head plus the site's breathing space. */
export const OFFSET_TOP = offsetOf(HEADER_PX);
export const VIEWPORT = { width: 390, height: 844 } as const;
export const PLATE_PX = 80;
/** Where each stubbed article begins, in document pixels. */
export const CHAPTER_TOP = { 3: 1100, 5: 2400, 8: 3300 } as const;
/** The paragraph the owner's first quote was filed on: chapter 3, block 12. */
export const BLOCK_TOP = 1200;
/** The second paragraph a fetched filing names: chapter 8, block 2. */
export const OWN_BLOCK_TOP = 3320;

/** The scroll the page asked for, as `window.scrollY`. */
export const scrollState = { y: 0 };
/** What the page does with a scroll request: it moves there. */
export function jumpTo(options: ScrollToOptions): void {
  scrollState.y = Number(options.top ?? 0);
}
export const scrollTo = vi.fn(jumpTo);

export function rect(top: number, height: number): DOMRect {
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
export function placeBox(element: HTMLElement, docTop: number, height: number): HTMLElement {
  element.getBoundingClientRect = () => rect(docTop - scrollState.y, height);
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
export function mountPage(): void {
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

export function comment(overrides: Partial<CommentDto> = {}): CommentDto {
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

export function record(overrides: Partial<HistoryRecordDto> = {}): HistoryRecordDto {
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
export const answer = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

export type PlacePage = {
  container: HTMLDivElement;
  render: (node: ReactElement) => Promise<void>;
  /** Let the door's own wait finish: the frames of this page are immediate. */
  settle: (turns?: number) => Promise<void>;
  /** Unmount the page's root: a door must survive the page leaving without leaking a listener. */
  close: () => Promise<void>;
};

/** Install the stubs one door needs, and hand back the container to render into. */
export function openPlacePage(): PlacePage {
  scrollState.y = 0;
  scrollTo.mockClear();
  hideFiling();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollState.y });
  vi.stubGlobal('scrollTo', scrollTo);
  // The fixture asks for no reduced-motion preference, so the instant landing is the code's own
  // rule and not the reader's setting (owner, 2026-10-28).
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
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
  // A paragraph the door asks for may be one frame away: every frame here is immediate.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });

  const container = document.body.appendChild(document.createElement('div'));
  let root: Root | null = null;
  return {
    container,
    render: async (node) => {
      root ??= createRoot(container);
      await act(async () => root?.render(node));
    },
    settle: async (turns = 4) => {
      await act(async () => {
        // A landing's wait is a chain of frames and microtasks: one task turn drains the whole
        // chain (every frame here resolves immediately), so the door is done when this returns.
        for (let turn = 0; turn < turns; turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await Promise.resolve();
        }
      });
    },
    close: async () => {
      if (root !== null) await act(async () => root?.unmount());
      root = null;
    },
  };
}

export async function closePlacePage(page: PlacePage | null): Promise<void> {
  if (page !== null) await page.close();
  hideFiling();
  document.body.innerHTML = '';
  window.location.hash = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
