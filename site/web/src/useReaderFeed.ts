import type { ChangeSummaryDto, CommentDto, MyDecisionsDto } from '@book/shared';
import { useCallback, useRef, useState } from 'react';

import { getChanges, getComments, getMyDecisions } from './api.ts';
import { ownCommentIds, readerRecordAction, type ReaderRecordEvent } from './lib/ownDecisions.ts';

/**
 * The reader's own record of decisions (BOOK-13), and the two feeds beside it.
 *
 * A decision about the viewer's own intervention arrives as a broadcast frame, and a frame
 * is not a record: it is gone the moment the page reloads. So the frame only **triggers** a
 * reload of the durable answer (`GET /api/me/decisions`), and only when it names one of the
 * viewer's own comments — the set comes from that own-only endpoint, never from a display
 * name. A foreign decision therefore cannot render as «ваша правка», even for two readers
 * with the same name.
 *
 * *Which* fact may reload the record is decided once, in `lib/ownDecisions.ts`
 * (`readerRecordAction`), not here: the hook only obeys it.
 *
 * The change and comment feeds live here too: three small views of the same page, each
 * refreshed by its own frame, none of them able to take the book down when it fails.
 */
export function useReaderFeed() {
  const [changes, setChanges] = useState<ChangeSummaryDto[]>([]);
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [decisions, setDecisions] = useState<MyDecisionsDto | null>(null);
  /** The viewer's own comment ids: the key that turns a frame into «ваша правка». */
  const ownComments = useRef<Set<string>>(new Set());

  const refreshChanges = useCallback(async () => {
    try {
      setChanges(await getChanges(6));
    } catch {
      /* the thread is a view, not the book: the next event retries */
    }
  }, []);

  /** The public thread (§9); a `comment:added`/`comment:decision` frame refreshes it. */
  const refreshComments = useCallback(async () => {
    try {
      setComments((await getComments({ limit: 20 })).items);
    } catch {
      /* the next comment event or reconnect retries */
    }
  }, []);

  const refreshDecisions = useCallback(async () => {
    try {
      const next = await getMyDecisions();
      ownComments.current = ownCommentIds(next);
      setDecisions(next);
    } catch {
      /* an anonymous reader, or a failed request: the next own frame retries */
    }
  }, []);

  const forgetDecisions = useCallback(() => {
    ownComments.current = new Set();
    setDecisions(null);
  }, []);

  /**
   * The one entry point for everything that may change the record: a reconnect, a fresh
   * post, a socket frame. The rule itself is pure and tested beside the copy.
   */
  const noteRecord = useCallback(
    (event: ReaderRecordEvent) => {
      const action = readerRecordAction(event, ownComments.current);
      if (action === 'refresh') void refreshDecisions();
      else if (action === 'drop') forgetDecisions();
    },
    [refreshDecisions, forgetDecisions],
  );

  return { changes, comments, decisions, refreshChanges, refreshComments, noteRecord };
}
