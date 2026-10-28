import type {
  AuthorsCountDto,
  BlockRevisingPayload,
  CascadeProgressPayload,
  ChangeDecidedPayload,
  ChangeProcessingPayload,
  ChangeStalePayload,
  ChapterCreatedPayload,
  ChapterRevisionPayload,
  CommentDto,
  Envelope,
  FrontUpdatedPayload,
  HelloPayload,
  HistoryEventFrame,
  PassStageEvent,
  ServerEventType,
  StateUpdatedPayload,
  ViewerDto,
} from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getChapters, getFront, getState } from './api.ts';
import { chapterInViewport, elementInViewport, scrollToChapter } from './dom.ts';
import { EndMatter } from './components/EndMatter.tsx';
import { BootWait } from './components/BootWait.tsx';
import { ChangeCard } from './components/ChangeCard.tsx';
import { CapacityPlate } from './components/CapacityPlate.tsx';
import { Chronicle } from './components/Chronicle.tsx';
import { ConsentBanner } from './components/ConsentBanner.tsx';
import { ParagraphChain } from './components/ParagraphChain.tsx';
import { ViewSwitch, type BookView } from './components/ViewSwitch.tsx';
import { ChapterList } from './components/ChapterList.tsx';
import { FocusView } from './components/FocusView.tsx';
import { Colophon } from './components/Colophon.tsx';
import { Discussion } from './components/Discussion.tsx';
import { NoticeTicket, type Notice } from './components/Notice.tsx';
import { Opening } from './components/Opening.tsx';
import { TableOfContents } from './components/TableOfContents.tsx';
import { EMPTY_COMPOSER } from './lib/composer.ts';
import { historyLive, historyStarted } from './lib/historyState.ts';
import { applyStage, type Passes } from './lib/passes.ts';
import { applyRevisingMark } from './lib/revisingMark.ts';
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
import { escalationMarkers, reduceRibbon, ribbonAfterSnapshot, ribbonFromState, ribbonMaxWave, type Ribbon } from './lib/cascade.ts';
import { spineMarkers } from './lib/spine.ts';
import { IDLE_TITLE, nextTitleMotion, type TitleMotion } from './lib/titleChange.ts';
import { BookSocket, websocketUrl, type SocketStatus } from './lib/ws.ts';
import { useChangeCard } from './useChangeCard.ts';
import { commentFrameChapter } from './lib/commentFrames.ts';
import { useReaderFeed } from './useReaderFeed.ts';
import { usePageTitle } from './usePageTitle.ts';
import { usePending } from './usePending.ts';
import { useFocusMode } from './useFocus.ts';
import { closeOverlays } from './lib/overlays.ts';
import { useParagraphChain } from './useParagraphChain.ts';
import { useDeepLink } from './lib/useDeepLink.ts';
import { useQueuePoll } from './useQueuePoll.ts';
import { useBookCost } from './useBookCost.ts';
import { useFrontRevision } from './useFrontRevision.ts';

/**
 * One page, the book in order (ARCHITECTURE §11.2; BOOK-DOC-5 §5): cover → page 2 → the
 * instrument strip → live TOC → 67 chapter slots (empty ones are slim, designed slots) →
 * discussion → colophon. Every catalog slot exists from the first paint; prose is fetched
 * when a chapter comes within 1.5 viewports.
 *
 * Live updates arrive on `/ws` and are merged by `rev`, never by arrival order. A reconnect
 * is healed by `hello`, which carries the catalog, the first sheet and the snapshot in one
 * frame; a gap in `seq` triggers one REST resync.
 */
