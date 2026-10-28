import type { CommentDto } from '@book/shared';
import { useSyncExternalStore } from 'react';

import { closeOverlay, registerOverlay } from './overlayRegistry.ts';
import type { AnchorRect } from './popover.ts';

/**
 * BOOK-111 (owner, 2026-10-27) — one panel at a time, page-wide.
 *
 * The page can hold one half-written surface and one read panel; a filing card, a word's
 * provenance panel and the revision object are the same slot, because they were never meant
 * to coexist. On touch an outside tap no longer closes anything, so the rule has to be
 * explicit rather than a side effect of the pointer: **opening one panel replaces the other**
 * (the `useSeam` and `useRevision` idiom), and the page, not each paragraph, owns which one is
 * open. Both directions are decided here and in `useRevision`, never in a call site.
 *
 * `owner` names the surface that opened the panel: every subscriber sees the store, and only
 * its owner draws it. Two paragraphs of one chapter cannot each hold a panel of their own.
 *
 * `fromSeam` says the panel was opened **from** the open strip. Then the strip is not a second
 * surface to close: it is the same place as the panel, collapses to one line while the panel
 * speaks for it, and gets its rows back when the panel closes. Any other origin (a mark, a
 * margin note, a phone row, the premise row) is a second place on screen, so the seam goes —
 * one floating frame, no inline duplicate.
 */

export type FilingKind = 'filing' | 'provenance';

export type OpenFiling = {
  kind: FilingKind;
  /** The surface that opened it (a block id, a chapter's premise): only this owner draws it. */
  owner: string;
  /** The filing on show; a provenance panel speaks of a word, and carries none. */
  comment: CommentDto | null;
  /** The element the tap came from, so focus can return there when the panel closes. */
  origin: HTMLElement | null;
  /**
   * The anchor the panel is placed against (the popover's own geometry). A landing computes
   * this rect **after** the scroll (`lib/place.ts`), so it is the four numbers the popover
   * reads and not a live `DOMRect`.
   */
  rect: AnchorRect;
  /** A provenance panel's word; the rest of its view is computed by the paragraph. */
  word?: string;
  /**
   * BOOK-168 — the card's honesty line when the landing fell back to the chapter because the
   * filing's paragraph is gone (`lib/place.ts`, `PLACE_NOTE`). Absent everywhere else.
   */
  note?: string | null;
  /**
   * The opener was inside `.seam` — computed by the caller from the element the tap landed in,
   * never guessed here: the store has no way to know what the DOM looks like.
   */
  fromSeam: boolean;
};

let current: OpenFiling | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Opening a panel replaces the open one; it never stacks a second — of either slot. */
export function showFiling(next: OpenFiling): void {
  // BOOK-111: the revision object is the other slot, always. The seam is only closed when the
  // panel came from somewhere else — a panel opened from the strip is that strip, collapsed.
  closeOverlay('revision');
  if (!next.fromSeam) closeOverlay('seam');
  current = next;
  emit();
}

export function hideFiling(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function currentFiling(): OpenFiling | null {
  return current;
}

export function useOpenFiling(): OpenFiling | null {
  return useSyncExternalStore(subscribe, currentFiling, () => null);
}

// BOOK-111: the seam and the record close this slot by asking it — never by importing it.
registerOverlay('filing', hideFiling);
