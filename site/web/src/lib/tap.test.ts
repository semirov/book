import { describe, expect, it } from 'vitest';

import { beginPress, endsAsTap, movePress, OPEN_SLOP_PX } from './tap.ts';

/**
 * BOOK-128 comment #3862 — the opening gesture's own rule, as a pure function.
 *
 * The paragraph opens on the pointer's release, once; the click a browser synthesizes from the
 * same gesture never replays it. This module decides what the release is: the same pointer that
 * went down, still inside the opening slop. Eight to twelve pixels of thumb wobble is a tap; a
 * longer travel is the page being scrolled.
 */
describe('a press is a tap only when it says so', () => {
  it('opens the slop wider than the overlay’s 8 px, so the owner’s 8–12 px wobble still counts', () => {
    expect(OPEN_SLOP_PX).toBe(12);
    const press = beginPress({ pointerId: 1, clientX: 10, clientY: 10 });
    movePress(press, { x: 20, y: 10 });
    expect(press.moved).toBe(false);
    expect(endsAsTap(press, { pointerId: 1, clientX: 22, clientY: 10 })).toBe(true);
  });

  it('a move past the slop is never a tap, even if the release comes back', () => {
    const press = beginPress({ pointerId: 1, clientX: 10, clientY: 10 });
    movePress(press, { x: 23, y: 10 });
    expect(press.moved).toBe(true);
    expect(endsAsTap(press, { pointerId: 1, clientX: 10, clientY: 10 })).toBe(false);
  });

  it('a release by another pointer, or with no press behind it, is not this paragraph’s tap', () => {
    const press = beginPress({ pointerId: 4, clientX: 10, clientY: 10 });
    expect(endsAsTap(press, { pointerId: 5, clientX: 10, clientY: 10 })).toBe(false);
    expect(endsAsTap(null, { pointerId: 4, clientX: 10, clientY: 10 })).toBe(false);
  });

  it('a second finger joining the gesture blocks it, whatever either finger does next', () => {
    const second = beginPress({ pointerId: 2, clientX: 11, clientY: 10 }, true);
    expect(second.moved).toBe(true);
    expect(endsAsTap(second, { pointerId: 2, clientX: 11, clientY: 10 })).toBe(false);
  });

  it('a fresh press starts clean: a release lost outside the paragraph does not swallow the next tap', () => {
    const lost = beginPress({ pointerId: 1, clientX: 10, clientY: 10 });
    expect(endsAsTap(lost, { pointerId: 7, clientX: 10, clientY: 10 })).toBe(false);
    const next = beginPress({ pointerId: 7, clientX: 30, clientY: 30 });
    expect(endsAsTap(next, { pointerId: 7, clientX: 31, clientY: 30 })).toBe(true);
  });
});
