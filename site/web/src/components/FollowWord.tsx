import { useSyncExternalStore } from 'react';

import type { CascadeWingsDto } from '@book/shared';

import {
  currentFollow,
  follow as recordFollow,
  followDirection,
  followLabel,
  subscribeFollow,
  unfollow,
} from '../lib/follow.ts';

/**
 * BOOK-207 — the one follow control: a word, a direction and a chapter, bound to one change.
 *
 * It is a `<button>` painted as text: no box, no background, an underline only while
 * unfollowed, `--ink-3` and no underline while following, a 44 px hit around a 24 px line, the
 * page's global focus ring. One tap unfollows; there is no dialog and no confirm.
 *
 * **The label freezes on the tap.** The unfollowed form is read from the ribbon every render
 * (`cascade:progress` may move it); once following, the store's recorded words are printed and
 * the ribbon is never read again, so a wave that rewrites a chapter or reverses a wing cannot
 * change the word under the reader's thumb.
 *
 * A change with no moving wing renders nothing at all: there is no direction to promise.
 */
export function FollowWord({
  changeId,
  wings,
}: {
  changeId: string;
  wings: CascadeWingsDto | null;
}) {
  const following = useSyncExternalStore(subscribeFollow, () => currentFollow(changeId), () => null);
  const direction = followDirection(changeId, wings);
  const label = followLabel(direction, following);
  if (label === null) return null;

  return (
    <button
      type="button"
      className="follow-word"
      data-follow={following === null ? undefined : 'on'}
      aria-pressed={following === null ? undefined : true}
      onClick={() => {
        if (following !== null) {
          unfollow(changeId);
          return;
        }
        if (direction !== null) recordFollow(direction, Date.now());
      }}
    >
      {label}
    </button>
  );
}
