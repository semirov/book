/**
 * BOOK-220 §11.2 — «следить»: the page follows the ink while it prints.
 *
 * The owner's contract: a lowercase mono 12 control in the head's status line, visible **only
 * while something prints**; while on, the page scrolls so the caret's centre sits at ~45 % of
 * the viewport, **one scroll write per frame**, no smooth animation, no scroll at all inside a
 * ±40 px band. It survives paragraph and chapter boundaries (the page loads the next chapter
 * through its own observers; this module only keeps scrolling). Any manual scroll — wheel,
 * touch, a keyboard scroll key, a drag — turns it off at once, and the control shows off. The
 * state lasts the session.
 *
 * The module is the store: the renderers report the caret's document position once per frame
 * (`reportCaret`), the control subscribes (`subscribePrintFollow`), and `beginPrint` counts the
 * live renderers so the control is absent when nothing prints. No layout read here at all: the
 * caret's y arrives from the renderer's one measurement.
 */

/** The band around the 45 % line inside which the page is left alone. */
export const FOLLOW_BAND_PX = 40;
/** Where the caret's centre sits in the viewport while following. */
export const FOLLOW_AT = 0.45;
/** The session's one fact — off until the reader asks for it; it never turns itself back on. */
const KEY = 'print-follow';

type Listener = () => void;

let on = false;
let active = 0;
let listening = false;
const listeners = new Set<Listener>();

const read = (): boolean => {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

const write = (value: boolean): void => {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    /* a store the page cannot write is a store it cannot read: the value lives this page only */
  }
};

on = read();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Whether the follow is on, and whether anything is printing (the control's visibility). */
export function printFollowState(): { on: boolean; active: number } {
  return { on, active };
}

/**
 * BOOK-220 × BOOK-209 — the ink owns the page while it is followed: on, and with a renderer
 * printing. The position layer (`lib/usePosition.ts`) asks this before it restores a place, so a
 * resume or a back/forward never lands under the follow's one scroll a frame. The follow itself
 * never calls the position layer: it moves the page, it does not remember it.
 */
export function followingInk(): boolean {
  return on && active > 0;
}

export function subscribePrintFollow(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPrintFollow(next: boolean): void {
  if (on === next) return;
  on = next;
  write(on);
  if (on) listen();
  notify();
}

export function togglePrintFollow(): void {
  setPrintFollow(!on);
}

/** A manual scroll switches the follow off at once: the reader's hand outranks the ink. */
function manual(): void {
  if (on) setPrintFollow(false);
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);

/** Installed once, on the first print or the first tap: four input events, nothing polled. */
function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('wheel', manual, { passive: true });
  window.addEventListener('touchstart', manual, { passive: true });
  window.addEventListener('touchmove', manual, { passive: true });
  window.addEventListener('mousedown', (event) => {
    const target = event.target as Element | null;
    if (target !== null && typeof target.closest === 'function' && target.closest('.print-follow') !== null) return;
    manual();
  });
  window.addEventListener('keydown', (event) => {
    if (SCROLL_KEYS.has(event.key)) manual();
  });
}

/** A renderer mounted: the control appears, and the manual-scroll listeners exist. */
export function beginPrint(): () => void {
  active += 1;
  listen();
  notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = Math.max(0, active - 1);
    notify();
  };
}

/**
 * The scroll write for one frame: `null` when the caret is inside the band (or the follow is
 * off), else the distance that puts its centre on the 45 % line. Pure, so the band is a test.
 */
export function followDelta(
  caretCentreDocY: number,
  viewportHeight: number,
  scrollY: number,
  band = FOLLOW_BAND_PX,
): number | null {
  if (!Number.isFinite(caretCentreDocY) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return null;
  const centre = caretCentreDocY - scrollY;
  const delta = centre - viewportHeight * FOLLOW_AT;
  return Math.abs(delta) <= band ? null : delta;
}

/**
 * The renderer's one call per frame: the caret's centre in **document** coordinates and its
 * height. One `scrollBy`, no `behavior: 'smooth'`, never inside the band.
 */
export function reportCaret(caretCentreDocY: number, viewportHeight: number, scrollY: number): void {
  if (!on || typeof window === 'undefined') return;
  const delta = followDelta(caretCentreDocY, viewportHeight, scrollY);
  if (delta === null) return;
  window.scrollBy(0, delta);
}

/** The test/session seam: forget the stored fact (a fresh profile, a test's beforeEach). */
export function resetPrintFollow(): void {
  active = 0;
  on = false;
  notify();
}
