/**
 * The title-change animation (ARCHITECTURE.md §6C.2, §11.8; DESIGN §5.2, §8.4).
 *
 * A ripple that reaches chapter 1 rewrites the first sheet, and the cover, the TOC heading
 * and page 2 cross-fade. That much exists since M2. M4 adds the distinction the SPEC makes:
 * when the change came from a **cascade** (the ripple reached the beginning), the title
 * gets the ring gesture — 400 ms, once, no reflow; a title edited by hand merely fades.
 * `prefers-reduced-motion` is honoured in CSS, so the reducer never needs to know.
 *
 * A token, not a timestamp, re-triggers the animation: React keys on it.
 */

import type { FrontUpdatedPayload } from '@book/shared';

export type TitleMotion = {
  /** Monotonic; used as a React key so the same class replays. */
  token: number;
  mode: 'ripple' | 'fade' | 'none';
};

export const IDLE_TITLE: TitleMotion = { token: 0, mode: 'none' };

export function nextTitleMotion(previous: TitleMotion, event: FrontUpdatedPayload | null): TitleMotion {
  if (event === null) return previous;
  // A front revision is a title revision (BOOK-DOC-6): page 2 never moves, so any event animates.
  return {
    token: previous.token + 1,
    mode: event.cause.kind === 'cascade' ? 'ripple' : 'fade',
  };
}

/** The class the cover and the TOC heading carry; `none` keeps the plain sheet. */
export function titleMotionClass(motion: TitleMotion): string {
  if (motion.mode === 'ripple') return 'title-ripple';
  if (motion.mode === 'fade') return 'title-fade';
  return '';
}
