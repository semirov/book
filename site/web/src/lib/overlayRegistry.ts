/**
 * BOOK-111 (owner, 2026-10-27) — one overlay at a time, and who is allowed to close whom.
 *
 * The page holds three overlays: the seam's strip, the panel (a filing card or a word's DNA)
 * and the revision object. Each one is a store, and each store needs to close the others when
 * it opens — but `useFiling` closing the seam would be `useFiling` → `useSeam` → `useFiling`,
 * a cycle the bundler resolves by accident and nobody wants to reason about.
 *
 * So the rule lives here and imports nothing local: a store hands in its own closer when its
 * module loads, and the stores ask this module to close the slots they replace. A store that
 * was never loaded owns nothing and closes nothing, which is exactly right — nothing of it can
 * be on the page either.
 */

export type OverlayName = 'seam' | 'filing' | 'revision';

const closers = new Map<OverlayName, () => void>();

/** A store registers its own closer once, at module load; a later registration replaces it. */
export function registerOverlay(name: OverlayName, close: () => void): void {
  closers.set(name, close);
}

/** Close one overlay. Idempotent: each store's closer is a no-op when it holds nothing. */
export function closeOverlay(name: OverlayName): void {
  closers.get(name)?.();
}

/**
 * Close every overlay but `keep` (or all of them, with `null`). The order is registration
 * order, so the seam — the store every other store is opened over — is closed first.
 */
export function closeOtherOverlays(keep: OverlayName | null): void {
  for (const [name, close] of closers) {
    if (name !== keep) close();
  }
}
