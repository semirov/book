import { useEffect } from 'react';

import { applyDocumentTitle } from './lib/pageTitle.ts';

/**
 * The tab names the book the way the cover does (BOOK-DOC-5 §2 as amended, 2026-10-26).
 * `undefined` means the state has not arrived (the shell's title stands), `null` means the
 * first sheet has no title line — see `applyDocumentTitle`.
 */
export function usePageTitle(frontTitle: string | null | undefined): void {
  useEffect(() => {
    applyDocumentTitle(frontTitle, document);
  }, [frontTitle]);
}
