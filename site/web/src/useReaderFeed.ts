import type { ChangeSummaryDto, CommentDto, MyDecisionsDto } from '@book/shared';
import { useCallback, useRef, useState } from 'react';

import { getChanges, getChapterComments, getComments, getMyDecisions } from './api.ts';
import { decisionFrameOf, upsertFiling, withDecisionReport } from './lib/filings.ts';
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
 *
 * BOOK-DOC-34 §6 — filings in the text are loaded **per chapter**, lazily, on the same
 * intersection trigger as the prose: the global list is only for the register, and a chapter
 * that was never on screen never costs a request. A frame for chapter N refreshes N only.
 */
export type ChapterFeed = {
  items: CommentDto[];
  /** The chapter was asked for and answered (or failed); the marks are settled either way. */
  loaded: boolean;
};

export function useReaderFeed() {
  const [changes, setChanges] = useState<ChangeSummaryDto[]>([]);
  const [comments, setComments] = useState<CommentDto[]>([]);
  /**
   * BOOK-128 #3900 §1 — the register may print a count only over a **complete** feed: the
   * endpoint has no total, so `nextBefore === null` is the one proof that the 20 loaded rows
   * are all of them. It starts false and stays false after a failed read (fail closed).
   */
  const [commentsComplete, setCommentsComplete] = useState(false);
  const [chapterFeed, setChapterFeed] = useState<Record<number, ChapterFeed>>({});
  const [decisions, setDecisions] = useState<MyDecisionsDto | null>(null);
  /**
   * BOOK-DOC-43 §4 — the register's wait (BOOK-66). The thread's two feeds are one surface:
   * `0 замечаний` before the answer is a claim of emptiness, and a failure is not a longer
   * wait. Set when both initial requests answered *or* failed; a later frame refreshes rows
   * and must not put the surface back into a waiting state.
   */
  const [threadSettled, setThreadSettled] = useState(false);
  /** The viewer's own comment ids: the key that turns a frame into «ваша правка». */
  const ownComments = useRef<Set<string>>(new Set());
  /** Which chapters were already requested once; a second scroll does not re-ask. */
  const asked = useRef<Set<number>>(new Set());

  const refreshChanges = useCallback(async () => {
    try {
      setChanges(await getChanges(6));
    } catch {
      /* the thread is a view, not the book: the next event retries */
    }
  }, []);

  /** One chapter's filings, after a frame that names it: the sentence may have moved. */
  const refreshChapter = useCallback(async (chapter: number) => {
    try {
      const page = await getChapterComments(chapter, 50);
      asked.current.add(chapter);
      setChapterFeed((current) => ({ ...current, [chapter]: { items: page.items, loaded: true } }));
    } catch {
      /* the next frame for this chapter retries */
    }
  }, []);

  /**
   * The public thread (§9) — and, when the frame names a chapter, that chapter's filings too:
   * the register and the marks are two views of the same fact, refreshed together.
   */
  const refreshComments = useCallback(async (chapter?: number) => {
    try {
      const page = await getComments({ limit: 20 });
      setComments(page.items);
      setCommentsComplete(page.nextBefore === null);
    } catch {
      /* the next comment event or reconnect retries — and an unread page may not be counted */
      setCommentsComplete(false);
    }
    if (chapter !== undefined) await refreshChapter(chapter);
  }, [refreshChapter]);

  /**
   * The thread's first read (BOOK-DOC-43 §4): the register waits until **both** feeds
   * answered or failed, and a failure settles too — the thread is a view and has no retry.
   * A later refresh (`refreshChanges`, `refreshComments`, a reconnect) never turns the wait
   * back on: content moving is not a surface opening.
   */
  const loadThread = useCallback(async () => {
    await Promise.allSettled([refreshChanges(), refreshComments()]);
    setThreadSettled(true);
  }, [refreshChanges, refreshComments]);

  const loadChapter = useCallback(async (chapter: number) => {
    if (asked.current.has(chapter)) return;
    asked.current.add(chapter);
    try {
      const page = await getChapterComments(chapter, 50);
      setChapterFeed((current) => ({ ...current, [chapter]: { items: page.items, loaded: true } }));
    } catch {
      // A failed read is not a permanent one: drop the marker so the next trigger retries.
      asked.current.delete(chapter);
    }
  }, []);

  /**
   * A reconnect can miss a decision frame, so the marks of every chapter already on screen
   * are re-read once (BOOK-33): the cached feed is a view, the endpoint is the truth.
   */
  const refreshLoaded = useCallback(async () => {
    const chapters = [...asked.current];
    await Promise.all(chapters.map((chapter) => refreshChapter(chapter)));
  }, [refreshChapter]);

  /**
   * BOOK-111 — the posted DTO enters the feed in the same frame, before any request settles.
   *
   * The answer is the row the reader just made: it is inserted (never appended twice) into the
   * thread's feed and into its chapter's, and the chapter is marked loaded — its marks are
   * now settled from this row. BOOK-158: a **revision** comes back under the id of the row it
   * revised, so the same acceptance replaces that row in place instead of being dropped as a
   * duplicate — the state line and the hint move with it, with no reload. A later
   * `refreshComments` is the durable truth and replaces the list wholesale, so a row that
   * survived here cannot appear twice.
   */
  const acceptComment = useCallback((comment: CommentDto) => {
    setComments((current) => upsertFiling(current, comment) ?? current);
    setChapterFeed((current) => {
      const feed = current[comment.chapter] ?? { items: [], loaded: true };
      const items = upsertFiling(feed.items, comment);
      if (items === null && feed.loaded) return current;
      return { ...current, [comment.chapter]: { items: items ?? feed.items, loaded: true } };
    });
  }, []);

  /**
   * BOOK-174 — a decision frame carries the reading of the filing it names. The row already on
   * screen takes it at once (the open card must not go on saying «ждёт»); a frame about a row
   * this page does not hold changes nothing, and `refreshComments` is still the durable truth.
   */
  const noteDecision = useCallback((data: unknown) => {
    const frame = decisionFrameOf(data);
    if (frame === null) return;
    setComments((current) => withDecisionReport(current, frame) ?? current);
    setChapterFeed((current) => {
      const chapter = frame.chapter;
      if (chapter === undefined) return current;
      const feed = current[chapter];
      if (feed === undefined) return current;
      const items = withDecisionReport(feed.items, frame);
      return items === null ? current : { ...current, [chapter]: { ...feed, items } };
    });
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

  return {
    changes,
    comments,
    commentsComplete,
    chapterFeed,
    decisions,
    threadSettled,
    loadThread,
    refreshChanges,
    refreshComments,
    acceptComment,
    loadChapter,
    refreshChapter,
    refreshLoaded,
    noteRecord,
    noteDecision,
  };
}
