/**
 * BOOK-220 §11.2 — the printing block's own box, read once.
 *
 * The contract the renderer is built on: the paragraph is laid out **once** in its final text
 * and the not-yet-written part is **invisible, not absent**. So nothing here measures nodes
 * that stand for characters — the whole run is one text node and the geometry is read from it
 * with `Range`s, which is also why the DOM's node count does not grow with the text.
 *
 * Two readers, both used once per print and never per frame:
 *
 *   • `linePxOf` — the line box, from the computed `line-height` when the cascade gives a
 *     length, else from the smallest gap between two distinct line tops (jsdom proves nothing,
 *     a strut makes the tops unequal);
 *   • `measureGraphemes` — each run grapheme's box relative to the copy it is painted in, in one
 *     read, plus the copy's own box: the clip's reference box and the caret's ceiling.
 *
 * `geometryOf` is the pure half: numbers in, the validated geometry out (a run whose tops go
 * back up the page is refused, never guessed at). The browser proves the boxes themselves.
 */

export type RunMeasure = {
  tops: number[];
  lefts: number[];
  widths: number[];
  copyWidth: number;
  copyHeight: number;
  blockHeight: number;
  linePx: number;
};

export type PrintGeometry = {
  linePx: number;
  /** The copy's own box: the clip's reference box (the caret is painted in the same coordinates). */
  copyWidth: number;
  copyHeight: number;
  blockLines: number;
  /** The run's line, left and width per grapheme — the caret is placed from these, never re-read. */
  runLines: number[];
  lefts: number[];
  widths: number[];
};

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
 * The measured run as the renderer's geometry. `null` when the numbers cannot describe a block
 * that could be printed: no boxes, a line box that is not a positive length, a copy with no
 * width, or a run whose tops go back up the page.
 */
export function geometryOf(measure: RunMeasure): PrintGeometry | null {
  const { tops, lefts, widths, copyWidth, copyHeight, blockHeight, linePx } = measure;
  const count = tops.length;
  if (count === 0 || lefts.length !== count || widths.length !== count) return null;
  if (!Number.isFinite(linePx) || linePx <= 0) return null;
  if (!Number.isFinite(copyWidth) || copyWidth <= 0) return null;
  if (!Number.isFinite(copyHeight) || copyHeight <= 0) return null;
  if (!Number.isFinite(blockHeight) || blockHeight <= 0) return null;

  // The run's line numbers are relative to the copy's own top: the clip and the caret stand in
  // the same coordinates, so the first run line is line 0 of the run, not of the page.
  const runLines = tops.map((top) => Math.max(0, Math.round(top / linePx)));
  for (let index = 1; index < count; index += 1) {
    if ((runLines[index] ?? 0) < (runLines[index - 1] ?? 0)) return null;
  }
  // The copy is at least as tall as its own height: rounding a fractional height must never
  // hand the clip a line the copy does not have.
  const blockLines = Math.max(1, Math.round(Math.max(copyHeight, blockHeight) / linePx), (runLines[count - 1] ?? 0) + 1);

  return { linePx, copyWidth, copyHeight, blockLines, runLines, lefts: [...lefts], widths: [...widths] };
}

/**
 * One read of the run's graphemes out of the copy's single text node, and of the two boxes the
 * numbers are expressed in. `startOffset` is the run's first character within `node.data`;
 * `clusters` are the run's grapheme clusters (their `length` sums to the run's code units).
 */
export function measureGraphemes(
  block: HTMLElement,
  copy: HTMLElement,
  node: Text,
  clusters: readonly string[],
  startOffset: number,
): RunMeasure | null {
  if (typeof window === 'undefined' || clusters.length === 0) return null;
  const blockBox = block.getBoundingClientRect();
  const copyBox = copy.getBoundingClientRect();
  const range = document.createRange();
  const tops: number[] = [];
  const lefts: number[] = [];
  const widths: number[] = [];
  let offset = startOffset;
  for (const cluster of clusters) {
    const end = offset + cluster.length;
    range.setStart(node, offset);
    range.setEnd(node, end);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
    if (rect === undefined || rect === null) return null;
    tops.push(rect.top - copyBox.top);
    lefts.push(rect.left - copyBox.left);
    widths.push(rect.width);
    offset = end;
  }
  const linePx = linePxOf(window.getComputedStyle(block).lineHeight, tops);
  return {
    tops,
    lefts,
    widths,
    copyWidth: copyBox.width,
    copyHeight: copyBox.height,
    blockHeight: blockBox.height,
    linePx,
  };
}
