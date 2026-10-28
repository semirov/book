/**
 * `block:revising` — the ochre rule under a paragraph being rewritten. The frame carries its own
 * deadline: the page clears the mark when it expires, and a later mark for the same chapter
 * replaces it (the `since` stamp is what tells two marks apart). Extracted from the socket switch
 * so `App.tsx` stays a switch and not a catalogue of every frame's bookkeeping.
 */

import type { BlockRevisingPayload } from '@book/shared';

export type RevisingState = Record<number, BlockRevisingPayload>;

export function applyRevisingMark(
  mark: BlockRevisingPayload,
  setRevising: (update: (current: RevisingState) => RevisingState) => void,
  schedule: (run: () => void, ms: number) => void,
): void {
  const clear = (): void =>
    setRevising((current) => {
      if (current[mark.n]?.since !== mark.since) return current;
      const next = { ...current };
      delete next[mark.n];
      return next;
    });

  if (!mark.active) {
    clear();
    return;
  }
  setRevising((current) => ({ ...current, [mark.n]: mark }));
  const expiresIn = Math.max(0, Date.parse(mark.expiresAt) - Date.now());
  schedule(clear, Number.isNaN(expiresIn) ? 0 : expiresIn + 250);
}
