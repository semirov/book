import { TOTAL_CHAPTERS } from '@book/shared';
import { useEffect, useRef } from 'react';

import { scrollToChapter } from '../dom.ts';
import { track } from './analytics.ts';
import { chapterFromHash } from './route.ts';

/**
 * BOOK-63 — `#ch-12` is the one chapter deep link, and it is the element id the chapter
 * already has. It is opened once, after the catalogue is known (a deep link into a slot that
 * is not on the page scrolls nowhere), and reported as `deep_link_open` with the chapter
 * number — never the address, never a sentence.
 *
 * The hook is separate from `App` because the page is at its line budget: the act is small,
 * the book is what the file is for.
 */
export function useDeepLink(ready: boolean): void {
  const opened = useRef(false);
  useEffect(() => {
    if (!ready || opened.current) return;
    const chapter = chapterFromHash(window.location.hash, TOTAL_CHAPTERS);
    if (chapter === null) return;
    opened.current = true;
    scrollToChapter(chapter);
    track('deep_link_open', { chapter });
  }, [ready]);
}
