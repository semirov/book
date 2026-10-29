import { useSyncExternalStore } from 'react';

import { currentNotice, dismissNotice, subscribeFollow } from '../lib/follow.ts';
import { keepPlace } from '../lib/keepPlace.ts';
import { chaptersCopy } from '../lib/ownDecisions.ts';

/**
 * BOOK-207 — the in-flow landing notice.
 *
 * One mono 12 line at the head of the chapter the reader is in, after `.ch-status` and above
 * the prose: `правка внесена · главы 12–21 · скрыть`. It is the only promise the follow
 * control makes, and it is a line in the book, never a ticket, a toast or a floating layer.
 *
 * One notice at a time (a second landing replaces the first), dismissed by `скрыть`. The
 * dismissal keeps the prose under the reader's eye (`keepPlace` on the chapter's first
 * paragraph) and hands focus to the chapter's own `<article tabindex="-1">`.
 */
export function FollowNotice({ chapter }: { chapter: number }) {
  const notice = useSyncExternalStore(subscribeFollow, currentNotice, () => null);
  if (notice === null || notice.chapter !== chapter) return null;

  const hide = (): void => {
    const host = document.getElementById(`ch-${chapter}`);
    const first = host?.querySelector<HTMLElement>('.p') ?? null;
    keepPlace(first, dismissNotice);
    host?.focus({ preventScroll: true });
  };

  return (
    <p className="ch-notice" role="status">
      <span>{notice.word}</span>
      {notice.chapters.length === 0 ? null : (
        <>
          {' · '}
          <span>{chaptersCopy(notice.chapters)}</span>
        </>
      )}
      {' · '}
      <button type="button" className="ch-notice-hide" onClick={hide}>
        скрыть
      </button>
    </p>
  );
}
