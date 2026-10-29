/**
 * BOOK-DOC-84 §10.1 — `filing:reading`, the one frame per attempt of one filing's reading.
 *
 * The frame's `readingSeq` is `comment_events.id`: the reading domain's apply cursor. A frame at
 * or below the held cursor is a no-op, exactly like every other domain (§3.2), so a duplicate
 * delivery costs nothing and a replay of yesterday's failure is never narrated as today's.
 *
 * The payload and `live.reading` are one shape by design (the same builder serves both), so the
 * state keeps the live shape: the head, the record and the trail then read one field, whichever
 * carrier told them last. The handler lives here, and not in the dispatcher, because the switch
 * is at its line bound and this is a fold of its own.
 */

import type { FilingReadingPayload, LiveReading } from '@book/shared';

import type { ClientState, FrameResult } from './clientState.ts';

/** `filing:reading` → `state.reading`, with the reading domain's own cursor. */
export function withReading(state: ClientState, payload: FilingReadingPayload): FrameResult {
  if (payload.readingSeq <= state.cursors.reading) return { state, effects: [] };
  const reading: LiveReading = {
    commentId: payload.commentId,
    chapter: payload.chapter,
    phase: payload.phase,
    attempt: payload.attempt,
    maxAttempts: payload.maxAttempts,
    widened: payload.widened,
    desperate: payload.desperate,
    since: payload.at,
    deadlineAt: payload.deadlineAt,
    retryAt: payload.retryAt,
    reason: payload.reason,
  };
  return {
    state: {
      ...state,
      reading,
      cursors: { ...state.cursors, reading: payload.readingSeq },
    },
    effects: [],
  };
}
