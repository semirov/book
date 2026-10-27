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
type FillNode = { style: { width: string } };
type PanelNode = { style: { top: string; left: string; width: string; maxHeight: string } };

/** The measured box of the anchored paragraph-chain panel. */
export type PanelBox = { top: number; left: number; width: number; maxHeight: number };

/** Reserve the slot's height before its chapter arrives (`lib/layout.ts` owns the number). */
export function reserveHeight(element: StyledNode | null, pixels: number): void {
  if (element === null) return;
  element.style.minHeight = `${pixels}px`;
}

/**
 * Fill the moment rail up to the thumb (BOOK-DOC-50 §4): the traversed part of the track is
 * `percent` of its width. Clamped to the track, so a stale value can never paint past an end.
 */
export function placeFill(element: FillNode | null, percent: number): void {
  if (element === null) return;
  const bounded = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  element.style.width = `${bounded}%`;
}

/** Place (or, with `null`, unplace) the anchored panel from its measured box. */
export function placePanel(element: PanelNode | null, box: PanelBox | null): void {
  if (element === null) return;
  element.style.top = box === null ? '' : `${box.top}px`;
  element.style.left = box === null ? '' : `${box.left}px`;
  element.style.width = box === null ? '' : `${box.width}px`;
  element.style.maxHeight = box === null ? '' : `${box.maxHeight}px`;
}
