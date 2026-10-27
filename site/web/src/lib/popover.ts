/**
 * Where an anchored popover goes (the paragraph chain, «откуда эта фраза», a filing's card).
 *
 * The panel is `position: fixed`, so the anchor rect and the viewport are both in client
 * coordinates: no scroll offset is involved and scrolling the page must not move the panel.
 * Geometry is a pure function of the anchor, the panel's natural size and the viewport — the
 * component measures once per open and never re-measures on scroll, so a scroll cannot make
 * the panel blink (owner, 2026-10-27: popovers near the end did not rise and flickered).
 *
 * BOOK-137 — the box is the **visual** viewport (`window.visualViewport`), not the layout one.
 * On a phone the URL bar, the keyboard and the page's own offset shrink what the reader can
 * see; clamping to `innerWidth/innerHeight` opened a word's panel below the fold. The box
 * therefore carries its offsets (`offsetLeft`/`offsetTop`) and every rule is stated inside it.
 *
 * Rules, in order:
 * - the panel never leaves the box: `margin` on every side, offsets included;
 * - it opens below the anchor when the natural height fits there;
 * - otherwise it flips above the anchor when it fits there;
 * - when neither side holds it, it takes the roomier side and is capped (`maxHeight`), and
 *   scrolls its own text — never the page;
 * - a panel taller than the box is always capped, so `top + maxHeight` stays inside the box.
 */

export type AnchorRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

/**
 * The box a popover must stay inside, in client coordinates. The offsets are the visual
 * viewport's distance from the layout viewport: `0/0` on a desktop, the URL bar's height on a
 * phone, and anything at all with the keyboard up.
 */
export type Viewport = {
  width: number;
  height: number;
  offsetLeft?: number;
  offsetTop?: number;
};

/** What `viewportOf` reads: the window, or a stub of it in a test. */
export type ViewportSource = {
  innerWidth?: number;
  innerHeight?: number;
  visualViewport?: {
    width?: number;
    height?: number;
    offsetLeft?: number;
    offsetTop?: number;
  } | null;
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

/** A finite, positive length; anything else is a missing measurement, not a zero. */
function length(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** An offset is allowed to be zero (and is the only fallback that keeps the box in place). */
function offset(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The visible box: `window.visualViewport` when the browser has one, the window's own size
 * otherwise. A source is taken for the tests; with none it reads the page's window.
 */
export function viewportOf(source?: ViewportSource | null): Viewport {
  const view = source ?? (typeof window === 'undefined' ? null : (window as ViewportSource));
  const visual = view?.visualViewport ?? null;
  return {
    width: length(visual?.width) ?? length(view?.innerWidth) ?? 0,
    height: length(visual?.height) ?? length(view?.innerHeight) ?? 0,
    offsetLeft: offset(visual?.offsetLeft),
    offsetTop: offset(visual?.offsetTop),
  };
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
  /** The box, in client coordinates: the visual viewport's own rectangle. */
  const originLeft = offset(viewport.offsetLeft);
  const originTop = offset(viewport.offsetTop);
  const right = originLeft + viewport.width;
  const bottom = originTop + viewport.height;

  const width = Math.min(Math.max(0, size.width), Math.max(0, viewport.width - 2 * margin));
  const left = clamp(anchor.left, originLeft + margin, right - margin - width);

  // A panel taller than the box always takes a cap: `maxHeight` is what makes it scroll
  // internally instead of leaving the reader's view.
  const ceiling = Math.max(0, viewport.height - 2 * margin);
  const cap = Math.min(Math.max(0, Math.floor(viewport.height * maxFraction)), ceiling);
  const natural = Math.min(Math.max(0, size.height), cap);

  const belowTop = anchor.top + anchor.height + gap;
  const spaceBelow = bottom - margin - belowTop;
  const spaceAbove = anchor.top - gap - (originTop + margin);
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
  const top = clamp(rawTop, originTop + margin, bottom - margin - maxHeight);

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
