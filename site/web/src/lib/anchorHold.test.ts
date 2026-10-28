// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { holdAnchor } from './anchorHold.ts';

/**
 * BOOK-128 comment #3852 — the reading line's hold.
 *
 * jsdom has no layout, so the geometry is stubbed the way a browser reports it: the reading line
 * at a `top`, and the block's box at its own. The real timeline (220 ms of height, the line
 * within half a pixel) is `scripts/accordion-cdp.mjs`; what is pinned here is the rule — a line
 * that does not move is not scrolled, a line that moves is put back by exactly the distance with
 * one instant `scrollBy`, and an engine without hit-testing is a no-op rather than a crash.
 */

type Rect = { top: number };

function stubRect(element: HTMLElement, rect: Rect): void {
  element.getBoundingClientRect = () =>
    ({
      top: rect.top,
      bottom: rect.top + 10,
      left: 0,
      right: 100,
      width: 100,
      height: 10,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

let scrollBy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollBy = vi.fn();
  Object.defineProperty(window, 'scrollBy', { value: scrollBy, writable: true, configurable: true });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** A paragraph (the reading line), a block, and the hit-test that finds the line. */
function scene(input: { lineTop: number; blockTop: number }): { line: Rect; release: () => void } {
  const line = document.body.appendChild(document.createElement('p'));
  line.className = 'p';
  const lineRect: Rect = { top: input.lineTop };
  stubRect(line, lineRect);

  const block = document.body.appendChild(document.createElement('div'));
  block.className = 'rec';
  stubRect(block, { top: input.blockTop });
  const inner = block.appendChild(document.createElement('div'));
  inner.className = 'rec-inner';

  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [line] });

  return { line: lineRect, release: holdAnchor() };
}

describe('the reading line’s hold', () => {
  it('moves nothing while the line stays where it is', async () => {
    const { release } = scene({ lineTop: 100, blockTop: 100 });
    await frame();
    release();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('puts the line back by exactly the distance it moved', async () => {
    const { line, release } = scene({ lineTop: 100, blockTop: 100 });
    // A real scroll moves the line: the stub applies the step, so one round is enough and the
    // residual check cannot fire a second time.
    scrollBy.mockImplementation(({ top }: { top: number }) => {
      line.top -= top;
    });
    line.top = 320; // the block's height arrived above the line
    await frame();
    release();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: 220, behavior: 'auto' });
  });

  it('snaps a sub-pixel correction to the device-pixel grid, and never smooth', async () => {
    // A scroll offset of whole pixels ignores `scrollBy(0.59)` outright; the step is a whole
    // quantum, and what is left after it is under half a pixel.
    const { line, release } = scene({ lineTop: 40, blockTop: -180 });
    scrollBy.mockImplementation(({ top }: { top: number }) => {
      line.top -= top;
    });
    line.top = 57.5;
    await frame();
    release();
    const [call] = scrollBy.mock.calls as Array<[{ behavior: string; top: number }]>;
    expect(call?.[0].behavior).toBe('auto');
    // Whole pixels: the step is the delta rounded to the engine's grid.
    expect(call?.[0].top).toBe(18);
    expect(Math.abs(17.5 - (call?.[0].top ?? 0))).toBeLessThanOrEqual(0.5);
  });

  it('stops on the reader’s own wheel instead of fighting the gesture', async () => {
    const { line, release } = scene({ lineTop: 100, blockTop: 100 });
    window.dispatchEvent(new WheelEvent('wheel'));
    line.top = 300;
    await frame();
    release();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('is a no-op in an engine with no hit-testing (jsdom, a text browser)', () => {
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: undefined });
    const block = document.body.appendChild(document.createElement('div'));
    block.className = 'rec';
    const release = holdAnchor();
    expect(() => release()).not.toThrow();
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
