// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachOutsideClose,
  isTap,
  outsideCloseAllowed,
  TAP_SLOP_PX,
} from './outsideClose.ts';

/**
 * BOOK-111 (owner, 2026-10-27) — what closes an overlay, and when.
 *
 * A tap is a press, a release and no travel; a scroll is not a tap; a second finger is not a
 * tap; a coarse pointer is never a click. The decision is pure where it can be, and the one
 * listener bundle is attached and removed as one unit — a page that mounts a strip twenty
 * times must not leave twenty listeners behind.
 */

/** jsdom's viewport is 1024 px wide and has no `matchMedia`: the tests say which device it is. */
function device(kind: 'touch' | 'mouse'): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: kind === 'touch' ? 390 : 1440 });
  if (kind === 'touch') {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    return;
  }
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
}

function pointer(type: string, target: EventTarget, x: number, y: number, pointerId = 1): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('outsideCloseAllowed', () => {
  it('never closes on a coarse pointer, and never below the desktop breakpoint', () => {
    expect(outsideCloseAllowed({ coarsePointer: true, width: 1440 })).toBe(false);
    expect(outsideCloseAllowed({ coarsePointer: true, width: 390 })).toBe(false);
    expect(outsideCloseAllowed({ coarsePointer: false, width: 390 })).toBe(false);
    expect(outsideCloseAllowed({ coarsePointer: false, width: 767 })).toBe(false);
    expect(outsideCloseAllowed({ coarsePointer: false, width: 768 })).toBe(true);
    expect(outsideCloseAllowed({ coarsePointer: false, width: 1440 })).toBe(true);
  });

  it('reads the page at ask time, and decides by width when matchMedia is absent', () => {
    // jsdom has no `matchMedia`: the viewport width alone answers, both ways.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    expect(outsideCloseAllowed()).toBe(false);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    expect(outsideCloseAllowed()).toBe(true);
    // A coarse pointer outranks a wide viewport (a tablet in landscape is still a thumb).
    device('touch');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    expect(outsideCloseAllowed()).toBe(false);
  });
});

describe('the environment behind the helper', () => {
  it('degrades to a desktop answer without a window, and installs nothing without a document', () => {
    vi.stubGlobal('window', undefined);
    expect(outsideCloseAllowed()).toBe(true);
    vi.unstubAllGlobals();

    vi.stubGlobal('document', undefined);
    const cleanup = attachOutsideClose({ isInside: () => false, onOutside: () => undefined });
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
    vi.unstubAllGlobals();
  });

  it('falls back to the desktop width when the viewport is unmeasurable', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: Number.NaN });
    // No `matchMedia` here either: the fallback width is a desktop's, so the rule stays desktop.
    expect(outsideCloseAllowed()).toBe(true);
  });
});

describe('isTap', () => {
  it('is the same tap at or below the slop, and a scroll above it', () => {
    expect(TAP_SLOP_PX).toBe(8);
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 18, y: 10 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 18 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 19 })).toBe(false);
    // A diagonal travel counts as its length, not its larger edge.
    expect(isTap({ x: 10, y: 10 }, { x: 16, y: 16 })).toBe(false);
    expect(isTap({ x: 10, y: 10 }, { x: 16, y: 16 }, 20)).toBe(true);
  });
});

