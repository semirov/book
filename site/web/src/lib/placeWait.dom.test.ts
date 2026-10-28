// @vitest-environment jsdom
import { AUTHOR_COLORS, type CommentDto } from '@book/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BREATHING_PX } from './headerOffset.ts';
import {
  PLACE_RETRY_FRAMES,
  landFragment,
  nextFrame,
  resolvePlaceAfterLoad,
  waitForBlock,
  type Place,
} from './place.ts';

/**
 * BOOK-168 — a door waits for the page it is about, and knows when to stop waiting.
 *
 * jsdom has no layout, so the boxes are stubs whose rect follows the scroll: the landing's
 * numbers are the ones `landingScroll` computes (`place.test.ts`), and what is proved here is
 * the **order** — jump to the chapter's mouth first (that is what starts its read), then wait
 * for the paragraph (a `MutationObserver` on the chapter, a frame budget beside it), then land
 * the paragraph; settle for the chapter's mouth when it never comes, and never move at all for
 * a page that does not hold the chapter.
 */

const scrollY = { value: 0 };
const scrollTo = vi.fn((options: ScrollToOptions) => {
  scrollY.value = Number(options.top ?? 0);
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
  element.getBoundingClientRect = () => rect(docTop - scrollY.value, height);
  return element;
}

function chapter(n: number, docTop = 1000): HTMLElement {
  const element = document.createElement('article');
  element.id = `ch-${String(n)}`;
  placeBox(element, docTop, 800);
  document.body.append(element);
  return element;
}

/** The paragraph a place names, added where a chapter's prose would arrive. */
function block(n: number, index: number, docTop: number): HTMLElement {
  const element = document.createElement('p');
  element.id = `ch-${String(n)}-b${String(index)}`;
  element.dataset.blockId = `ch0${String(n)}#b${String(index)}`;
  placeBox(element, docTop, 40);
  document.querySelector(`#ch-${String(n)}`)?.append(element);
  return element;
}

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 3,
    anchor: { blockId: 'ch03#b12', blockIndex: 12, quote: 'Я посмотрел на часы: девять сорок две.', prefix: null, suffix: null, resolved: true },
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

const stale = (): CommentDto =>
  comment({
    anchor: { blockId: 'ch03#b12', blockIndex: 12, quote: 'Я посмотрел на часы.', prefix: null, suffix: null, resolved: false },
  });

beforeEach(() => {
  scrollY.value = 0;
  scrollTo.mockClear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY.value });
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('matchMedia', () => ({ matches: true, media: '', addEventListener: () => undefined, removeEventListener: () => undefined }));
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 0 });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('a landing that asks the page first', () => {
  it('jumps to the chapter first, then returns the paragraph the read delivers', async () => {
    chapter(3);
    let asked: number[] = [];
    const frames: number[] = [];
    const target = await resolvePlaceAfterLoad({
      place: comment(),
      load: (n) => {
        asked = [...asked, n];
        // The chapter's own read commits the prose — here, in the same turn.
        block(3, 12, 1200);
      },
      frames: 4,
      wait: async () => {
        frames.push(1);
      },
    });

    expect(asked).toEqual([3]);
    expect(target?.chapterOnly).toBe(false);
    expect(target?.element.id).toBe('ch-3-b12');
    // The chapter's mouth is where its own read starts, so the page went there first…
    expect(scrollTo.mock.calls[0]?.[0]).toEqual({ top: 1000 - BREATHING_PX, behavior: 'auto' });
    // …and the paragraph that arrived needed no frame at all.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });

  it('waits for a paragraph the read commits a few frames later', async () => {
    chapter(3);
    const frames: number[] = [];
    const target = await resolvePlaceAfterLoad({
      place: comment(),
      frames: 6,
      wait: async () => {
        frames.push(1);
        if (frames.length === 3) block(3, 12, 1200);
      },
    });

    expect(target?.element.id).toBe('ch-3-b12');
    expect(frames).toHaveLength(3);
    // The jump to the chapter happened before a single frame was spent waiting.
    expect(scrollTo.mock.calls[0]?.[0]?.top).toBe(1000 - BREATHING_PX);
  });

  it('sees the commit itself, without spending a frame on it', async () => {
    if (typeof MutationObserver !== 'function') return;
    chapter(3);
    const landing = resolvePlaceAfterLoad({
      place: comment(),
      frames: 6,
      // A wait that never returns: only the chapter's own mutation record can end this.
      wait: () => new Promise<void>(() => undefined),
    });
    // Let the jump and the first frame start, then commit the prose the way a read does.
    await Promise.resolve();
    block(3, 12, 1200);
    const target = await landing;
    expect(target?.element.id).toBe('ch-3-b12');
  });

  it('waits a bounded number of frames, then lands the chapter rather than a hole', async () => {
    chapter(3);
    let frames = 0;
    const target = await resolvePlaceAfterLoad({
      place: comment(),
      frames: 3,
      wait: async () => {
        frames += 1;
      },
    });

    // The budget is the frames it was given, and the chapter's mouth is where the jump landed.
    expect(frames).toBe(3);
    expect(target?.chapterOnly).toBe(true);
    expect(target?.element.id).toBe('ch-3');
    expect(scrollTo.mock.calls[0]?.[0]?.top).toBe(1000 - BREATHING_PX);
  });

  it('does not wait for an anchor the log says is gone: the note is printed at once', async () => {
    chapter(3);
    const load = vi.fn();
    const frames = vi.fn(async () => undefined);
    const target = await resolvePlaceAfterLoad({ place: stale(), load, frames: 3, wait: frames });

    expect(load).not.toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
    expect(target?.chapterOnly).toBe(true);
    // A stale anchor has nowhere to jump on the chapter's behalf: the card says what happened.
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does not wait for a chapter-level place: the chapter is the whole place', async () => {
    chapter(5, 2400);
    const load = vi.fn();
    const place: Place = { chapter: 5, changeId: 'chg_5' };
    const target = await resolvePlaceAfterLoad({ place, load, frames: 3 });

    expect(load).not.toHaveBeenCalled();
    expect(target?.element.id).toBe('ch-5');
  });

  it('answers null for a place this page does not hold at all', async () => {
    chapter(3);
    const target = await resolvePlaceAfterLoad({ place: { chapter: 9 }, frames: 2 });
    expect(target).toBeNull();
  });

  it('reads the paragraph by its id when the chapter gives no block index', async () => {
    chapter(3);
    block(3, 4, 1300);
    const byId = comment({
      anchor: { blockId: 'ch03#b4', blockIndex: null, quote: 'Свет был не для меня.', prefix: null, suffix: null, resolved: true },
    });
    const target = await resolvePlaceAfterLoad({ place: byId, frames: 2 });
    expect(target?.element.id).toBe('ch-3-b4');
  });
});

describe('the wait for a paragraph', () => {
  it('is the frames alone when there is no chapter to watch', async () => {
    chapter(3);
    let frames = 0;
    const block = await waitForBlock({
      scope: null,
      find: () => document.getElementById('ch-3-b12'),
      frames: 2,
      wait: async () => {
        frames += 1;
      },
    });
    expect(block).toBeNull();
    expect(frames).toBe(2);
  });

  it('looks again at a commit that is not the paragraph', async () => {
    // A chapter's read may commit rows of its own before the paragraph: the observer looks at
    // what arrived, finds nothing it wants, and the frame budget is what ends the wait.
    chapter(3);
    let frames = 0;
    const block = await waitForBlock({
      scope: document.getElementById('ch-3'),
      find: () => document.getElementById('ch-3-b12'),
      frames: 3,
      wait: async () => {
        frames += 1;
        if (frames === 1) document.getElementById('ch-3')?.append(document.createElement('p'));
      },
    });
    expect(block).toBeNull();
    expect(frames).toBe(3);
  });
});

describe('one frame of the page', () => {
  it('is an animation frame where the page has them', async () => {
    const frames = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', frames);
    await nextFrame();
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it('is a task where it has none — a test page, an unfocused tab without a frame clock', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.useFakeTimers();
    const frame = nextFrame();
    await vi.advanceTimersByTimeAsync(0);
    await expect(frame).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe('a copied fragment lands with the page’s own measurement', () => {
  it('lands the paragraph once its chapter has been read', async () => {
    chapter(3);
    block(3, 12, 1200);
    const landed = await landFragment({ fragment: { chapter: 3, blockIndex: 12 } });

    expect(landed).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The paragraph's top at the reading line: the measured head (0 here) plus the breathing.
    expect(scrollTo.mock.calls[0]?.[0]).toEqual({ top: 1200 - BREATHING_PX, behavior: 'auto' });
  });

  it('jumps to the chapter first, waits for prose that is still being read, then lands it', async () => {
    chapter(3);
    let turns = 0;
    const landed = await landFragment({
      fragment: { chapter: 3, blockIndex: 7 },
      frames: 4,
      wait: async () => {
        turns += 1;
        if (turns === 2) block(3, 7, 1500);
      },
    });

    expect(landed).toBe(true);
    expect(turns).toBe(2);
    // The chapter's mouth first — that jump is what starts the chapter's own read…
    expect(scrollTo.mock.calls[0]?.[0]).toEqual({ top: 1000 - BREATHING_PX, behavior: 'auto' });
    // …then the paragraph the read delivered, in one more jump.
    expect(scrollTo.mock.calls[1]?.[0]).toEqual({ top: 1500 - BREATHING_PX, behavior: 'auto' });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('settles for the chapter’s mouth when the paragraph never arrives', async () => {
    chapter(3, 1100);
    const landed = await landFragment({ fragment: { chapter: 3, blockIndex: 12 }, frames: 2 });

    expect(landed).toBe(true);
    expect(scrollTo.mock.calls[0]?.[0]?.top).toBe(1100 - BREATHING_PX);
    // The first jump to the chapter already is the honest place; the second one re-measures it
    // after the wait, and neither of them invents a paragraph.
    expect(scrollTo.mock.calls.at(-1)?.[0]?.top).toBe(1100 - BREATHING_PX);
  });

  it('moves nothing and claims nothing for a chapter that is not on this page', async () => {
    chapter(3);
    const landed = await landFragment({ fragment: { chapter: 9, blockIndex: 1 }, frames: 2 });

    expect(landed).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('spends at most the page’s frame budget on a paragraph that never comes', async () => {
    chapter(3);
    let frames = 0;
    await landFragment({
      fragment: { chapter: 3, blockIndex: 12 },
      frames: PLACE_RETRY_FRAMES,
      wait: async () => {
        frames += 1;
      },
    });
    expect(frames).toBe(PLACE_RETRY_FRAMES);
  });

  it('drops its remaining acts when a newer landing takes the page', async () => {
    chapter(3);
    const pending: Array<() => void> = [];
    const waiting = landFragment({
      fragment: { chapter: 3, blockIndex: 12 },
      frames: 1,
      wait: () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
    });
    // The reader taps another anchor while the first landing is still waiting.
    await landFragment({ fragment: { chapter: 3, blockIndex: null } });
    for (const release of pending) release();
    const landed = await waiting;

    // The stale landing claims nothing and never scrolls to a paragraph it did not wait for.
    expect(landed).toBe(false);
    expect(scrollTo.mock.calls.every((call) => call[0]?.top !== 1200 - BREATHING_PX)).toBe(true);
  });
});
