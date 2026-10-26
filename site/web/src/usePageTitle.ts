import { useEffect } from 'react';

import { documentTitle } from './lib/pageTitle.ts';

/**
 * The tab names the book the way the cover does (BOOK-DOC-5 §2 as amended, 2026-10-26).
 * The value comes from the same front DTO the cover renders, so a `front:updated` rename
 * reaches the tab with no second string in the build.
 */
export function usePageTitle(frontTitle: string | null): void {
  useEffect(() => {
    document.title = documentTitle(frontTitle);
  }, [frontTitle]);
}
