/**
 * The spine geometry (ARCHITECTURE.md §11.2, §11.3, §11.7; DESIGN §5.3, §7.2).
 *
 * The two-front shape of the book: a fill from each end, a hollow middle, a hairline at
 * 21|22 where the halves meet, and — only while a cascade runs — a faint band over the
 * chapters it touches. It is not a percentage of progress; the middle is the unfinished book.
 *
 * The ribbon itself was withdrawn from the front (BOOK-DOC-5 §5): no bar, no seam, no carets
 * at 0/42. What remains here is the geometry the chapter carets and the cascade band read.
 */

import { FORWARD_LAST, TOTAL_CHAPTERS, type Lane, type StateSnapshot } from '@book/shared';

export type SpineCascade = {
  from: number;
  to: number;
  step: number | null;
};

export type SpineMarkers = {
  /** Percent of the column filled from the left (1..F) and from the right (B..42). */
  forwardFill: number;
  backwardFill: number;
  /** The 21|22 seam, a hairline mark only. */
  seamPercent: number;
  empty: boolean;
  forward: number | null;
  backward: number | null;
  cascade: SpineCascade | null;
  /** The chapter whose end carries each lane's caret; `null` at 0/42 or before a draft. */
  carets: { forward: number | null; backward: number | null };
  /** A caret blinks only while its lane is writing; otherwise it rests. */
  live: { forward: boolean; backward: boolean };
};

function clampChapter(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isInteger(n)) return null;
  return Math.min(TOTAL_CHAPTERS, Math.max(1, n));
}

function laneCaret(state: StateSnapshot, lane: Lane): number | null {
  const current = state.current;
  // A cascade is not a drafting position: it moves rings, never a caret (§11.3).
  if (current !== null && current.kind === 'draft' && current.lane === lane && current.chapter !== 'front') {
    return current.chapter;
  }
  return clampChapter(state.cursors[lane]?.cursor);
}

function cascadeBand(state: StateSnapshot): SpineCascade | null {
  const cascade = state.cascade;
  if (cascade === null) return null;
  const step = cascade.stepChapter === 'front' ? null : clampChapter(cascade.stepChapter);
  const from = clampChapter(cascade.frontier.forward) ?? step;
  const to = clampChapter(cascade.frontier.backward) ?? step;
  if (from === null && to === null) return null;
  const left = Math.min(from ?? to ?? 1, to ?? from ?? 1);
  const right = Math.max(from ?? to ?? 1, to ?? from ?? 1);
  return { from: left, to: right, step };
}

export function spineMarkers(state: StateSnapshot): SpineMarkers {
  const forward = clampChapter(state.meeting.forwardFront);
  const backward = clampChapter(state.meeting.backwardFront);
  const current = state.current;
  return {
    forwardFill: forward === null ? 0 : (forward / TOTAL_CHAPTERS) * 100,
    backwardFill: backward === null ? 0 : ((TOTAL_CHAPTERS - backward + 1) / TOTAL_CHAPTERS) * 100,
    seamPercent: ((FORWARD_LAST + 0.5) / TOTAL_CHAPTERS) * 100,
    empty: state.chapters.count === 0,
    forward,
    backward,
    cascade: cascadeBand(state),
    carets: {
      forward: laneCaret(state, 'forward'),
      backward: laneCaret(state, 'backward'),
    },
    live: {
      forward: current !== null && current.lane === 'forward' && current.kind === 'draft',
      backward: current !== null && current.lane === 'backward' && current.kind === 'draft',
    },
  };
}

/** Percent position of a chapter's centre, for a caret or a cascade band. */
export function chapterPercent(n: number): number {
  return ((n - 0.5) / TOTAL_CHAPTERS) * 100;
}

/** A band spanning `from..to`, clamped to the column. */
export function bandStyle(cascade: SpineCascade): { left: string; width: string } {
  const left = chapterPercent(cascade.from);
  const right = chapterPercent(cascade.to);
  return { left: `${left}%`, width: `${Math.max(0.4, right - left)}%` };
}
