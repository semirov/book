/**
 * Where an anchored popover goes (the paragraph chain, «откуда эта фраза»).
 *
 * The panel is `position: fixed`, so the anchor rect and the viewport are both in client
 * coordinates: no scroll offset is involved and scrolling the page must not move the panel.
 * Geometry is a pure function of the anchor, the panel's natural size and the viewport — the
 * component measures once per open and never re-measures on scroll, so a scroll cannot make
 * the panel blink (owner, 2026-10-27: popovers near the end did not rise and flickered).
 *
 * Rules, in order:
 * - the panel never leaves the viewport: `margin` on every side;
 * - it opens below the anchor when the natural height fits there;
 * - otherwise it flips above the anchor when it fits there;
 * - when neither side holds it, it takes the roomier side and is capped (`maxHeight`), and
 *   scrolls its own text — never the page.
 */

export type AnchorRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type Viewport = {
  width: number;
  height: number;
};

export type PanelSize = {
  width: number;
  height: number;
};

export type PopoverPlacement = {
  side: 'above' | 'below';
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

export const POPOVER_MARGIN = 12;
export const POPOVER_GAP = 8;
/** A chain may use 62 % of the screen at most; its own list scrolls beyond that. */
export const POPOVER_MAX_FRACTION = 0.62;

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

export function placePopover(
  anchor: AnchorRect,
  size: PanelSize,
  viewport: Viewport,
  options: { margin?: number; gap?: number; maxFraction?: number } = {},
): PopoverPlacement {
  const margin = options.margin ?? POPOVER_MARGIN;
  const gap = options.gap ?? POPOVER_GAP;
  const maxFraction = options.maxFraction ?? POPOVER_MAX_FRACTION;

  const width = Math.min(Math.max(0, size.width), Math.max(0, viewport.width - 2 * margin));
  const left = clamp(anchor.left, margin, viewport.width - margin - width);

  const cap = Math.max(0, Math.floor(viewport.height * maxFraction));
  const natural = Math.min(Math.max(0, size.height), cap);

  const belowTop = anchor.top + anchor.height + gap;
  const spaceBelow = viewport.height - margin - belowTop;
  const spaceAbove = anchor.top - gap - margin;
  const fitsBelow = natural <= spaceBelow;
  const fitsAbove = natural <= spaceAbove;

  let side: PopoverPlacement['side'];
  if (fitsBelow && !fitsAbove) side = 'below';
  else if (fitsAbove && !fitsBelow) side = 'above';
  else if (fitsBelow && fitsAbove) side = 'below';
  else side = spaceBelow >= spaceAbove ? 'below' : 'above';

  const available = Math.max(0, side === 'below' ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(natural, available);
  const rawTop = side === 'below' ? belowTop : anchor.top - gap - maxHeight;
  const top = clamp(rawTop, margin, viewport.height - margin - maxHeight);

  return { side, top, left, width, maxHeight };
}

/** Whether two placements are the same to sub-pixel precision (no re-render loop). */
export function samePlacement(left: PopoverPlacement | null, right: PopoverPlacement | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.side === right.side &&
    Math.abs(left.top - right.top) < 0.5 &&
    Math.abs(left.left - right.left) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.maxHeight - right.maxHeight) < 0.5
  );
}
