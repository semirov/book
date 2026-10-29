import type { AuthorsDto } from '@book/shared';
import { useCallback, useEffect, useState } from 'react';

import { getAuthors } from '../api.ts';
import { usePending } from '../usePending.ts';
import { Authors } from './Authors.tsx';

/**
 * The end matter's data, loaded on its own (§6C.5).
 *
 * The shares are a *measurement*, not a live fact: they arrive from `/api/authors`, not from
 * the socket, and a failed request must not take the page down — the author and the
 * copyright are already known from the imprint, and only the numbers wait.
 *
 * The view switch at the top of the page is the only way into the chronicle; the end matter
 * carries no door of its own.
 *
 * BOOK-207 — the reader's own trace and filings left this block for their own page (`#след`);
 * the block keeps one row, «ваш след →», and no own-only request is made here.
 */
export function EndMatter({
  imprint,
  lastRevisionAt,
  live,
  exportBytes = null,
}: {
  imprint: { author: string; copyright: string };
  lastRevisionAt: string | null;
  /**
   * BOOK-56: `state.history.live`; the authors list is history. A begun book has a chronicle
   * with one record and no authors yet, so this block stays off until a reader changed the text.
   */
  live: boolean;
  /** BOOK-138: the size of the export, printed beside the download link. */
  exportBytes?: number | null;
}) {
  const [authors, setAuthors] = useState<AuthorsDto | null>(null);
  /**
   * BOOK-DOC-43 §4 — the shares have a wait, and «—» must not stand for two different things
   * (BOOK-66). `authorsSettled` turns true when the request answered **or** failed, so the
   * surface leaves the waiting state on either outcome; `authorsFailed` keeps the failure
   * distinguishable from a measurement that came back empty.
   */
  const [authorsSettled, setAuthorsSettled] = useState(false);
  const [authorsFailed, setAuthorsFailed] = useState(false);

  const load = useCallback(async () => {
    // BOOK-56: with history off the list is not on the page, so nothing is asked for it.
    if (!live) return;
    try {
      setAuthors(await getAuthors());
      setAuthorsFailed(false);
    } catch {
      /* the end matter keeps the author and the copyright; the shares stay «—» */
      setAuthorsFailed(true);
    } finally {
      setAuthorsSettled(true);
    }
  }, [live]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * §4: the wait is real from the request until it settles, data or failure. §7: `busy` is
   * the same flag — true for the whole request, not from the 150 ms threshold.
   */
  const stage = usePending(!authorsSettled);

  return (
    <Authors
      authors={authors}
      stage={stage}
      busy={!authorsSettled}
      authorsFailed={authorsFailed}
      imprint={imprint}
      lastRevisionAt={lastRevisionAt}
      live={live}
      exportBytes={exportBytes}
    />
  );
}
