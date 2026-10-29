import { TOTAL_CHAPTERS } from '@book/shared';
import { useEffect, useRef } from 'react';

import { track } from './analytics.ts';
import { requestChange } from './changeDoor.ts';
import { passHashOf } from './passHash.ts';
import { landFragment } from './place.ts';
import { chapterLinkFromHash } from './route.ts';

/**
 * BOOK-63 — `#ch-12` is the one chapter deep link, and it is the element id the chapter
 * already has. It is opened once, after the catalogue is known (a deep link into a slot that
 * is not on the page scrolls nowhere), and reported as `deep_link_open` with the chapter
 * number — never the address, never a sentence.
 *
 * BOOK-168 — the same fragment may name a paragraph (`#ch-3-b12`, the href a place door
 * carries) and the address bar may change while the page is open: a pasted link, a door's
 * copy, the browser's own "open in this tab", and a back/forward (`hashchange`, `popstate`).
 * All of them land with the page's one measurement (`landFragment`): the paragraph once its
 * chapter has been read — the landing jumps to the chapter first, which is what starts the
 * read — the chapter's mouth when it never arrives, and nothing at all for a chapter that is
 * not on this page. A hash that has already been acted on is not acted on twice.
 *
 * The hook is separate from `App` because the page is at its line budget: the act is small,
 * the book is what the file is for.
 */
export function useDeepLink(ready: boolean): void {
  /** The last fragment this page acted on: one landing per hash, and a new one on a change. */
  const landed = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const open = (): void => {
      const hash = window.location.hash;
      if (hash === landed.current) return;
      const link = chapterLinkFromHash(hash, TOTAL_CHAPTERS);
      if (link === null) {
        // An old `#проход-…` address: a change opens the record's `правка` section at its
        // sentence, a bare pass lands on the chapter it wrote. There is no page either way.
        const pass = passHashOf(hash);
        if (pass === null) return;
        if (pass.kind === 'change') {
          // No opener yet (the app is still booting): the hash stays unclaimed for a later ready.
          if (requestChange(pass.changeId)) landed.current = hash;
          return;
        }
        landed.current = hash;
        void landFragment({ fragment: { chapter: pass.chapter, blockIndex: null } }).then((landedHere) => {
          if (landedHere) track('deep_link_open', { chapter: pass.chapter });
        });
        return;
      }
      landed.current = hash;
      // The prose may still be on its way: the fragment is landed once the chapter is read,
      // and a link that moved nothing is not reported as an open (a silent no-op is not a fact).
      void landFragment({ fragment: link }).then((landedHere) => {
        if (landedHere) track('deep_link_open', { chapter: link.chapter });
      });
    };
    open();
    window.addEventListener('hashchange', open);
    window.addEventListener('popstate', open);
    return () => {
      window.removeEventListener('hashchange', open);
      window.removeEventListener('popstate', open);
    };
  }, [ready]);
}
