/**
 * A chapter that has not been fetched yet still occupies its place in the flow.
 *
 * Without this, every unloaded chapter is a 40 px header, the whole book fits in one
 * viewport and every `IntersectionObserver` fires at once — the "load on scroll" design
 * (DESIGN §6.2) quietly becomes "load everything". The estimate is deliberately rough: it
 * only has to be within a screen or two, and it keeps the reader's position stable while
 * the prose arrives.
 *
 * BOOK-88/BOOK-91: the numbers follow the one prose block in `styles/base.css` — width
 * `min(640, viewport − 2 × gutter)` at ≥1024, `min(622.4, …)` at ≤1023 (38.9rem, the same
 * 71 ch at 17.5 px as 640 at 18), at 18 / 17.5 / 17 px, with a 32 px gutter (24 px below 600).
 * The line count is rounded down and then padded:
 * an over-estimate of characters per line under-reserves the placeholder, and the chapter
 * open then shifts the text below it.
 */

/** `body { line-height: 1.68 }` and `.p { margin-bottom: 1.02em }` of `base.css` / `book.css`. */
const LINE_RATIO = 1.68;
const PARAGRAPH_GAP_RATIO = 1.02;
/** A real paragraph is ~66 characters on the design's measure. */
const AVERAGE_PARAGRAPH_CHARS = 66;
/** `ch` ≈ half the em for PT Serif's digits, but prose glyphs are wider: the haircut keeps the
 *  estimate on the safe side — fewer characters per line means more lines and a taller box. */
const SAFETY = 0.94;

const WIDE_GUTTER = 32;
const PHONE_GUTTER = 24;
/** `--measure: 40rem` and `38.9rem` of `styles/tokens.css`, at the 16 px root. */
const WIDE_MEASURE = 640;
const NARROW_MEASURE = 622.4;

/** The prose block of `styles/tokens.css`, at a viewport: the CSS `min()` of the measure and
 *  the column's content width, with the type size of the same breakpoint. */
function proseBlock(viewportWidth: number): { width: number; font: number } {
  if (viewportWidth >= 1024) {
    return { width: Math.min(WIDE_MEASURE, viewportWidth - 2 * WIDE_GUTTER), font: 18 };
  }
  if (viewportWidth >= 600) {
    return { width: Math.min(NARROW_MEASURE, viewportWidth - 2 * WIDE_GUTTER), font: 17.5 };
  }
  return { width: Math.min(NARROW_MEASURE, viewportWidth - 2 * PHONE_GUTTER), font: 17 };
}

export function charsPerLine(viewportWidth: number): number {
  const { width, font } = proseBlock(viewportWidth);
  return Math.max(1, Math.floor((width / (0.5 * font)) * SAFETY));
}

export function estimateChapterHeight(chars: number, viewportWidth: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  const { font } = proseBlock(viewportWidth);
  const paragraphs = Math.max(1, Math.round(chars / AVERAGE_PARAGRAPH_CHARS));
  // Each paragraph's last line is partly empty; half a line per paragraph models that.
  const lines = chars / charsPerLine(viewportWidth) + 0.5 * paragraphs;
  return Math.round(Math.max(120, lines * font * LINE_RATIO + paragraphs * font * PARAGRAPH_GAP_RATIO));
}
