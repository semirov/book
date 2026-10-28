// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { keepPlace } from './keepPlace.ts';

/**
 * BOOK-128 comment #3862 — the inner toggle's compensation, as arithmetic.
 *
 * The browser numbers are the CDP matrix's (`scripts/record-tap.mjs`, case h); this test pins
 * the three decisions the helper makes: a real delta is handed back to the page as one instant
 * scroll, a sub-pixel rounding is not a jump, and a control the state change replaced is
 * measured through the node that stands where it stood.
 */

function rect(top: number): DOMRect {
  return { top } as DOMRect;
}

function element(top: () => number): HTMLElement {
  const node = document.body.appendChild(document.createElement('div'));
  vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => rect(top()));
  return node;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the pressed control stays under the finger', () => {
  it('scrolls by the control’s own movement, in the same task', () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    let top = 100;
    const control = element(() => top);
    keepPlace(control, () => {
      top = 40;
    });
    expect(scrollBy).toHaveBeenCalledWith({ top: -60, behavior: 'auto' });
  });

  it('leaves a sub-pixel difference alone: rounding is not a jump', () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    let top = 100;
    const control = element(() => top);
    keepPlace(control, () => {
      top = 100.4;
    });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('measures the fallback when the change replaced the control it was pressed on', () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    let top = 100;
    const control = element(() => top);
    const fallback = element(() => 30);
    keepPlace(control, () => {
      control.remove();
      top = 30;
    }, fallback);
    // The control is gone; the node that stands in its place is where the finger now is.
    expect(scrollBy).toHaveBeenCalledWith({ top: -70, behavior: 'auto' });
  });

  it('does nothing without a control, and still runs the change', () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const change = vi.fn();
    keepPlace(null, change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('does not scroll when the control left the page and nothing stands in its place', () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const control = element(() => 100);
    keepPlace(control, () => control.remove());
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
