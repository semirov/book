// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LANDING_PX, offsetTopOfPage } from './headerOffset.ts';
import { placeAtLine } from './position.ts';
import {
  LANDING_FRAMES,
  SETTLED_FRAMES,
  beginLanding,
  followLine,
  isCurrent,
  landChapter,
  landingActive,
  landingLine,
  landingToken,
  landOn,
} from './landing.ts';

/**
 * BOOK-209 — a landing is a line plus a bounded correction loop.
 *
 * jsdom has no layout and no frame clock, so both are handed to the code: every rect is a
 * function of a scroll this file owns, and `requestAnimationFrame` is a queue this file drains
 * one frame at a time. That is what makes the loop's contract checkable — it corrects a residual
 * that appeared **after** the jump, it stops when the page settles, it is bounded, it dies on the
 * reader's own gesture, and a newer landing takes the page from an older one.
 */

const HEAD = 56;
const VIEWPORT = 800;
const SCROLL_HEIGHT = 4_000;

const scroll = { y: 0 };
/** Where the element sits in the document; the test moves it to play the page's own reflow. */
const element = { docTop: 2_000, height: 40 };

let queued: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextId = 1;

const scrollTo = vi.fn((options: ScrollToOptions) => {
  scroll.y = Number(options.top ?? 0);
});
const scrollBy = vi.fn((options: ScrollToOptions) => {
  scroll.y += Number(options.top ?? 0);
});

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function head(): void {
  const row = document.createElement('header');
  row.className = 'top';
  row.getBoundingClientRect = () => rect(0, HEAD);
  document.body.append(row);
}

function block(docTop = element.docTop, height = element.height): HTMLElement {
  const node = document.createElement('p');
  node.id = 'target';
  node.getBoundingClientRect = () => rect(element.docTop - scroll.y, element.height);
  document.body.append(node);
  void docTop;
  void height;
  return node;
}

/** One frame of the page: drain the queue the code asked for, in order. */
function frame(times = 1, between?: () => void): void {
  for (let index = 0; index < times; index += 1) {
    const due = queued;
    queued = [];
    for (const entry of due) entry.callback(index * 16);
    between?.();
  }
}

beforeEach(() => {
  scroll.y = 0;
  element.docTop = 2_000;
  element.height = 40;
  queued = [];
  nextId = 1;
  scrollTo.mockClear();
  scrollBy.mockClear();
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--offset-top');
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scroll.y });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: SCROLL_HEIGHT });
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('scrollBy', scrollBy);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queued.push({ id: nextId, callback });
    nextId += 1;
    return nextId - 1;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queued = queued.filter((entry) => entry.id !== id);
  });
  head();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the line', () => {
  it('is the sticky head’s measured bottom plus LANDING_PX', () => {
    document.querySelector<HTMLElement>('.top')?.remove();
    const row = document.createElement('header');
    row.className = 'top';
    row.getBoundingClientRect = () => rect(0, 59.4);
    document.body.append(row);
    expect(landingLine()).toBe(59.4 + LANDING_PX);
  });

  it('falls back to the page’s own offset where there is no head to measure', () => {
    document.querySelector<HTMLElement>('.top')?.remove();
    document.documentElement.style.setProperty('--offset-top', '48px');
    expect(landingLine()).toBe(offsetTopOfPage(document));
    expect(landingLine()).toBe(48);
  });
});

