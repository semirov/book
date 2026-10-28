/**
 * The anchor-offset contract (owner, 2026-10-28) — **one measured source of truth**.
 *
 * The page used to carry the head's height as three literals in the sheets (`--offset-top:
 * 64px`, then 72 and 80 in the narrow queries). The head is a sticky row of live text: it
 * grows with the phone's chip, with a wrapped title and with the safe-area inset, so a number
 * copied from a screenshot is a number that drifts. Here the head is **measured**, the site's
 * own breathing space is added, and the sum is written back as `--offset-top` on the document
 * root — the property `scroll-margin-top` already reads, so a native `#ch-N` jump, a contents
 * tap and the reading line all land on the same edge.
 *
 * The bottom of the viewport has the same problem in reverse: a band the page fixes over the
 * bottom edge (the capacity plate, an open change card, the notice
 * ticket) covers the end of the book. `applyStickyOffsets` measures the tallest band that is
 * on the page and writes `--offset-bottom`, which the footer's `scroll-margin-bottom` reads and
 * the margin tail reserves as room, so a jump never lands under the band.
 *
 * What is measured, exactly:
 *   - top: `getBoundingClientRect().height` of the sticky head (`.top`), crisp pixels, plus
 *     `BREATHING_PX`;
 *   - bottom: the tallest `getBoundingClientRect().height` among `BOTTOM_BANDS` present, plus
 *     `BREATHING_PX`. With no band on the page nothing is written and the sheet's 8 px fallback
 *     stands — the breathing space alone.
 *
 * Nothing here is stored and nothing is cached: the value is re-measured on mount, on every
 * head resize (`ResizeObserver`) and on every window resize.
 */

import { useEffect, useLayoutEffect, type RefObject } from 'react';

/**
 * The site's own breathing space between the sticky head and the line a jump lands on (and
 * between the last line of the book and the band over the bottom edge). Two pixels of this is
 * the rounding `pageTrack.ts` calls `ANCHOR_EPS`; the rest is air, so the heading's hairline
 * is read, not touched.
 */
export const BREATHING_PX = 8;

/** The sticky head: the running head `Header` renders. */
export const HEADER_SELECTOR = '.top';

/**
 * The bands the page can fix over the viewport's bottom edge. The grip is the tallest one on
 * the page: the capacity plate (BOOK-75) is the one a reader normally meets, the change card is
 * open over it, and the ticket is the smallest. The provenance chain is not a band any more —
 * BOOK-128 comment #3815 moved the word's and the phrase's records into the margin, where they
 * scroll with the text.
 */
export const BOTTOM_BANDS: readonly string[] = ['.capacity-plate', '.change-card', '.ticket'];

export const OFFSET_TOP_PROPERTY = '--offset-top';
export const OFFSET_BOTTOM_PROPERTY = '--offset-bottom';

export type StickyOffsets = { top: number; bottom: number };

/** A measured height plus the breathing space; a fractional height is rounded to whole pixels. */
export function offsetOf(height: number): number {
  const whole = Number.isFinite(height) ? Math.round(height) : 0;
  return Math.max(0, whole) + BREATHING_PX;
}

/** The element's own height; 0 when it is absent or not laid out (jsdom, a hidden page). */
function heightOf(element: Element | null): number {
  if (element === null) return 0;
  const rect = element.getBoundingClientRect();
  return Number.isFinite(rect.height) ? rect.height : 0;
}

/**
 * The offset a jump lands on: the measured `--offset-top` when the page has it, and the head's
 * own live height plus the breathing space when it does not (a sheet that has not been read, a
 * page the hook has not met yet). No literal: the fallback is the same measurement.
 */
export function offsetTopOfPage(doc: Document = document): number {
  if (typeof getComputedStyle !== 'undefined') {
    const raw = getComputedStyle(doc.documentElement).getPropertyValue(OFFSET_TOP_PROPERTY);
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return offsetOf(headerHeight(doc));
}

/** The sticky head's height, from the DOM — `0` where there is no head on this page. */
export function headerHeight(doc: Document = document): number {
  return heightOf(doc.querySelector(HEADER_SELECTOR));
}

/** The grip's height: the tallest bottom band present on this page, `0` when there is none. */
export function gripHeight(doc: Document = document): number {
  return BOTTOM_BANDS.reduce((tallest, selector) => Math.max(tallest, heightOf(doc.querySelector(selector))), 0);
}

/**
 * Measure the page and write both offsets on the document root. Returns the numbers that were
 * measured, so a caller (and a test) reasons about them without reading the sheet back.
 *
 * A box that is **not laid out** (0 px — a head that has not been committed yet, the layout-less
 * test environment) publishes nothing: the property is removed and the sheet's fallback token
 * keeps working, because a measurement of nothing is not a smaller truth.
 */
export function applyStickyOffsets(doc: Document = document): StickyOffsets {
  const header = headerHeight(doc);
  const grip = gripHeight(doc);
  const top = offsetOf(header);
  const bottom = offsetOf(grip);
  const root = doc.documentElement;
  if (header > 0) root.style.setProperty(OFFSET_TOP_PROPERTY, `${String(top)}px`);
  else root.style.removeProperty(OFFSET_TOP_PROPERTY);
  if (grip > 0) root.style.setProperty(OFFSET_BOTTOM_PROPERTY, `${String(bottom)}px`);
  else root.style.removeProperty(OFFSET_BOTTOM_PROPERTY);
  return { top, bottom };
}

/** Measure after commit in the browser; do nothing during a server render. */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Keep `--offset-top` / `--offset-bottom` true for this page: once on mount, on every head
 * resize (a wrapped title, the phone's chip, a font that finishes loading) and on every
 * window resize (a breakpoint that changes the head's padding). `ResizeObserver` is optional:
 * a browser or a test environment without it still gets the mount and the resize measurement.
 */
export function useStickyOffsets(header: RefObject<HTMLElement | null>): void {
  useMeasuredLayout(() => {
    const apply = (): void => {
      applyStickyOffsets(document);
    };
    apply();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(apply);
      if (header.current !== null) observer.observe(header.current);
      for (const selector of BOTTOM_BANDS) {
        const band = document.querySelector(selector);
        if (band !== null) observer.observe(band);
      }
    }
    window.addEventListener('resize', apply);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [header]);
}
