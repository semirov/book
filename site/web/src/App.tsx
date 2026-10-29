import type {
  AuthorsCountDto,
  BlockRevisingPayload,
  CascadeProgressPayload,
  ChangeDecidedPayload,
  ChangeProcessingPayload,
  ChapterCreatedPayload,
  ChapterRevisionPayload,
  CommentDto,
  Envelope,
  FrontUpdatedPayload,
  HelloPayload,
  HistoryEventFrame,
  ServerEventType,
  StateUpdatedPayload,
  ViewerDto,
} from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getChapters, getFront, getState } from './api.ts';
import { chapterInViewport, elementInViewport } from './dom.ts';
import { EndMatter } from './components/EndMatter.tsx';
import { BootWait } from './components/BootWait.tsx';
import { AgeGate } from './components/AgeGate.tsx';
import { CapacityPlate } from './components/CapacityPlate.tsx';
import { ConsentBanner } from './components/ConsentBanner.tsx';
import type { BookView } from './components/ViewSwitch.tsx';
import { ChapterList } from './components/ChapterList.tsx';
import { FootJumps } from './components/FootJumps.tsx';
import { Colophon } from './components/Colophon.tsx';
import { Discussion } from './components/Discussion.tsx';
import { NoticeTicket, type Notice } from './components/Notice.tsx';
import { Opening } from './components/Opening.tsx';
import { RecordMode, recordModeOf } from './components/RecordMode.tsx';
import { TableOfContents } from './components/TableOfContents.tsx';
import { EMPTY_COMPOSER } from './lib/composer.ts';
import { historyLive, historyStarted } from './lib/historyState.ts';
import { applyRevisingMark } from './lib/revisingMark.ts';
import { useAgeGate } from './lib/useAgeGate.ts';
import { useStages } from './lib/useStages.ts';
import {
  bookFromHello,
  catalogOutOfSync,
  withChapterCreated,
  withChapterRevision,
  withAuthorsCount,
  withFront,
  withFreshFront,
  withRevision,
  withState,
  type BookData,
} from './lib/bookState.ts';
import { escalationMarkers, reduceRibbon, ribbonAfterSnapshot, ribbonFromState, type Ribbon } from './lib/cascade.ts';
import { spineMarkers } from './lib/spine.ts';
import { IDLE_TITLE, nextTitleMotion, type TitleMotion } from './lib/titleChange.ts';
import { BookSocket, websocketUrl, type SocketStatus } from './lib/ws.ts';
import { commentFrameChapter } from './lib/commentFrames.ts';
import { decisionFrameHandler } from './lib/decisionFrame.ts';
import { liveFeedHandler } from './lib/liveFeed.ts';
import { useReaderFeed } from './useReaderFeed.ts';
import { useReviseTick } from './lib/useReviseTick.ts';
import { usePageTitle } from './usePageTitle.ts';
import { usePending } from './usePending.ts';
import { useParagraphChain } from './useParagraphChain.ts';
import { usePosition, jumpToChapter } from './lib/usePosition.ts';
import { setChangeOpener } from './lib/changeDoor.ts';
import { useChangeDoor } from './useChangeDoor.ts';
import { useQueuePoll } from './useQueuePoll.ts';
import { useReading } from './lib/pageTrack.ts';
import { useTrail } from './lib/useTrail.ts';
import { landFrame } from './lib/follow.ts';
import { useFrontRevision } from './useFrontRevision.ts';

/** No chapter slots on this mode: a stable identity, so the reading hook re-runs on return. */
const NO_CHAPTERS: ReadonlyArray<{ n: number; chars: number }> = [];

/**
 * One page, the book in order (ARCHITECTURE §11.2; BOOK-DOC-5 §5): cover → page 2 → live TOC →
 * 42 chapter slots → discussion → colophon. The chronicle and a pass's record are modes of the
 * same page, chosen by the hash. Every slot exists from the first paint; prose is fetched when
 * a chapter comes within 1.5 viewports. Frames merge by `rev`; a reconnect heals by `hello`.
 */
