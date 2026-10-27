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
 * copyright are already known from the imprint, and only the numbers wait. Opening the
 * chronicle re-measures, because that is the moment a reader asks «как менялись доли».
 *
 * A signed-in reader also sees their own trace (`/api/authors/me`, own only) and can hide
 * from the list and come back — hiding is not deletion, so the list re-measures afterwards
 * and the fresh byline count goes up to page 1 through `onAuthorsCount`.
 */
export function EndMatter({
  imprint,
  lastRevisionAt,
  signedIn,
  onOpenChronicle,
  onAuthorsCount,
  decisions = null,
}: {
  imprint: { author: string; copyright: string };
  lastRevisionAt: string | null;
  signedIn: boolean;
  onOpenChronicle: () => void;
  onAuthorsCount?: (count: AuthorsCountDto) => void;
  /** The signed-in reader's own decisions (BOOK-13); `null` for an anonymous visitor. */
  decisions?: MyDecisionsDto | null;
}) {
  const [authors, setAuthors] = useState<AuthorsDto | null>(null);
  /**
   * BOOK-DOC-43 §4 — the shares have a wait, and «—» must not stand for two different things
   * (BOOK-66). `authorsSettled` turns true when the request answered **or** failed, so the
   * surface leaves the waiting state on either outcome; `authorsFailed` keeps the failure
   * distinguishable from a measurement that came back empty. A later re-measure (opening the
   * chronicle, hiding from the list) refreshes the numbers without re-arming the wait.
   */
  const [authorsSettled, setAuthorsSettled] = useState(false);
  const [authorsFailed, setAuthorsFailed] = useState(false);
  const [ownTrace, setOwnTrace] = useState<MyTraceDto | null>(null);
  const [hidePending, setHidePending] = useState(false);

  const load = useCallback(async (fresh = false) => {
    try {
      setAuthors(await getAuthors({ fresh }));
      setAuthorsFailed(false);
    } catch {
      /* the end matter keeps the author and the copyright; the shares stay «—» */
      setAuthorsFailed(true);
    } finally {
      setAuthorsSettled(true);
    }
  }, []);

  const loadOwnTrace = useCallback(async () => {
    if (!signedIn) {
      setOwnTrace(null);
      return;
    }
    try {
      setOwnTrace(await getMyTrace());
    } catch {
      /* signed out between hello and this request: an anonymous reader sees nothing */
      setOwnTrace(null);
    }
  }, [signedIn]);

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
        // The list route is cached `max-age=30`; after a mutation read it past the cache.
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
      onOpenChronicle={() => {
        void load();
        onOpenChronicle();
      }}
      ownTrace={ownTrace}
      decisions={decisions}
      hidePending={hidePending}
      onToggleHidden={(hidden) => void toggleHidden(hidden)}
    />
  );
}
