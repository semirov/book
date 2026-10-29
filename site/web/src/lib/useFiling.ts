import type { CommentDto } from '@book/shared';
import { useSyncExternalStore } from 'react';

import { closeOverlay, registerOverlay } from './overlayRegistry.ts';

/**
 * The **one card** the page still has: a filing with no sentence to stand on.
 *
 * A premise lives on the chapter's own row (it has no paragraph), and a place door whose
 * anchor genuinely resolves to no sentence has nowhere to land. Both keep a card — the named
 * exception to the rule that a sentence's records are the record. Everything with a sentence
 * opens the record instead (`lib/record.ts`), so this store never competes with it: `showFiling`
 * **does not close the record** (BOOK-128's registry coupling is gone), and the record does not
 * close the card unless the card's own surface says so.
 *
 * `owner` names the surface that opened the card: every subscriber sees the store, and only its
 * owner draws it.
 */
export type OpenFiling = {
  /** The surface that opened it (a chapter's premise, a place link): only this owner draws it. */
  owner: string;
  comment: CommentDto;
  /** The element the tap came from, so focus can return there when the card closes. */
  origin: HTMLElement | null;
  /** BOOK-168 — the honesty line when the landing fell back to the chapter. */
  note?: string | null;
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

/** Opening a card replaces the open one; it never stacks a second. */
export function showFiling(next: OpenFiling): void {
  // The card is a place of its own: the inline strip goes, so the page keeps one close. It
  // never closes the record — the two stores meet only in `openRecord`'s direction.
  closeOverlay('seam');
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

registerOverlay('filing', hideFiling);
