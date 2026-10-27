import type { CommentDto } from '@book/shared';
import { useSyncExternalStore } from 'react';

import { hideRevision, onOpenRevision } from './useRevision.ts';

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
  /** The anchor the panel is placed against (the popover's own geometry). */
  rect: DOMRect;
  /** A provenance panel's word; the rest of its view is computed by the paragraph. */
  word?: string;
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
  // BOOK-111: the filing card and the revision object are one slot, and this store decides
  // it. The other direction — a record opened over a card — is this store's own closer, which
  // `showRevision` holds (registered below): no call site carries either rule.
  hideRevision();
  current = next;
  emit();
}

export function hideFiling(): void {
  if (current === null) return;
  current = null;
  emit();
}

// The revision store closes whatever this store opened, from the one direction imports run.
onOpenRevision(hideFiling);

export function currentFiling(): OpenFiling | null {
  return current;
}

export function useOpenFiling(): OpenFiling | null {
  return useSyncExternalStore(subscribe, currentFiling, () => null);
}
