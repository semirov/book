import { useSyncExternalStore } from 'react';

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