export function App() {
  const [data, setData] = useState<BookData | null>(null);
  const [failed, setFailed] = useState(false);
  const [connection, setConnection] = useState<SocketStatus>('connecting');
  const [revisions, setRevisions] = useState<Record<number, ChapterRevisionPayload>>({});
  const [revising, setRevising] = useState<Record<number, BlockRevisingPayload>>({});
  /** The writer lanes' passes in flight, by chapter — the page's only notice a text is coming. */
  const [passes, setPasses] = useState<Passes>({});
  const [fresh, setFresh] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ribbon, setRibbon] = useState<Ribbon | null>(null);
  const [viewer, setViewer] = useState<ViewerDto>({ signedIn: false, displayName: null });
  const [composer, setComposer] = useState(EMPTY_COMPOSER);
  /** BOOK-DOC-4 rule 3: the wave bound arrives in `hello.limits`; null until that frame. */
  const [maxWave, setMaxWave] = useState<number | null>(null);
  const [titleMotion, setTitleMotion] = useState<TitleMotion>(IDLE_TITLE);
  /** «книга · хроника»: one page, two ways of reading it (§11.10). */
  const [view, setView] = useState<BookView>('book');
  const [historyTick, setHistoryTick] = useState(0);
  const {
    chain, loading: chainLoading, failed: chainFailed, active: chainActive, anchor: chainAnchor,
    open: openChain, retry: retryChain, close: closeChain,
  } = useParagraphChain();
  /**
   * The card and the focus view («прицел», §11.9). The focus view is a mode of this page,
   * selected by `#правка-<id>`; its session (hash, change, impact) lives in `useFocusMode`.
   */
  const card = useChangeCard();
  // BOOK-111: entering the прицел closes the seam, the panel and the revision object.
  const enterFocus = useCallback(() => {
    card.close();
    closeOverlays();
  }, [card.close]);
  const focus = useFocusMode(enterFocus);
  usePageTitle(data === null ? undefined : data.front.title);
  const socketRef = useRef<BookSocket | null>(null);
  const helloSeen = useRef(false);
  const timers = useRef<number[]>([]);
  const dataRef = useRef<BookData | null>(null);
  /**
   * The thread, the summary of decisions and the record behind it (BOOK-13): the frame is
   * only the trigger, the own-only endpoint is the durable line the page reloads into.
   */
  const { changes, comments, chapterFeed, decisions, threadSettled, loadThread, refreshChanges, refreshComments, acceptComment, loadChapter, refreshLoaded, noteRecord } =
    useReaderFeed();
  /** §4 — the thread waits until both feeds settle; a later frame never re-arms it. */
  const stage = usePending(!threadSettled);

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
  useDeepLink(data !== null);
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
  /** BOOK-114: the footer's outlay, re-read when the book state version moves. */
  const cost = useBookCost(data?.state.version ?? null);

  useEffect(() => {
    const socket = new BookSocket(websocketUrl(window.location.origin), {
      onEvent: (event: Envelope) => {
        const frame = event as Envelope<ServerEventType, unknown>;
        switch (frame.type) {
          case 'hello': {
            const hello = frame.data as HelloPayload;
            helloSeen.current = true;
            setData((current) => bookFromHello(hello, current));
            setViewer(hello.viewer);
            setComposer(hello.composer);
            setMaxWave(ribbonMaxWave(hello.limits.maxWave));
            setRibbon(ribbonFromState(hello.state));
            setNotice(null);
            setRevisions({});
            setRevising({});
            setPasses({});
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
          case 'pass:stage':
            // A pass is the only notice a page gets that a chapter's text is being written:
            // `landed` is the engine's, and the site's watcher then publishes no revision.
            setPasses((current) => applyStage(current, frame.data as PassStageEvent));
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
          case 'comment:decision': {
            // A decision frame is a broadcast; only the viewer's own comment earns a reload
            // of the durable record. Everybody else's is simply the thread's business.
            noteRecord({ kind: 'frame', type: frame.type, data: frame.data });
            void refreshComments(commentFrameChapter(frame.data) ?? undefined);
            break;
          }
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
            focus.bump(processing.id);
            break;
          }
          case 'change:stale': {
            const stale = frame.data as ChangeStalePayload;
            void refreshChanges();
            focus.bump(stale.id);
            break;
          }
          case 'cascade:progress': {
            const progress = frame.data as CascadeProgressPayload;
            setRibbon((current) => reduceRibbon(current, { type: frame.type, data: progress }));
            break;
          }
          case 'change:decided': {
            const decided = frame.data as ChangeDecidedPayload;
            noteRecord({ kind: 'frame', type: frame.type, data: decided });
            setRibbon((current) => reduceRibbon(current, { type: frame.type, data: decided }));
            void refreshChanges();
            card.refresh(decided.id);
            focus.bump(decided.id);
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
  }, [refreshAll, refreshCatalog, refreshChanges, refreshComments, refreshLoaded, noteRecord, card.refresh, focus.bump, applyAuthorsCount, noteRevision]);

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
      document.getElementById('toc')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    scrollToChapter(target.n);
  };
  /** Reaching a chapter from a card: the card closes, the chapter is opened. */
  const toChapter = (n: number): void => (card.close(), scrollToChapter(n));
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

  const views = <ViewSwitch view={view} onChange={setView} live={chronicle} />;
  const focusView =
    focus.id === null ? null : (
      <FocusView
        change={focus.change}
        impact={focus.impact}
        missing={focus.missing}
        ribbon={ribbon}
        maxWave={maxWave ?? undefined}
        revisions={revisions}
        onClose={focus.close}
        live={history}
      />
    );

  if (view === 'chronicle' && chronicle) {
    return (
      <>
        {views}
        <ConsentBanner />
        <Chronicle
          catalog={catalog}
          frontRev={front.rev}
          tick={historyTick}
          onOpenChange={card.open}
          started={chronicle}
          live={history}
        />
        {card.change === null ? null : (
          <ChangeCard change={card.change} onClose={card.close} onOpenChapter={toChapter} />
        )}
        {chainActive ? (
          <ParagraphChain chain={chain} loading={chainLoading} failed={chainFailed} onClose={closeChain} onRetry={retryChain} anchor={chainAnchor} live={history} />
        ) : null}
        <CapacityPlate active={connection === 'capacity'} />
        {focusView}
      </>
    );
  }

  return (
    <>
      <Opening
        front={front}
        state={state}
        ribbon={ribbon}
        catalog={catalog}
        escalation={escalationMarkers(state.unresolved)}
        onOpenChange={card.open}
        view={view}
        onViewChange={setView}
        motion={titleMotion}
        live={history}
        chronicle={chronicle}
      />
      <ConsentBanner />
      <TableOfContents catalog={catalog} state={state} currentChapter={currentChapter} />
      <ChapterList
        catalog={catalog}
        revisions={revisions}
        revising={revising}
        markers={markers}
        fresh={fresh}
        passes={passes}
        chapterFeed={chapterFeed}
        changes={changes}
        onRead={loadChapter}
        onPosted={onPosted}
        onProvenance={(blockId, button) => openChain(blockId, button.getBoundingClientRect())}
        composer={composer}
        viewer={viewer}
        history={history}
      />
      {/* §6C.5: the end matter follows the last chapter, before the discussion. */}
      <EndMatter
        imprint={front.imprint}
        lastRevisionAt={state.activity.lastFileChangeAt}
        signedIn={viewer.signedIn}
        decisions={decisions}
        onAuthorsCount={applyAuthorsCount}
        live={history}
        exportBytes={front.exportBytes ?? null}
      />
      <Discussion depth={state.queue.depth} stage={stage} busy={!threadSettled} changes={changes} comments={comments} live={history} />
      <Colophon state={state} imprint={front.imprint} viewer={viewer} cost={cost} donateUrl={front.donateUrl ?? null} exportBytes={front.exportBytes ?? null} />
      {card.change === null ? null : <ChangeCard change={card.change} onClose={card.close} onOpenChapter={toChapter} />}
      {chainActive ? (
        <ParagraphChain chain={chain} loading={chainLoading} failed={chainFailed} onClose={closeChain} onRetry={retryChain} anchor={chainAnchor} live={history} />
      ) : null}
      <NoticeTicket notice={notice} onGo={go} onDismiss={() => setNotice(null)} />
      <CapacityPlate active={connection === 'capacity'} />
      {focusView}
    </>
  );
}
