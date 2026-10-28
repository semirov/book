/**
 * BOOK-121 — the block's own box, read once.
 *
 * `planPass` validates the layout it is handed and refuses anything that is not the block's
 * final one; this module produces that layout from the DOM in a single read, before the first
 * frame. Nothing here runs per frame: after `measureRun`/`layoutOf` the renderer positions
 * carets from the numbers it already has, so an ink never forces a layout (`getBoundingClientRect`
 * after mount is a defect, not a cost).
 *
 * The line box comes from the block's computed `line-height`, because that is the number the
 * engine's `linePx` means. When it cannot be proven (`normal`, or no cascade at all — jsdom), the
 * gap between two distinct line tops is the same number: a line box is exactly as tall as the
 * distance between consecutive baselines of one run.
 */

import type { PassKind, PassLayout } from './passMotion.ts';

/** The raw read: every run grapheme's box relative to the block, plus the block's own box. */
export type RunMeasure = {
  tops: number[];
  lefts: number[];
  widths: number[];
  blockHeight: number;
  linePx: number;
};

/** The layout `planPass` validates, plus the run's left edges for the two carets. */
export type RunGeometry = PassLayout & { lefts: number[]; widths: number[] };

/**
 * The line box: the declared `line-height` when it is a length, else the smallest positive gap
 * between distinct line tops, else `0` (the caller settles rather than guesses).
 */
export function linePxOf(declared: string, tops: readonly number[]): number {
  const declaredPx = Number.parseFloat(declared);
  if (Number.isFinite(declaredPx) && declaredPx > 0) return declaredPx;

  const lines: number[] = [];
  for (const top of tops) {
    // Sub-pixel jitter is not a line: the boxes of one line agree to a hundredth of a pixel.
    const at = Math.round(top * 100) / 100;
    if (!lines.includes(at)) lines.push(at);
  }
  lines.sort((left, right) => left - right);
  let step = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const delta = (lines[index] ?? 0) - (lines[index - 1] ?? 0);
    if (delta > 0 && (step === 0 || delta < step)) step = delta;
  }
  return step;
}

/**
 * The measured run as the engine's layout. `null` when the numbers cannot describe a block the
 * engine would accept (no boxes, a height or a line box that is not a positive length, a run
 * whose tops go back up the page).
 */
export function layoutOf(measure: RunMeasure, kind: PassKind): RunGeometry | null {
  const { tops, lefts, widths, blockHeight, linePx } = measure;
  const count = tops.length;
  if (count === 0 || lefts.length !== count || widths.length !== count) return null;
  if (!Number.isFinite(linePx) || linePx <= 0) return null;
  if (!Number.isFinite(blockHeight) || blockHeight <= 0) return null;

  // Line 0 is the block's first line: `.p` carries no block padding, so a grapheme's top
  // relative to the block *is* its line box's offset.
  const lines = tops.map((top) => Math.max(0, Math.round(top / linePx)));
  for (let index = 1; index < count; index += 1) {
    if ((lines[index] ?? 0) < (lines[index - 1] ?? 0)) return null;
  }
  const first = lines[0] ?? 0;
  const last = lines[count - 1] ?? first;
  const spanLines = last - first + 1;
  // The block is at least as tall as its own height and as its last inked line; rounding a
  // fractional height must never hand the engine a line the block does not have.
  const blockLines = Math.max(1, Math.round(blockHeight / linePx), last + 1);

  return {
    linePx,
    blockLines,
    // A deletion has no new run: its graphemes are the text that is leaving, and the engine
    // refuses a map for them.
    runLines: kind === 'deletion' ? [] : lines,
    spanStartLine: first,
    spanLines,
    lefts: [...lefts],
    widths: [...widths],
  };
}

/**
 * One read of the block and its run. The block's box is taken first, so every grapheme's top and
 * left can be expressed relative to it — the numbers the carets are placed from.
 */
export function measureRun(block: HTMLElement, nodes: readonly HTMLElement[]): RunMeasure | null {
  if (typeof window === 'undefined' || nodes.length === 0) return null;
  const box = block.getBoundingClientRect();
  const tops: number[] = [];
  const lefts: number[] = [];
  const widths: number[] = [];
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    tops.push(rect.top - box.top);
    lefts.push(rect.left - box.left);
    widths.push(rect.width);
  }
  const linePx = linePxOf(window.getComputedStyle(block).lineHeight, tops);
  if (!Number.isFinite(linePx) || linePx <= 0) return null;
  return { tops, lefts, widths, blockHeight: box.height, linePx };
}
