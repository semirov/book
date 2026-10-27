import { useSyncExternalStore } from 'react';

import { track, type SeamSurface } from './analytics.ts';
import { closeOtherOverlays, registerOverlay } from './overlayRegistry.ts';
import type { SeamAnchor } from './seam.ts';

/**
 * BOOK-DOC-34 §2.1 — one seam per page.
 *
 * The open seam is page state, not chapter state: tapping another sentence **moves** the
 * seam, and two chapters can never show a strip at once. It is kept in a tiny external store
 * so the paragraph, the strip and the panels read the same value without threading props
 * through the chapter list (§7: the strip sits between the two fragments of one paragraph).
 */

export type OpenSeam = {
  chapter: number;
  /** A premise has no block: the seam sits in the empty slot, not in a sentence. */
  blockId: string | null;
  /** The draft key: chapter + block + sentence range, or the chapter for a premise. */
  key: string;
  anchor: SeamAnchor | null;
  /** The element the tap landed in, so focus can return there when the strip closes. */
  origin: HTMLElement | null;
  /**
   * BOOK-63 — where the reader opened it. Rarely needed: the store names the surface itself
   * (a seam with no block is an empty chapter's premise, everything else is the text); a
   * future opening from the table of contents passes `toc`.
   */
  surface?: SeamSurface;
};

let current: OpenSeam | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openSeam(next: OpenSeam): void {
  current = next;
  // BOOK-111 (owner, 2026-10-27): one overlay at a time. A seam is the reader's own act, so
  // opening it closes the page's panel and the revision object — two half-written surfaces
  // never coexist, and the strip is never opened behind a figure the reader cannot see. The
  // closers are registered by their own stores (`overlayRegistry.ts`), so this module names
  // neither of them.
  closeOtherOverlays('seam');
  // The event belongs to the act, so the store emits it: no caller can open a seam silently.
  // A seam with no block is an empty chapter's premise; everything else opens in the text.
  track('seam_open', { surface: next.surface ?? (next.blockId === null ? 'premise' : 'text') });
  emit();
}

/** Closing is instant and never animates; a draft, if any, stays in its own store. */
export function closeSeam(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function currentSeam(): OpenSeam | null {
  return current;
}

export function useOpenSeam(): OpenSeam | null {
  return useSyncExternalStore(subscribe, currentSeam, () => null);
}

// BOOK-111: the other stores close the seam by asking this one — never by naming it.
registerOverlay('seam', closeSeam);
