/**
 * A chapter that has not been fetched yet still occupies its place in the flow.
 *
 * Without this, every unloaded chapter is a 40 px header, the whole book fits in one
 * viewport and every `IntersectionObserver` fires at once — the "load on scroll" design
 * (DESIGN §6.2) quietly becomes "load everything". The estimate is deliberately rough: it
 * only has to be within a screen or two, and it keeps the reader's position stable while
 * the prose arrives.
 */

const LINE_HEIGHT = 17 * 1.68;
const PARAGRAPH_GAP = 17.34;
const AVERAGE_PARAGRAPH_CHARS = 66;

export function charsPerLine(viewportWidth: number): number {
  if (viewportWidth >= 1024) return 60;
  if (viewportWidth >= 600) return 56;
  if (viewportWidth >= 360) return 34;
  return 30;
}

export function estimateChapterHeight(chars: number, viewportWidth: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  const lines = chars / charsPerLine(viewportWidth);
  const paragraphs = Math.max(1, Math.round(chars / AVERAGE_PARAGRAPH_CHARS));
  return Math.round(Math.max(120, lines * LINE_HEIGHT + paragraphs * PARAGRAPH_GAP));
}
