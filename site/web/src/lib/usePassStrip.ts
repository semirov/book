/**
 * The pass strip's one open slot (BOOK-167).
 *
 * IFACE — the strip's data lifecycle:
 *
 *   (a) states: `closed` (no slot), `open` on one chapter's block. The strip's own content is
 *       `live` or `ended`, but that is the model's word (`passRail.ts`), not the store's: the
 *       slot only says which block the reader is looking at.
 *   (b) on each: `open` is one place at a time — a second open moves the slot, and the strip
 *       fetches the pass's earlier stages once per open (`PassStrip.tsx`). Frames append to the
 *       page's log; `close` hides the strip and stops nothing: the pass runs in the engine and
 *       its frames keep arriving into `useStages`.
 *   (c) bounds: one target, no list, no timer, no polling. Opening the seam, a panel or the
 *       revision object closes the strip through `overlayRegistry.ts`, the same way they close
 *       each other (BOOK-111).
 *   (d) ownership: the slot holds a chapter and a block id; the log lives in `App`'s
 *       `useStages`, and the strip owns no growing store of its own.
 */

import { useSyncExternalStore } from 'react';

import { closeOtherOverlays, registerOverlay } from './overlayRegistry.ts';

export type PassStripTarget = {
  chapter: number;
  /** The block the door landed on: the strip sits right after that paragraph. */
  blockId: string;
};

let current: PassStripTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Open the strip on one block. The same target twice is not a second open (and no second read). */
export function openPassStrip(next: PassStripTarget): void {
  if (current !== null && current.chapter === next.chapter && current.blockId === next.blockId) return;
  current = { chapter: next.chapter, blockId: next.blockId };
  // One overlay at a time: the strip takes the seam's and the revision object's place.
  closeOtherOverlays('pass');
  emit();
}

/** Hide the strip. The pass itself is untouched — closing the window is not stopping the work. */
export function closePassStrip(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function currentPassStrip(): PassStripTarget | null {
  return current;
}

export function usePassStrip(): PassStripTarget | null {
  return useSyncExternalStore(subscribe, currentPassStrip, () => null);
}

// BOOK-111: the other stores close the strip by asking this one — never by naming it.
registerOverlay('pass', closePassStrip);
