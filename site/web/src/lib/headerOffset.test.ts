// @vitest-environment jsdom
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BREATHING_PX,
  OFFSET_TOP_PROPERTY,
  headerHeight,
  offsetTopOfPage,
  useStickyOffsets,
} from './headerOffset.ts';

/**
 * BOOK-DOC-84 §11.1 — the sticky offset follows the head's **real** height.
 *
 * The head is one box: the running row, and — when something is happening — the status line in
 * its flow. Idle it is the row alone; active the line adds height. `useStickyOffsets` observes
 * `.top` itself, so `--offset-top` must be the measured box plus the site's constant breathing
 * space in both states, and it must be rewritten when the line appears or goes. jsdom has no
 * layout, so the head's box is a deterministic stub; the observer and the write are the real
 * code. The pixel proof at 390 and 1440 is `scripts/head-cdp.mjs`.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The two real head heights, measured in Chromium at 390: row alone, row + one line. */
const IDLE_PX = 35;
const ACTIVE_PX = 61;

/** A box of a known height, wide as the phone's column. */
function box(height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 390,
    bottom: height,
    width: 390,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

let height = IDLE_PX;
let observerCallback: ResizeObserverCallback | null = null;
let root: Root | null = null;
let host: HTMLDivElement;

/** The head the hook measures: one real `.top` in the DOM, with the stubbed box above. */
function Probe() {
  const ref = useRef<HTMLElement>(null);
  useStickyOffsets(ref);
  return createElement('header', { className: 'top', ref });
}

beforeEach(async () => {
  height = IDLE_PX;
  observerCallback = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe(): void {
        /* the head and the bottom bands are observed; the callback is fired by hand */
      }
      unobserve(): void {
        /* nothing to release in the stub */
      }
      disconnect(): void {
        observerCallback = null;
      }
    },
  );
  const native = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('top') ? box(height) : native.call(this);
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => root?.render(createElement(Probe)));
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function offsetTop(): number {
  return Number.parseFloat(document.documentElement.style.getPropertyValue(OFFSET_TOP_PROPERTY));
}

function fire(): void {
  act(() => {
    observerCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
  });
}

describe('§11.1 — one measured offset, idle and active', () => {
  it('writes the head’s own height plus breathing space in idle', () => {
    expect(headerHeight(document)).toBe(IDLE_PX);
    expect(offsetTop()).toBe(IDLE_PX + BREATHING_PX);
    // The offset is the measurement: the difference is the site's constant, never a literal
    // copied from a screenshot (`offsetTopOfPage` reads the same property back).
    expect(offsetTop() - headerHeight(document)).toBe(BREATHING_PX);
    expect(offsetTopOfPage(document)).toBe(IDLE_PX + BREATHING_PX);
  });

  it('rewrites the offset when the status line appears, and again when it goes', () => {
    const write = vi.spyOn(document.documentElement.style, 'setProperty');
    const idle = offsetTop();

    // The line appears: the head box grows by the observer's own measurement.
    height = ACTIVE_PX;
    fire();
    expect(offsetTop()).toBe(ACTIVE_PX + BREATHING_PX);
    expect(offsetTop()).toBeGreaterThan(idle);
    expect(offsetTop() - headerHeight(document)).toBe(BREATHING_PX);
    // One resize, one write: the callback measured and published, nothing polled.
    const topWrites = write.mock.calls.filter(([property]) => property === OFFSET_TOP_PROPERTY);
    expect(topWrites).toHaveLength(1);

    // The line goes: the head is the row alone again, and the offset follows it back.
    height = IDLE_PX;
    fire();
    expect(offsetTop()).toBe(idle);
    expect(offsetTop() - headerHeight(document)).toBe(BREATHING_PX);
    expect(write.mock.calls.filter(([property]) => property === OFFSET_TOP_PROPERTY)).toHaveLength(2);
  });

  it('publishes nothing when the head is not laid out', () => {
    // A box of 0 px is not a smaller truth: the sheet's fallback stands.
    height = 0;
    fire();
    expect(document.documentElement.style.getPropertyValue(OFFSET_TOP_PROPERTY)).toBe('');
  });
});
