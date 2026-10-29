import { useSyncExternalStore } from 'react';

/**
 * The word's facts, opened from the seam strip's own door.
 *
 * They are **a part of the strip**, never a surface: the strip draws `ProvenanceBlock` under
 * its row while `owner` matches the paragraph and the word. There is no close, no focus trap
 * and no registry slot here — `Escape` belongs to the strip (its own keydown), and the record
 * is not closed by opening the facts (the coupling to `overlayRegistry` is gone).
 */
export type OpenWord = {
  /** The paragraph that draws the body: only its own strip prints the facts. */
  owner: string;
  origin: HTMLElement | null;
  word: string;
};

let current: OpenWord | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function showWord(next: OpenWord): void {
  current = next;
  emit();
}

export function hideWord(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function currentWord(): OpenWord | null {
  return current;
}

export function useOpenWord(): OpenWord | null {
  return useSyncExternalStore(subscribe, currentWord, () => null);
}
