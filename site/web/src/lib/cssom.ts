/**
 * BOOK-30 — the values the DOM alone knows, written through CSSOM.
 *
 * The page keeps `style-src 'self'` and no `style-src-attr`, and this module is one of the
 * reasons it can stay that way: the markup carries no `style` attribute at all. The honest
 * reason is hardening, not a fix — React applies a `style` prop through CSSOM, which CSP
 * does not block; the policy would only drop a **literal** `style="…"` attribute (say, from
 * `dangerouslySetInnerHTML`). Two things are gained by keeping values out of the markup: a
 * colour becomes a class (themeable, no value in the DOM) and a geometry that only the DOM
 * knows is written next to the node, in the same commit, so it never paints unset. The
 * guard (`server/test/inlineStyle.test.ts`) keeps the attribute from coming back.
 */

/** A node whose inline style CSSOM exposes; the DOM's `HTMLElement` fits as it is. */
type StyledNode = { style: { minHeight: string } };
type PlacedNode = { style: { left: string } };
type PanelNode = { style: { top: string; left: string; width: string; maxHeight: string } };

/** The measured box of the anchored paragraph-chain panel. */
export type PanelBox = { top: number; left: number; width: number; maxHeight: number };

/** Reserve the slot's height before its chapter arrives (`lib/layout.ts` owns the number). */
export function reserveHeight(element: StyledNode | null, pixels: number): void {
  if (element === null) return;
  element.style.minHeight = `${pixels}px`;
}

/** Place the scrubber's ticks on its 0..100 track; one child per position, in order. */
export function placeTicks(elements: ArrayLike<PlacedNode>, positions: readonly number[]): void {
  positions.forEach((position, index) => {
    const element = elements[index];
    if (element === undefined) return;
    element.style.left = `${position}%`;
  });
}

/** Place (or, with `null`, unplace) the anchored panel from its measured box. */
export function placePanel(element: PanelNode | null, box: PanelBox | null): void {
  if (element === null) return;
  element.style.top = box === null ? '' : `${box.top}px`;
  element.style.left = box === null ? '' : `${box.left}px`;
  element.style.width = box === null ? '' : `${box.width}px`;
  element.style.maxHeight = box === null ? '' : `${box.maxHeight}px`;
}
