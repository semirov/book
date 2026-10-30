/**
 * The ochre rule under a paragraph being rewritten (§11.4), read from the snapshot.
 *
 * BOOK-DOC-84 deleted the `block:revising` frame: it had no emitter and never would, because the
 * mark's own carrier is `state.revising` in the snapshot. What is left is this one projection —
 * the snapshot's entries as the slot's prop — so the page keeps exactly the list it always had
 * and the dead frame is gone from the switch.
 */

import type { BlockRevisingPayload, StateSnapshot } from '@book/shared';

export type RevisingState = Record<number, BlockRevisingPayload>;

export function revisingOf(marks: StateSnapshot['revising'] | undefined): RevisingState {
  const out: RevisingState = {};
  for (const mark of marks ?? []) {
    out[mark.chapter] = {
      n: mark.chapter,
      active: true,
      blockIds: mark.blockIds,
      cause: mark.cause,
      changeId: mark.changeId,
      // A mark in the snapshot is the live lease's own target; the lane is not part of the mark.
      lane: null,
      since: mark.since,
      expiresAt: mark.expiresAt,
    };
  }
  return out;
}