export function App() {
  const [data, setData] = useState<BookData | null>(null);
  const [failed, setFailed] = useState(false);
  const [connection, setConnection] = useState<SocketStatus>('connecting');
  const [revisions, setRevisions] = useState<Record<number, ChapterRevisionPayload>>({});
  const [revising, setRevising] = useState<Record<number, BlockRevisingPayload>>({});
  /** BOOK-167: the stage log — the passes in flight, and the paragraph they paint. */
  const stages = useStages();
  const [fresh, setFresh] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ribbon, setRibbon] = useState<Ribbon | null>(null);
  const [viewer, setViewer] = useState<ViewerDto>({ signedIn: false, displayName: null });
  const [composer, setComposer] = useState(EMPTY_COMPOSER);
  const [titleMotion, setTitleMotion] = useState<TitleMotion>(IDLE_TITLE);
  /** «книга · хроника»: one page, two ways of reading it (§11.10). */
  const [view, setView] = useState<BookView>('book');
  const [historyTick, setHistoryTick] = useState(0);
  /**
   * BOOK-225 — the reader's answer, read from the device before the first request: `null` means
   * the gate stands in place of the chapters and nothing below it is mounted.
   */
  const age = useAgeGate();
  /**
   * BOOK-128 comment #3815 — the phrase's facts are the paragraph's own margin item now, so the
   * page hands the whole mode down to the article instead of drawing a floating box at its root.
   */
  const sentence = useParagraphChain();
  const trail = useTrail();
  // BOOK-104 / BOOK-207 — the page's one reading model; a mode without chapter slots hands
  // the hook a stable empty list, so leaving it re-measures the book.
  const readingCatalog = trail || view !== 'book' || data === null ? NO_CHAPTERS : data.catalog;
  const reading = useReading(readingCatalog);
  const readingRef = useRef(reading);
  readingRef.current = reading;
  usePageTitle(data === null ? undefined : data.front.title);
  const socketRef = useRef<BookSocket | null>(null);
  const helloSeen = useRef(false);
  const timers = useRef<number[]>([]);
  const dataRef = useRef<BookData | null>(null);
  /**
   * The thread, the summary of decisions and the record behind it (BOOK-13): the frame is
   * only the trigger, the own-only endpoint is the durable line the page reloads into.
   */
  const { changes, comments, commentsComplete, commentsFailed, chapterFeed, threadSettled, loadThread, refreshChanges, refreshComments, acceptComment, loadChapter, refreshLoaded, noteRecord, noteDecision } =
    useReaderFeed();
  // BOOK-158: the frozen `revise` is re-read from this one clock (countdown + chapter refresh).
  const nowMs = useReviseTick(comments, chapterFeed, refreshComments);
  /** §4 — the thread waits until both feeds settle; a later frame never re-arms it. */
  const stage = usePending(!threadSettled);
  /**
   * The one door to a change: it lands on the change's sentence and opens the record there with
   * the `правка` section expanded. A change never gets a surface of its own again.
   */
  const changeDoor = useChangeDoor({ ready: data !== null && view === 'book' && age.acknowledged, loadChapter });
  const openChange = useCallback(
    (changeId: string) => {
      setView('book');
      changeDoor.open(changeId);
    },
    [changeDoor.open],
  );
  useEffect(() => {
    setChangeOpener(openChange);
    return () => setChangeOpener(null);
  }, [openChange]);

  /**
   * REST fallback and resync. The initial call must not overwrite a `hello` that already
   * arrived; a resync after a `seq` gap must. BOOK-138: its size travels with its revision.
   */
  const refreshAll = useCallback(async (force = false) => {
    try {
      const [state, catalog, front] = await Promise.all([getState(), getChapters(), getFront()]);
      setData((current) => (helloSeen.current && current !== null && !force ? withRevision(current, front.revision, front.exportBytes) : withFreshFront({ state, catalog, front }, current)));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    try {
      const catalog = await getChapters();
      setData((current) => (current === null ? current : { ...current, catalog }));
    } catch {
      /* the next state:updated or reconnect will retry */
    }
  }, []);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  // BOOK-225 — the deep link lands only once the chapters exist: a `#ch-12` on a gated page has
  // nowhere to land, and `useDeepLink` remembers what it acted on, so acting too early would
  // consume the link and never re-land it after the answer.
  usePosition(data !== null && age.acknowledged, viewer.signedIn);
  const applyAuthorsCount = useCallback((count: AuthorsCountDto) => {
    setData((current) => (current === null ? current : withAuthorsCount(current, count)));
  }, []);
  const noteRevision = useFrontRevision(setData);
  useEffect(() => {
    void refreshAll(false);
    void loadThread();
  }, [refreshAll, loadThread]);

  // `/api/queue` is polled only while the engine is alive (§9); the socket carries the rest.
  useQueuePoll(dataRef, setData);

  useEffect(() => {
    const onDecision = decisionFrameHandler({ noteRecord, noteDecision, refreshComments, refreshCatalog, noteRevision });
    // BOOK-206 audit B1 — the frames that move a live record without a decision of their own
    // (the writer claiming a change, a change closing, a pass landing): `lib/liveFeed.ts`.
    const onFeed = liveFeedHandler({ refreshComments, refreshCatalog, noteRevision, noteStage: stages.note });
    const socket = new BookSocket(websocketUrl(window.location.origin), {
      onEvent: (event: Envelope) => {
        const frame = event as Envelope<ServerEventType, unknown>;
        onFeed(frame);
        switch (frame.type) {
          case 'hello': {
            const hello = frame.data as HelloPayload;
            helloSeen.current = true;
            setData((current) => bookFromHello(hello, current));
            setViewer(hello.viewer);
            setComposer(hello.composer);
            setRibbon(ribbonFromState(hello.state));
            setNotice(null);
            setRevisions({});
            setRevising({});
            stages.reset();
            setFresh(null);
            setFailed(false);
            noteRecord({ kind: 'hello', signedIn: hello.viewer.signedIn });
            void refreshChanges();
            void refreshLoaded();
            void refreshComments();
            break;
          }
          case 'state:snapshot': {
            const payload = frame.data as { state: StateUpdatedPayload };
            setData((current) => {
              if (current === null) return current;
              const next = withState(current, payload.state);
              if (catalogOutOfSync(next.state, next.catalog)) void refreshCatalog();
              return next;
            });
            setRibbon((held) => ribbonAfterSnapshot(held, payload.state));
            break;
          }
          case 'state:updated': {
            const snapshot = frame.data as StateUpdatedPayload;
            setData((current) => {
              if (current === null) return current;
              const next = withState(current, snapshot);
              if (catalogOutOfSync(next.state, next.catalog)) void refreshCatalog();
              return next;
            });
            setRibbon((held) => ribbonAfterSnapshot(held, snapshot));
            break;
          }
          case 'chapter:created': {
            const created = frame.data as ChapterCreatedPayload;
            setData((current) => (current === null ? current : withChapterCreated(current, created)));
            setFresh(created.n);
            const timer = window.setTimeout(() => setFresh((n) => (n === created.n ? null : n)), 10_000);
            timers.current.push(timer);
            if (!chapterInViewport(created.n)) setNotice({ kind: 'new', n: created.n });
            break;
          }
          case 'chapter:revision': {
            const revision = frame.data as ChapterRevisionPayload;
            setData((current) => (current === null ? current : withChapterRevision(current, revision)));
            setRevisions((current) => ({ ...current, [revision.n]: revision }));
            if (!chapterInViewport(revision.n)) setNotice({ kind: 'revised', n: revision.n });
            break;
          }
          case 'front:updated': {
            const front = frame.data as FrontUpdatedPayload;
            setData((current) => (current === null ? current : withFront(current, front)));
            setTitleMotion((current) => nextTitleMotion(current, front));
            // §11.2: the ticket is for a reader who is below the TOC, not for one watching it.
            if (!elementInViewport('toc')) setNotice({ kind: 'front' });
            break;
          }
          case 'authors:update': applyAuthorsCount(frame.data as AuthorsCountDto); break;
          case 'cursor:moved': {
            const cursor = frame.data as {
              lane: 'forward' | 'backward';
              chapter: number;
              blockId: string | null;
              blockIndex: number | null;
              at: string;
            };
            setData((current) => {
              if (current === null) return current;
              return {
                ...current,
                state: {
                  ...current.state,
                  current: {
                    lane: cursor.lane,
                    chapter: cursor.chapter,
                    kind: 'draft',
                    blockId: cursor.blockId,
                    blockIndex: cursor.blockIndex,
                    since: cursor.at,
                  },
                },
              };
            });
            break;
          }
          case 'block:revising':
            applyRevisingMark(frame.data as BlockRevisingPayload, setRevising, (run, ms) => {
              timers.current.push(window.setTimeout(run, ms));
            });
            break;
          case 'history:event': {
            // BOOK-102: the frame is a bare tick, `{ hseq, at }` — no narration. The page says
            // «the log moved» and re-reads the record it prints.
            const tick = frame.data as HistoryEventFrame;
            if (tick.hseq > 0) setHistoryTick((current) => current + 1);
            break;
          }
          case 'comment:added':
          case 'feedback:batch': {
            void refreshComments(commentFrameChapter(frame.data) ?? undefined);
            break;
          }
          case 'comment:decision':
            // BOOK-174/BOOK-219: the record, the reading and — for a landing — the text, in one
            // breath; the rule itself lives in `lib/decisionFrame.ts`.
            onDecision(frame);
            break;
          case 'change:queued': {
            void refreshChanges();
            // BOOK-65: a comment accepted through the interface appends `change.queued`, so
            // this frame — not `history:event` — is the first notice the reader's own line
            // exists. The tick re-reads the record; the frame payload is untouched.
            setHistoryTick((current) => current + 1);
            break;
          }
          case 'change:processing': {
            const processing = frame.data as ChangeProcessingPayload;
            setRibbon((current) => reduceRibbon(current, { type: frame.type, data: processing }));
            void refreshChanges();
            break;
          }
          case 'change:stale':
            void refreshChanges();
            break;
          case 'cascade:progress': {
            const progress = frame.data as CascadeProgressPayload;
            setRibbon((current) => reduceRibbon(current, { type: frame.type, data: progress }));
            break;
          }
          case 'change:decided': {
            const decided = frame.data as ChangeDecidedPayload;
            noteRecord({ kind: 'frame', type: frame.type, data: decided });
            setRibbon((current) => reduceRibbon(current, { type: frame.type, data: decided }));
            // BOOK-207 — a followed change lands: one notice, at the chapter the reader is in.
            landFrame(decided, readingRef.current.n);
            void refreshChanges();
            break;
          }
          default:
            break;
        }
        if (frame.type === 'chapter:created' || frame.type === 'chapter:revision' || frame.type === 'front:updated') noteRevision();
      },
      onStatus: (status) => setConnection(status),
      onGap: () => void refreshAll(true),
    });
    socket.connect();
    socketRef.current = socket;
    const ping = window.setInterval(() => socket.sendPing(), 25_000);
    return () => {
      window.clearInterval(ping);
      socket.close();
      socketRef.current = null;
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current = [];
    };
  }, [refreshAll, refreshCatalog, refreshChanges, refreshComments, refreshLoaded, noteRecord, applyAuthorsCount, noteRevision]);

  if (failed && data === null) {
    return (
      <main className="page">
        <div className="state-line">
          <span>опись не прочиталась</span>
          <button type="button" onClick={() => void refreshAll()}>повторить</button>
        </div>
      </main>
    );
  }

  if (data === null) {
    // The failing branch returned above, so this is the wait and nothing else — no `failed`.
    return <main className="page boot-wait" aria-busy="true"><BootWait active /></main>;
  }

  const { state, catalog, front } = data;
  /** BOOK-56: the one fact every history surface reads. */
  const history = historyLive(state);
  /** BOOK-56: the book has begun, so the chronicle exists from its first record. */
  const chronicle = historyStarted(state);
  const markers = spineMarkers(state);
  const currentChapter = state.current !== null && state.current.chapter !== 'front' ? state.current.chapter : null;

  const go = (target: Notice): void => {
    setNotice(null);
    if (target.kind === 'front') {
      // A notice is a landing too: the contents come to the reading line in one jump.
      document.getElementById('toc')?.scrollIntoView({ behavior: 'auto', block: 'start' });
      return;
    }
    jumpToChapter(target.n);
  };
  /**
   * A filing was posted (BOOK-DOC-34, BOOK-111): the 201 DTO enters the feed in the same frame,
   * so the mark and the strip are there with no reload; the chapter's feed and the register
   * then re-read the durable truth.
   */
  const onPosted = (comment: CommentDto): void => {
    acceptComment(comment);
    void refreshComments(comment.chapter);
    noteRecord({ kind: 'posted', signedIn: viewer.signedIn });
  };

  // BOOK-166 — the record is a mode of the same page: the head, the record, the colophon.
  const doorLine =
    changeDoor.failed === null ? null : (
      <p className="state-line" role="status">
        {changeDoor.failed}
      </p>
    );
  // BOOK-225 — both record modes are prose doors (`/api/history/chapters/:n` refuses a gated
  // reader), so a gated page is the book page and nothing else: `recordModeOf` says so once.
  const recordMode = recordModeOf({ acknowledged: age.acknowledged, trail, view, chronicle });
  if (recordMode !== null) {
    return (
      <RecordMode
        mode={recordMode} view={view} onViewChange={setView} state={state} ribbon={ribbon}
        catalog={catalog} markers={escalationMarkers(state.unresolved)} onOpenChange={openChange}
        live={history} socket={connection} stages={stages} reading={reading} viewer={viewer} front={front}
        historyTick={historyTick} doorLine={doorLine} plate={connection === 'capacity'}
        loadChapter={loadChapter}
      />
    );
  }

  /** BOOK-225 — the chapter flow's props in one place, so the gate can stand in its slot. */
  const chapterFlow = {
    catalog, revisions, revising, markers, fresh, stages, chapterFeed, changes,
    nowMs, onRead: loadChapter, onPosted, sentence, composer, viewer, history,
  };

  return (
    <>
      <Opening
        front={front}
        state={state}
        ribbon={ribbon}
        catalog={catalog}
        escalation={escalationMarkers(state.unresolved)}
        onOpenChange={openChange}
        view={view}
        onViewChange={setView}
        motion={titleMotion}
        live={history} chronicle={chronicle}
        stages={stages}
        socket={connection}
        reading={reading}
        gated={!age.acknowledged}
      />
      <ConsentBanner />
      <TableOfContents catalog={catalog} state={state} currentChapter={currentChapter} />
      {/* BOOK-225 — the gate stands where the chapters would; gated, nothing that leads into
          prose or the book's counts is mounted either. */}
      {age.acknowledged ? <ChapterList {...chapterFlow} /> : <AgeGate title={front.title} onAccept={age.accept} />}
      {age.acknowledged ? (
        <>
          {/* §6C.5: the end matter follows the last chapter, before the discussion. */}
          <EndMatter imprint={front.imprint} lastRevisionAt={state.activity.lastFileChangeAt} live={history} exportBytes={front.exportBytes ?? null} />
          <Discussion depth={state.queue.depth} stage={stage} busy={!threadSettled} complete={commentsComplete} changes={changes} comments={comments} nowMs={nowMs} live={history} failed={commentsFailed} onLoadChapter={loadChapter} />
        </>
      ) : null}
      <Colophon state={state} imprint={front.imprint} viewer={viewer} donateUrl={front.donateUrl ?? null} exportBytes={front.exportBytes ?? null} gated={!age.acknowledged} />
      {age.acknowledged ? (
        <>
          {doorLine}
          <NoticeTicket notice={notice} onGo={go} onDismiss={() => setNotice(null)} />
          <FootJumps live={history} plate={connection === 'capacity'} />
          <CapacityPlate active={connection === 'capacity'} />
        </>
      ) : null}
    </>
  );
}
