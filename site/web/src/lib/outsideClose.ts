/**
 * BOOK-111 (owner, 2026-10-27) — an overlay on a touch surface closes by its own ✕, by a
 * successful submit, or by `Escape` from a hardware keyboard. A thumb that grazes the page
 * must not throw away a half-written intervention, and neither may a two-finger scroll: the
 * tap is the act, and a scroll is not a tap.
 *
 * Pure until the edge — `outsideCloseAllowed` and `isTap` decide, `attachOutsideClose` is the
 * only part that touches `document`. The pointer's own nature is read **at event time**, never
 * at mount: a tablet rotated from landscape to portrait must not keep the answer it had when
 * the panel opened.
 *
 * A fine-pointer desktop keeps the behaviour it had: a click outside closes the overlay.
 */

/** Movement at or below this many pixels is still the same tap; above it, the page scrolled. */
export const TAP_SLOP_PX = 8;

/** The pointer class a close decision is made against, read once per event. */
export type PointerEnv = {
  coarsePointer: boolean;
  /** The viewport width in CSS pixels. */
  width: number;
};

export type PointerPoint = { x: number; y: number };

export function isTap(start: PointerPoint, end: PointerPoint, slop: number = TAP_SLOP_PX): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return Math.sqrt(dx * dx + dy * dy) <= slop;
}

/**
 * The environment the page is in right now. `matchMedia` is absent under jsdom (and in any
 * server render), so the width alone decides there — the coarse-pointer question cannot be
 * asked, and a narrow viewport is the honest answer.
 */
function pointerEnv(): PointerEnv {
  if (typeof window === 'undefined') return { coarsePointer: false, width: 1024 };
  const coarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches === true;
  const width = Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
  return { coarsePointer, width };
}

/**
 * Does a press outside the overlay close it? Never on a coarse pointer (a thumb is not a
 * click), never below the desktop breakpoint, and yes on a fine pointer from 768 px up.
 */
export function outsideCloseAllowed(env: PointerEnv = pointerEnv()): boolean {
  return !env.coarsePointer && env.width >= 768;
}

export type OutsideClose = {
  /** Is this press inside the overlay (and any surface it owns)? */
  isInside: (target: HTMLElement) => boolean;
  /** The overlay is being closed by the press that began outside it. */
  onOutside: () => void;
};

/**
 * Listen for a tap that began outside the overlay and ends outside it, unhurried, on a fine
 * pointer. Returns the cleanup that removes every listener it installed.
 *
 * The press is the whole gesture: `pointerdown` records where it started and whether that
 * point was inside; a `pointermove` beyond the slop, a second pointer joining (a pinch, a
 * two-finger scroll) or `pointercancel` marks it not-a-tap; only a clean `pointerup` closes.
 * All four listeners are capture-phase and passive — the overlay never consumes the page's
 * own gestures to watch them.
 */
export function attachOutsideClose({ isInside, onOutside }: OutsideClose): () => void {
  if (typeof document === 'undefined') return () => undefined;

  let press: { at: PointerPoint; inside: boolean; blocked: boolean } | null = null;

  const down = (event: PointerEvent): void => {
    if (press !== null) {
      // A second pointer joined the same gesture: never a tap, whatever happens next.
      press.blocked = true;
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    press = {
      at: { x: event.clientX, y: event.clientY },
      inside: target !== null && isInside(target),
      blocked: false,
    };
  };

  const move = (event: PointerEvent): void => {
    if (press === null || press.blocked) return;
    if (!isTap(press.at, { x: event.clientX, y: event.clientY })) press.blocked = true;
  };

  const cancel = (): void => {
    press = null;
  };

  const up = (event: PointerEvent): void => {
    const done = press;
    press = null;
    if (done === null || done.inside || done.blocked) return;
    if (!isTap(done.at, { x: event.clientX, y: event.clientY })) return;
    if (!outsideCloseAllowed()) return;
    onOutside();
  };

  const options: AddEventListenerOptions = { capture: true, passive: true };
  document.addEventListener('pointerdown', down, options);
  document.addEventListener('pointermove', move, options);
  document.addEventListener('pointerup', up, options);
  document.addEventListener('pointercancel', cancel, options);
  return () => {
    document.removeEventListener('pointerdown', down, options);
    document.removeEventListener('pointermove', move, options);
    document.removeEventListener('pointerup', up, options);
    document.removeEventListener('pointercancel', cancel, options);
    press = null;
  };
}
