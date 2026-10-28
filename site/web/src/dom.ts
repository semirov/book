/** Browser helpers kept out of `lib/` so the reducers and pacing logic stay testable. */

import { offsetTopOfPage } from './lib/headerOffset.ts';

/**
 * Land chapter `n` at the mouth of the reading area: `#ch-N`'s top at the sticky head's
 * **measured** lower edge plus the site's breathing space (the same sum `scroll-margin-top`
 * receives from `headerOffset.ts`), never at a literal that the head can outgrow. The
 * arithmetic is document coordinates — the section's rect plus the scroll already passed —
 * because `scrollIntoView` would re-apply a margin we have already applied.
 *
 * The scroll is a jump (`behavior: 'auto'`): a smooth travel from the end matter to chapter 3
 * of a 130 000 px page never arrives, and the contents row, the notice and the grip link all
 * then read as a tap that did nothing.
 *
 * Returns whether the section exists: a caller keeps the browser's own `#ch-N` jump (and
 * therefore does **not** `preventDefault`) when it does not.
 */
export function scrollToChapter(n: number): boolean {
  const target = document.getElementById(`ch-${n}`);
  if (target === null) return false;
  const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - offsetTopOfPage());
  window.scrollTo({ top, behavior: 'auto' });
  return true;
}

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function nearViewport(element: Element, ahead = 1.5): boolean {
  const rect = element.getBoundingClientRect();
  const height = window.innerHeight || 800;
  return rect.bottom > -ahead * height && rect.top < height * (1 + ahead);
}

/** Is the element with this id on screen right now? (`toc` asks this before a notice.) */
export function elementInViewport(id: string): boolean {
  const element = document.getElementById(id);
  if (element === null) return false;
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < (window.innerHeight || 800);
}

export function chapterInViewport(n: number): boolean {
  const element = document.getElementById(`ch-${n}`);
  if (element === null) return false;
  const rect = element.getBoundingClientRect();
  const height = window.innerHeight || 800;
  return rect.bottom > 0 && rect.top < height;
}

/**
 * Make every top-level page sibling inert while the focus dialog is open (§11.9 rule 1):
 * the book stays legible behind the lamp, but it is not focusable and not clickable.
 */
export function inertBackground(dialog: HTMLElement | null): () => void {
  const inerted: HTMLElement[] = [];
  for (const child of [...(document.getElementById('root')?.children ?? [])]) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === dialog || child.contains(dialog)) continue;
    child.inert = true;
    inerted.push(child);
  }
  return () => {
    for (const element of inerted) element.inert = false;
  };
}

/**
 * BOOK-DOC-34 §2.1 — the caret offset inside the tapped sentence span, in characters from its
 * own start. `caretPositionFromPoint` is Firefox, `caretRangeFromPoint` is Chrome/Safari; a
 * browser with neither falls back to the sentence's own start, which still names the sentence.
 * A tap in the gap between words resolves to the nearest one, so a seam never opens wordless.
 */
export function wordOffsetIn(target: HTMLElement, x: number, y: number): number | null {
  const start = Number(target.getAttribute('data-s') ?? '0');
  if (typeof document === 'undefined') return null;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let within = 0;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position !== null && position !== undefined) {
    node = position.offsetNode;
    within = position.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(x, y) ?? null;
    node = range?.startContainer ?? null;
    within = range?.startOffset ?? 0;
  }
  if (node === null || !target.contains(node)) return null;
  // A sentence span holds one text node, so the caret offset inside it is the offset inside
  // the sentence; the block offset is that plus the sentence's own start.
  return start + Math.min(within, (target.textContent ?? '').length);
}
