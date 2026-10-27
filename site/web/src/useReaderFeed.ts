import type { ChangeSummaryDto, CommentDto, MyDecisionsDto } from '@book/shared';
import { useCallback, useRef, useState } from 'react';

import { getChanges, getChapterComments, getComments, getMyDecisions } from './api.ts';
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
  const [chapterFeed, setChapterFeed] = useState<Record<number, ChapterFeed>>({});
  const [decisions, setDecisions] = useState<MyDecisionsDto | null>(null);
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
      setComments((await getComments({ limit: 20 })).items);
    } catch {
      /* the next comment event or reconnect retries */
    }
    if (chapter !== undefined) await refreshChapter(chapter);
  }, [refreshChapter]);

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
    chapterFeed,
    decisions,
    refreshChanges,
    refreshComments,
    loadChapter,
    refreshChapter,
    refreshLoaded,
    noteRecord,
  };
}
