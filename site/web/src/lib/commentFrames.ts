import type { CommentAddedPayload, CommentDecisionPayload } from '@book/shared';

/**
 * BOOK-33 — which chapter a comment frame changes.
 *
 * Both frames carry a chapter now (`comment:added` and `comment:decision`), because a
 * decision moves a mark in the text and the page must refresh that chapter instead of
 * waiting for a reload. A frame without one is still valid input (an older server), and the
 * answer is `null`: the register refreshes, the marks do not guess.
 */
export function commentFrameChapter(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const chapter = (data as { chapter?: unknown }).chapter;
  return typeof chapter === 'number' && Number.isInteger(chapter) && chapter > 0 ? chapter : null;
}

/** A compile-time tie: both payload types must keep the field this helper reads. */
export type CommentFramesCarryChapter = [CommentAddedPayload['chapter'], CommentDecisionPayload['chapter']];
