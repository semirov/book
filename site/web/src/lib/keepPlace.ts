import { flushSync } from 'react-dom';

/**
 * BOOK-128 comment #3862 (the owner's phone) — an inner toggle keeps the finger's place.
 *
 * Opening `сказать о тексте — без правки`, `история`, a section or the form changes the block's
 * height above the pressed control, so the control runs out from under the thumb and the page
 * looks like it jumped. The tapped control's own top is read before the state change and again
 * in the same task, after React has committed and before the browser paints (`flushSync`); a
 * difference above half a pixel is handed back to the page with one instant scroll. The block
 * may grow downward; the reader's finger never loses its line.
 *
 * The control may be replaced by the state change (the form's `вмешаться` becomes its word, a
 * fold row becomes its list). `fallback` is then the node that stands where the control did —
 * the head row, the section header — so the measurement is still of the reader's place.
 */
export function keepPlace(
  control: HTMLElement | null,
  change: () => void,
  fallback?: HTMLElement | null,
): void {
  if (control === null) {
    change();
    return;
  }
  const before = control.getBoundingClientRect().top;
  flushSync(change);
  const after =
    control.isConnected ? control : fallback !== null && fallback !== undefined && fallback.isConnected ? fallback : null;
  if (after === null) return;
  const delta = after.getBoundingClientRect().top - before;
  // A sub-pixel difference is the engine's own rounding, not a jump: scrolling by it would
  // turn every toggle into a one-pixel twitch of the page.
  if (Math.abs(delta) <= 0.5) return;
  window.scrollBy({ top: delta, behavior: 'auto' });
}