describe('attachOutsideClose', () => {
  let inside: HTMLDivElement;
  let onOutside: ReturnType<typeof vi.fn>;
  let detach: () => void;

  beforeEach(() => {
    inside = document.body.appendChild(document.createElement('div'));
    inside.className = 'inside';
    onOutside = vi.fn();
    detach = attachOutsideClose({ isInside: (target) => inside.contains(target), onOutside });
  });

  afterEach(() => {
    detach();
  });

  it('closes on a fine pointer’s tap outside and never on a press that began inside', () => {
    device('mouse');
    pointer('pointerdown', inside, 5, 5);
    pointer('pointerup', inside, 5, 5);
    expect(onOutside).not.toHaveBeenCalled();

    // A press that began inside and ended outside is a drag, not a click on the page.
    pointer('pointerdown', inside, 5, 5);
    pointer('pointerup', document.body, 5, 5);
    expect(onOutside).not.toHaveBeenCalled();

    pointer('pointerdown', document.body, 5, 5);
    pointer('pointerup', document.body, 5, 5);
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('never closes a tap on a coarse pointer, even a wide one', () => {
    device('touch');
    pointer('pointerdown', document.body, 5, 5);
    pointer('pointerup', document.body, 5, 5);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('answers from the device at the moment of the tap, not the mount', () => {
    device('mouse');
    // The tablet is rotated between mount and tap: the press is a thumb now.
    device('touch');
    pointer('pointerdown', document.body, 5, 5);
    pointer('pointerup', document.body, 5, 5);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('a scroll is not a tap: 40 px of travel never closes, on either device', () => {
    for (const kind of ['touch', 'mouse'] as const) {
      device(kind);
      pointer('pointerdown', document.body, 5, 5);
      pointer('pointermove', document.body, 5, 45);
      pointer('pointerup', document.body, 5, 45);
      expect(onOutside, kind).not.toHaveBeenCalled();
    }
    // Even the release landing back where the press began: the travel already happened.
    device('mouse');
    pointer('pointerdown', document.body, 5, 5);
    pointer('pointermove', document.body, 5, 45);
    pointer('pointerup', document.body, 5, 5);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('a second pointer or a cancelled gesture is never a tap', () => {
    device('mouse');
    pointer('pointerdown', document.body, 5, 5, 1);
    pointer('pointerdown', document.body, 60, 60, 2);
    pointer('pointerup', document.body, 5, 5, 2);
    pointer('pointerup', document.body, 5, 5, 1);
    expect(onOutside).not.toHaveBeenCalled();

    pointer('pointerdown', document.body, 5, 5);
    pointer('pointercancel', document.body, 5, 5);
    pointer('pointerup', document.body, 5, 5);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('removes every listener it added, cycle after cycle', () => {
    detach(); // the outer surface first, so only these cycles are counted
    const added: string[] = [];
    const removed: string[] = [];
    const add = vi.spyOn(document, 'addEventListener').mockImplementation((type: string) => {
      added.push(type);
    });
    const remove = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementation((type: string) => {
        removed.push(type);
      });
    const live = (type: string): number =>
      added.filter((entry) => entry === type).length - removed.filter((entry) => entry === type).length;

    for (let cycle = 0; cycle < 20; cycle += 1) {
      attachOutsideClose({ isInside: (target) => inside.contains(target), onOutside })();
    }
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      expect(added.filter((entry) => entry === type)).toHaveLength(20);
      expect(live(type), type).toBe(0);
    }

    // One surface mounted: exactly one live handler of each kind, and it is the one removed.
    const cleanup = attachOutsideClose({ isInside: (target) => inside.contains(target), onOutside });
    for (const type of ['pointerdown', 'pointerup']) expect(live(type), type).toBe(1);
    cleanup();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) expect(live(type), type).toBe(0);
    add.mockRestore();
    remove.mockRestore();
  });

  it('a release with no press, or a press whose release jumped, closes nothing', () => {
    device('mouse');
    // A move with no press open has nothing to measure — a stray event, not a gesture.
    pointer('pointermove', document.body, 5, 5);
    expect(onOutside).not.toHaveBeenCalled();
    // A jump between press and release is travel, even when no `pointermove` reported it.
    pointer('pointerdown', document.body, 5, 5);
    pointer('pointerup', document.body, 200, 200);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('a press on the document itself is outside the overlay', () => {
    device('mouse');
    pointer('pointerdown', document, 5, 5);
    pointer('pointerup', document, 5, 5);
    expect(onOutside).toHaveBeenCalledTimes(1);
  });
});
