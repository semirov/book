import type { AuthorsCountDto, AuthorsDto, MyDecisionsDto, MyTraceDto } from '@book/shared';
import { useCallback, useEffect, useState } from 'react';

import { getAuthors, getMyTrace, postAuthorsHide } from '../api.ts';
import { usePending } from '../usePending.ts';
import { Authors } from './Authors.tsx';

/**
 * The end matter's data, loaded on its own (§6C.5).
 *
 * The shares are a *measurement*, not a live fact: they arrive from `/api/authors`, not from
 * the socket, and a failed request must not take the page down — the author and the
 * copyright are already known from the imprint, and only the numbers wait. Hiding from the
 * list re-measures, because a reader who changed the flag asks to see the list as it now is.
 *
 * The view switch at the top of the page is the only way into the chronicle; the end matter
 * carries no door of its own.
 *
 * A signed-in reader also sees their own trace (`/api/authors/me`, own only) and can hide
 * from the list and come back — hiding is not deletion, so the list re-measures afterwards
 * and the fresh byline count goes up to page 1 through `onAuthorsCount`.
 */
export function EndMatter({
  imprint,
  lastRevisionAt,
  signedIn,
  onAuthorsCount,
  decisions = null,
  live,
}: {
  imprint: { author: string; copyright: string };
  lastRevisionAt: string | null;
  signedIn: boolean;
  onAuthorsCount?: (count: AuthorsCountDto) => void;
  /** The signed-in reader's own decisions (BOOK-13); `null` for an anonymous visitor. */
  decisions?: MyDecisionsDto | null;
  /**
   * BOOK-56: `state.history.live`; the authors list and the person's trail are history. A
   * begun book has a chronicle with one record and no authors yet, so this block stays off
   * until a reader has changed the text.
   */
  live: boolean;
}) {
  const [authors, setAuthors] = useState<AuthorsDto | null>(null);
  /**
   * BOOK-DOC-43 §4 — the shares have a wait, and «—» must not stand for two different things
   * (BOOK-66). `authorsSettled` turns true when the request answered **or** failed, so the
   * surface leaves the waiting state on either outcome; `authorsFailed` keeps the failure
   * distinguishable from a measurement that came back empty. A later re-measure (hiding from
   * the list) refreshes the numbers without re-arming the wait.
   */
  const [authorsSettled, setAuthorsSettled] = useState(false);
  const [authorsFailed, setAuthorsFailed] = useState(false);
  const [ownTrace, setOwnTrace] = useState<MyTraceDto | null>(null);
  const [hidePending, setHidePending] = useState(false);

  const load = useCallback(
    async (fresh = false) => {
      // BOOK-56: with history off the list is not on the page, so nothing is asked for it.
      if (!live) return;
      try {
        setAuthors(await getAuthors({ fresh }));
        setAuthorsFailed(false);
      } catch {
        /* the end matter keeps the author and the copyright; the shares stay «—» */
        setAuthorsFailed(true);
      } finally {
        setAuthorsSettled(true);
      }
    },
    [live],
  );

  const loadOwnTrace = useCallback(async () => {
    if (!live || !signedIn) {
      setOwnTrace(null);
      return;
    }
    try {
      setOwnTrace(await getMyTrace());
    } catch {
      /* signed out between hello and this request: an anonymous reader sees nothing */
      setOwnTrace(null);
    }
  }, [live, signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadOwnTrace();
  }, [loadOwnTrace]);

  const toggleHidden = useCallback(
    async (hidden: boolean) => {
      setHidePending(true);
      try {
        const result = await postAuthorsHide(hidden);
        setOwnTrace((current) => (current === null ? current : { ...current, hidden: result.hidden }));
        onAuthorsCount?.(result.authors);
        // The list route answers `no-store` (BOOK-109); after a mutation read it past any copy
        // the browser still holds.
        await load(true);
      } catch {
        /* the flag did not change: the button stays as it was, nothing claims success */
      } finally {
        setHidePending(false);
      }
    },
    [load, onAuthorsCount],
  );

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
      ownTrace={ownTrace}
      decisions={decisions}
      hidePending={hidePending}
      onToggleHidden={(hidden) => void toggleHidden(hidden)}
      live={live}
    />
  );
}
