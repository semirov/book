import type { CommentDto } from '@book/shared';
import { useSyncExternalStore } from 'react';

import { closeOtherOverlays, registerOverlay } from './overlayRegistry.ts';

/**
 * BOOK-90 — the revision object is **chapter state**, not paragraph state.
 *
 * One object open on the page: a tap on another note, tick or strip row **moves** the object
 * to that record (the `useSeam` idiom). Two paragraphs of one chapter cannot each hold their
 * own object, and a remount of a paragraph does not leave an orphan behind.
 *
 * BOOK-111 (owner, 2026-10-27): the object is also the page's one overlay. Opening it closes
 * the seam and the panel — the record takes their place, so no inline surface is left standing
 * beside it with a ✕ of its own.
 */

export type OpenRevision = {
  comment: CommentDto;
  /** The element the tap came from, so focus can return there when the object closes. */
  origin: HTMLElement | null;
};

let current: OpenRevision | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function showRevision(next: OpenRevision): void {
  // BOOK-111 — the page's one overlay slot. The seam and the panel hand this module their own
  // closers (`overlayRegistry.ts`), so the rule lives in the stores and imports run one way.
  closeOtherOverlays('revision');
  current = next;
  emit();
}

export function hideRevision(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function currentRevision(): OpenRevision | null {
  return current;
}

export function useOpenRevision(): OpenRevision | null {
  return useSyncExternalStore(subscribe, currentRevision, () => null);
}

// BOOK-111: `openSeam` and `showFiling` close this slot by asking it — never by naming it.
registerOverlay('revision', hideRevision);
