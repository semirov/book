import { isTap, type PointerPoint } from './outsideClose.ts';

/**
 * BOOK-128 comment #3862 (the owner's phone, twice) — one gesture, one opening.
 *
 * A browser sends a tap as `pointerdown` → `pointerup` → `click`. Binding the paragraph's
 * opening to `pointerup` **and** `click` made one tap two toggles: the block mounted on the
 * pointer's release and unmounted on the click that followed it — the reported flash that left
 * the record closed. The paragraph now opens on the pointer's own release and lets `click`
 * serve only a keyboard or an assistive technology (`detail === 0`); this module is the one
 * place the press is decided, so the rule has a test instead of a comment.
 *
 * The opening slop is wider than the overlay's outside-close: the owner's thumb wobbles 8–12 px
 * while meaning one tap, and a finger that travelled further was scrolling the page, not
 * touching the sentence.
 */

/** A finger that moved at most this far was still tapping the sentence. */
export const OPEN_SLOP_PX = 12;

/** The gesture in flight: where it began, by which pointer, and whether it is still a tap. */
export type TapPress = {
  pointerId: number;
  at: PointerPoint;
  /** A move beyond the slop or a second pointer: never a tap, whatever the release does. */
  moved: boolean;
};

export type PressPoint = { pointerId: number; clientX: number; clientY: number };

/**
 * The press that begins a tap. Every `pointerdown` starts a fresh press — a release that was
 * lost outside the paragraph must not swallow the next tap — and a press that is not the
 * primary pointer (a second finger) is already not a tap.
 */
export function beginPress(point: PressPoint, blocked = false): TapPress {
  return {
    pointerId: point.pointerId,
    at: { x: point.clientX, y: point.clientY },
    moved: blocked,
  };
}

/** `pointermove`: the press stops being a tap as soon as it leaves the slop. */
export function movePress(press: TapPress | null, point: PointerPoint): void {
  if (press === null || press.moved) return;
  if (!isTap(press.at, point, OPEN_SLOP_PX)) press.moved = true;
}

/**
 * `pointerup`: is this the release of the same press, still inside the slop? A pointerup with
 * no press behind it (no pointerdown on the paragraph) is not a tap the paragraph opened.
 */
export function endsAsTap(press: TapPress | null, point: PressPoint): boolean {
  if (press === null || press.pointerId !== point.pointerId || press.moved) return false;
  return isTap(press.at, { x: point.clientX, y: point.clientY }, OPEN_SLOP_PX);
}