describe('a landing that holds its line', () => {
  it('jumps once, then takes back a residual the page made after the jump', async () => {
    const target = block();
    const landing = landOn(target);
    // One instant jump to the line, never a travel.
    expect(scrollTo).toHaveBeenCalledWith({ top: 2_000 - landingLine(), behavior: 'auto' });
    expect(scroll.y).toBe(2_000 - landingLine());

    // The prose above arrives: the element is 40 px lower than the jump left it.
    element.docTop += 40;
    expect(landingActive()).toBe(true);
    frame(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: 40, behavior: 'auto' });
    expect(scroll.y).toBe(2_000 - landingLine() + 40);

    await expect(promiseOf(landing)).resolves.toBe('landed');
    expect(element.docTop - scroll.y).toBe(landingLine());
    expect(landingActive()).toBe(false);
  });

  it('holds the line for six settled frames before it claims the landing', async () => {
    const target = block();
    const landing = landOn(target);
    let frames = 0;
    while (queued.length > 0) {
      frame(1);
      frames += 1;
      if (frames > 40) break;
    }
    await expect(landing).resolves.toBe('landed');
    // The first frame only establishes the baseline the document top is compared with; the six
    // frames that follow are the settled ones, and the seventh is the one that claims the landing.
    expect(frames).toBe(SETTLED_FRAMES + 1);
  });

  it('keeps the line while the content above it keeps moving', async () => {
    const target = block();
    const landing = landOn(target);
    // Three frames of lazy prose arriving above the reading line.
    frame(3, () => {
      element.docTop += 25;
    });
    // …and then the page settles where the loop left it: the last frame lands it.
    frame(8);
    await expect(landing).resolves.toBe('landed');
    expect(element.docTop - scroll.y).toBe(landingLine());
  });

  it('is bounded: a page that never settles ends in `capped`, not in an endless loop', async () => {
    const target = block();
    const landing = landOn(target);
    let frames = 0;
    while (queued.length > 0 && frames < LANDING_FRAMES + 5) {
      frame(1, () => {
        element.docTop += 100;
      });
      frames += 1;
    }
    await expect(landing).resolves.toBe('capped');
    // Every one of the frame budget's frames is spent on a correction, and the next frame is the
    // one that finds the budget gone.
    expect(frames).toBe(LANDING_FRAMES + 1);
    expect(queued).toHaveLength(0);
  });

  it('settles instead of fighting the document’s own end', async () => {
    // A browser clamps a scroll at the last position the page has; the residual then cannot be
    // removed, and the loop must accept the clamp the jump itself already applies.
    scrollTo.mockImplementation((options: ScrollToOptions) => {
      scroll.y = Math.min(Number(options.top ?? 0), SCROLL_HEIGHT - VIEWPORT);
    });
    scrollBy.mockImplementation((options: ScrollToOptions) => {
      scroll.y = Math.min(scroll.y + Number(options.top ?? 0), SCROLL_HEIGHT - VIEWPORT);
    });
    element.docTop = SCROLL_HEIGHT - 10;
    const target = block();
    const landing = landOn(target);
    frame(10);
    await expect(landing).resolves.toBe('landed');
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('measures the page’s end again every frame, so a jump clamped at a stale end is corrected', async () => {
    // The whole premise of the loop is that the document **grows** after the jump (lazy prose).
    // A maximum read once before the first frame would call this landing arrived 688 px short:
    // the jump was clamped at the then-bottom, and the residual was measured against that bottom.
    let height = SCROLL_HEIGHT;
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => height });
    const clamp = (options: ScrollToOptions): void => {
      scroll.y = Math.min(Number(options.top ?? 0), height - VIEWPORT);
    };
    scrollTo.mockImplementation(clamp);
    scrollBy.mockImplementation((options: ScrollToOptions) => {
      scroll.y += Number(options.top ?? 0);
      // A real engine clamps too; the test's page must not scroll past its own end.
      if (scroll.y > height - VIEWPORT) scroll.y = height - VIEWPORT;
    });

    element.docTop = 3_900;
    const target = block();
    const landing = landOn(target);
    // Wanted 3 828, the page's end was 3 200: the jump stands at its own bottom, still blocked.
    expect(scroll.y).toBe(SCROLL_HEIGHT - VIEWPORT);

    // Two frames blocked at the true end are not an arrival…
    frame(2);
    expect(landingActive()).toBe(true);

    // …and then the chapter's prose arrives and the page is longer than it was.
    height = 6_000;
    frame(1);
    expect(scroll.y).toBe(3_900 - landingLine());
    frame(8);
    await expect(landing).resolves.toBe('landed');
    expect(element.docTop - scroll.y).toBe(landingLine());
  });

  it('finishes the running loop when a second one starts under the same token', async () => {
    // `landAt` lands under the token already in force, so the generation cannot be the guard:
    // two surfaces can share a token and still be two loops, each correcting every frame.
    const first = block();
    const second = document.createElement('p');
    second.getBoundingClientRect = () => rect(3_000 - scroll.y, 40);
    document.body.append(second);

    const token = beginLanding();
    const one = followLine(first, token);
    frame(1);
    const two = followLine(second, token);

    // The first loop ended as `cancelled`, and its next frame was cancelled with it: one loop left.
    await expect(one).resolves.toBe('cancelled');
    expect(queued).toHaveLength(1);
    frame(10);
    await expect(two).resolves.toBe('landed');
    expect(second.getBoundingClientRect().top).toBeCloseTo(landingLine(), 1);

    // Nothing of the finished loop survives the second one's end either: a reflow of the first
    // loop's own element moves the scroll by no frame at all.
    scrollBy.mockClear();
    element.docTop += 500;
    frame(2);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('dies on the reader’s own gesture, and takes no further frame', async () => {
    const target = block();
    const landing = landOn(target);
    window.dispatchEvent(new Event('wheel'));
    await expect(landing).resolves.toBe('cancelled');
    expect(queued).toHaveLength(0);
    expect(landingActive()).toBe(false);
    // The loop is gone: a reflow after the gesture is the reader's page, not a correction.
    element.docTop += 100;
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('gives the page to a newer landing', async () => {
    const target = block();
    const first = landOn(target);
    const other = block();
    const second = landOn(other);
    frame(10);
    await expect(first).resolves.toBe('cancelled');
    await expect(second).resolves.toBe('landed');
  });

  it('holds a delta below the line when the place carries one', async () => {
    const target = block();
    const landing = landOn(target, { deltaPx: 12 });
    expect(scrollTo).toHaveBeenCalledWith({ top: 2_000 - landingLine() - 12, behavior: 'auto' });
    frame(8);
    await expect(landing).resolves.toBe('landed');
  });

  it('takes a sub-pixel residual as one whole device quantum', async () => {
    // A whole-pixel engine ignores `scrollBy(0.7)`: the step is a quantum, and the contract is
    // the residual afterwards (−0.3 px), not the step that was asked for.
    const target = block();
    const landing = landOn(target);
    element.docTop += 0.7;
    frame(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: 1, behavior: 'auto' });
    frame(8);
    await expect(landing).resolves.toBe('landed');
  });

  it('is `capped` when the engine refuses every correction', async () => {
    // A stub scroll that moves nothing (a snapping engine, a locked container): the residual
    // never settles, and the loop must end on its budget rather than on a hope.
    // Neither the jump nor a correction moves the page: the element never reaches the line.
    scrollTo.mockImplementation(() => undefined);
    scrollBy.mockImplementation(() => undefined);
    const target = block();
    const landing = landOn(target);
    frame(LANDING_FRAMES + 2);
    await expect(landing).resolves.toBe('capped');
  });

  it('gives up on an element that left the page', async () => {
    const target = block();
    const landing = landOn(target);
    target.remove();
    frame(10);
    await expect(landing).resolves.toBe('landed');
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('moves nothing for an element that has no box at all', async () => {
    const target = block();
    target.getBoundingClientRect = () => rect(Number.NaN, 40);
    await expect(landOn(target)).resolves.toBe('landed');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('answers `cancelled` for a token a newer landing already replaced', async () => {
    const target = block();
    const stale = beginLanding();
    beginLanding();
    const waiting = followLine(target, stale);
    frame(1);
    await expect(waiting).resolves.toBe('cancelled');
  });

  it('stops on its next frame when a newer landing takes the page without starting a loop', async () => {
    // The page going away (`usePosition`'s cleanup) is a landing with no loop of its own: the
    // running one still has to end, and it ends before it touches the scroll again.
    const target = block();
    const landing = landOn(target);
    beginLanding();
    scrollBy.mockClear();
    element.docTop += 40;
    frame(1);
    await expect(landing).resolves.toBe('cancelled');
    expect(scrollBy).not.toHaveBeenCalled();
    expect(landingActive()).toBe(false);
  });

  it('settles instead of fighting the top of the document', async () => {
    // The target stands above the line while the page is already at its own top: the residual
    // cannot be removed in that direction, and the loop must not spin for its whole budget.
    element.docTop = 40;
    const target = block();
    const landing = landOn(target);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    frame(10);
    await expect(landing).resolves.toBe('landed');
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('hands a caller the generation in force, so a landing inside a landing keeps its token', () => {
    const token = beginLanding();
    expect(landingToken()).toBe(token);
    expect(isCurrent(token)).toBe(true);
    beginLanding();
    expect(isCurrent(token)).toBe(false);
  });

  it('is one instant jump where the document cannot be scrolled at all', async () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 0 });
    const target = block();
    await expect(landOn(target)).resolves.toBe('landed');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(0);
  });
});

describe('the place and the landing measure one line', () => {
  /**
   * BOOK-209 — the capture and the restore must be the same quantity. A place is taken at the
   * line (`placeNow` = `landingLine`, no `ANCHOR_EPS`) and put back at that same line plus its
   * own `deltaPx`; the anchor's `top` after the restore is therefore the `top` it had when the
   * place was taken. A line measured with an eps on one side only shows up here as 2 px.
   */
  it('returns the anchor to the top it was captured at', async () => {
    const article = document.createElement('article');
    article.dataset.n = '3';
    article.id = 'ch-3';
    article.getBoundingClientRect = () => rect(1_000 - scroll.y, 400);
    const block = document.createElement('p');
    block.dataset.blockId = 'ch03#aabbccdd';
    block.getBoundingClientRect = () => rect(1_000 - scroll.y, 200);
    const first = document.createElement('span');
    first.dataset.s = '0';
    first.dataset.quote = 'Первое.';
    first.getBoundingClientRect = () => rect(1_000 - scroll.y, 20);
    const second = document.createElement('span');
    second.dataset.s = '40';
    second.dataset.quote = 'Второе.';
    // The line (72) falls between the two sentences: the place takes the first one below it,
    // so its delta is a real, positive distance instead of the 0 a containing sentence gives.
    second.getBoundingClientRect = () => rect(1_090 - scroll.y, 20);
    block.append(first, second);
    article.append(block);
    document.body.append(article);

    scroll.y = 960;
    const captured = placeAtLine(document, landingLine());
    expect(captured).toMatchObject({ chapter: 3, sentenceId: 'ch03#aabbccdd/s40', deltaPx: 58 });
    const before = second.getBoundingClientRect().top;

    const landing = landOn(second, { deltaPx: captured?.deltaPx ?? 0 });
    frame(10);
    await expect(landing).resolves.toBe('landed');
    // The same top, in the same viewport coordinates: one line, both directions.
    expect(second.getBoundingClientRect().top).toBeCloseTo(before, 1);
    expect(second.getBoundingClientRect().top).toBeCloseTo(landingLine() + (captured?.deltaPx ?? 0), 1);
  });
});

describe('a chapter is landed by its heading', () => {
  it('lands the chapter’s .ch-h and answers false for a chapter this page does not hold', () => {
    const article = document.createElement('article');
    article.id = 'ch-3';
    const heading = document.createElement('header');
    heading.className = 'ch-h';
    article.append(heading);
    document.body.append(article);
    article.getBoundingClientRect = () => rect(1_200 - scroll.y, 400);
    heading.getBoundingClientRect = () => rect(1_200 - scroll.y, 40);

    expect(landChapter(3)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_200 - landingLine(), behavior: 'auto' });
    expect(landChapter(9)).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('lands the article itself when the chapter renders no heading', () => {
    const article = document.createElement('article');
    article.id = 'ch-7';
    document.body.append(article);
    article.getBoundingClientRect = () => rect(2_400 - scroll.y, 100);
    expect(landChapter(7)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2_400 - landingLine(), behavior: 'auto' });
  });
});

/** A promise read after the frames that settle it: the queue is drained here by hand. */
function promiseOf(landing: Promise<string>): Promise<string> {
  frame(8);
  return landing;
}
