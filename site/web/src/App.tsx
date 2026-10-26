import type {
  BlockRevisingPayload,
  CascadeProgressPayload,
  ChangeDecidedPayload,
  ChangeProcessingPayload,
  ChangeStalePayload,
  ChangeSummaryDto,
  ChapterCreatedPayload,
  ChapterRevisionPayload,
  CommentDto,
  ComposerInfo,
  Envelope,
  FrontUpdatedPayload,
  HelloPayload,
  HistoryEventFrame,
  ServerEventType,
  StateUpdatedPayload,
  ViewerDto,
} from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getChanges,
  getChapters,
  getComments,
  getFront,
  getQueue,
  getState,
} from './api.ts';
import { chapterInViewport, elementInViewport, scrollToChapter } from './dom.ts';
import { EndMatter } from './components/EndMatter.tsx';
import { ChangeCard } from './components/ChangeCard.tsx';
import { Chronicle } from './components/Chronicle.tsx';
import { ParagraphChain } from './components/ParagraphChain.tsx';
import { ViewSwitch, type BookView } from './components/ViewSwitch.tsx';
import { ChapterArticle } from './components/ChapterArticle.tsx';
import { FocusView } from './components/FocusView.tsx';
import { Colophon } from './components/Colophon.tsx';
import { Discussion } from './components/Discussion.tsx';
import { NoticeTicket, type Notice } from './components/Notice.tsx';
import { Opening } from './components/Opening.tsx';
import { TableOfContents } from './components/TableOfContents.tsx';
import {
  bookFromHello,
  catalogOutOfSync,
  withChapterCreated,
  withChapterRevision,
  withFront,
  withState,
  type BookData,
} from './lib/bookState.ts';
import { escalationMarkers, reduceRibbon, ribbonAfterSnapshot, ribbonFromState, type Ribbon } from './lib/cascade.ts';
import { spineMarkers } from './lib/spine.ts';
import { IDLE_TITLE, nextTitleMotion, type TitleMotion } from './lib/titleChange.ts';
import { BookSocket, websocketUrl, type SocketStatus } from './lib/ws.ts';
import { useChangeCard } from './useChangeCard.ts';
import { usePageTitle } from './usePageTitle.ts';
import { useFocusMode } from './useFocus.ts';
import { useParagraphChain } from './useParagraphChain.ts';

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
  const [fresh, setFresh] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ribbon, setRibbon] = useState<Ribbon | null>(null);
  const [changes, setChanges] = useState<ChangeSummaryDto[]>([]);
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [viewer, setViewer] = useState<ViewerDto>({ signedIn: false, displayName: null });
  const [composer, setComposer] = useState<ComposerInfo>({
    captcha: { provider: 'none', siteKey: null },
    minChars: 3,
    maxChars: 1_200,
  });
  const [titleMotion, setTitleMotion] = useState<TitleMotion>(IDLE_TITLE);
  /** «книга · хроника»: one page, two ways of reading it (§11.10). */
  const [view, setView] = useState<BookView>('book');
  const [historyTick, setHistoryTick] = useState(0);
  const {
    chain,
    loading: chainLoading,
    anchor: chainAnchor,
    open: openChain,
    close: closeChain,
  } = useParagraphChain();
  /**
   * The card and the focus view («прицел», §11.9). The focus view is a mode of this page,
   * selected by `#правка-<id>`; its session (hash, change, impact) lives in `useFocusMode`.
   */
  const card = useChangeCard();
  const focus = useFocusMode(card.close);
  usePageTitle(data?.front.title ?? null);
  const socketRef = useRef<BookSocket | null>(null);
  const helloSeen = useRef(false);
  const timers = useRef<number[]>([]);
  const dataRef = useRef<BookData | null>(null);

  /**
   * REST fallback and resync. The initial call must not overwrite a `hello` that already
   * arrived (the socket can beat a slow request); an explicit resync after a `seq` gap must.
   */
  const refreshAll = useCallback(async (force = false) => {
    try {
      const [state, catalog, front] = await Promise.all([getState(), getChapters(), getFront()]);
      setData((current) => (helloSeen.current && current !== null && !force ? current : { state, catalog, front }));
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

  useEffect(() => {
    void refreshAll(false);
    void refreshChanges();
    void refreshComments();
  }, [refreshAll, refreshChanges, refreshComments]);

  // `/api/queue` is polled only while the engine is alive (§9); the socket carries the rest.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const status = dataRef.current?.state.engine.status;
      if (status === 'down' || status === 'absent' || status === 'unknown') return;
      void getQueue()
        .then((queue) =>
          setData((current) =>
            current === null ? current : { ...current, state: { ...current.state, queue } },
          ),
        )
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const socket = new BookSocket(websocketUrl(window.location.origin), {
      onEvent: (event: Envelope) => {
        const frame = event as Envelope<ServerEventType, unknown>;
        switch (frame.type) {
          case 'hello': {
            const hello = frame.data as HelloPayload;
            helloSeen.current = true;
            setData(bookFromHello(hello));
            setViewer(hello.viewer);
            setComposer(hello.composer);
            setRibbon(ribbonFromState(hello.state));
            setNotice(null);
            setRevisions({});
            setRevising({});
            setFresh(null);
            setFailed(false);
            void refreshChanges();
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
          case 'block:revising': {
            const mark = frame.data as BlockRevisingPayload;
            if (!mark.active) {
              setRevising((current) => {
                const next = { ...current };
                delete next[mark.n];
                return next;
              });
              break;
            }
            setRevising((current) => ({ ...current, [mark.n]: mark }));
            const expiresIn = Math.max(0, Date.parse(mark.expiresAt) - Date.now());
            const timer = window.setTimeout(() => {
              setRevising((current) => {
                if (current[mark.n]?.since !== mark.since) return current;
                const next = { ...current };
                delete next[mark.n];
                return next;
              });
            }, Number.isNaN(expiresIn) ? 0 : expiresIn + 250);
            timers.current.push(timer);
            break;
          }
          case 'history:event': {
            // The chronicle's ticker; the payload is one summary line, never a body.
            const entry = frame.data as HistoryEventFrame;
            if (entry.hseq > 0) setHistoryTick((current) => current + 1);
            break;
          }
          case 'comment:added':
          case 'comment:decision':
          case 'feedback:batch': {
            void refreshComments();
            break;
          }
          case 'change:queued': {
            void refreshChanges();
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
            setRibbon((current) => reduceRibbon(current, { type: frame.type, data: decided }));
            void refreshChanges();
            card.refresh(decided.id);
            focus.bump(decided.id);
            break;
          }
          default:
            break;
        }
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
  }, [refreshAll, refreshCatalog, refreshChanges, refreshComments, card.refresh, focus.bump]);

  if (connection === 'capacity') {
    return (
      <main className="page waiting" role="alert">
        <p className="waiting-copy">здесь слишком много людей — подождите, кто-нибудь выйдет, и вы войдёте</p>
        <button className="waiting-retry" type="button" onClick={() => socketRef.current?.retry()}>
          попробовать снова
        </button>
      </main>
    );
  }

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
    return (
      <main className="page" aria-busy="true">
        <div className="state-line"><span>опись читается</span></div>
      </main>
    );
  }

  const { state, catalog, front } = data;
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

  const views = <ViewSwitch view={view} onChange={setView} />;
  const focusView =
    focus.id === null ? null : (
      <FocusView
        change={focus.change}
        impact={focus.impact}
        missing={focus.missing}
        ribbon={ribbon}
        revisions={revisions}
        onClose={focus.close}
      />
    );

  if (view === 'chronicle') {
    return (
      <>
        {views}
        <Chronicle
          catalog={catalog}
          frontRev={front.rev}
          tick={historyTick}
          onOpenChange={card.open}
        />
        {card.change === null ? null : <ChangeCard change={card.change} onClose={card.close} />}
        {chainLoading || chain !== null ? (
          <ParagraphChain chain={chain} loading={chainLoading} onClose={closeChain} anchor={chainAnchor} />
        ) : null}
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
        escalation={escalationMarkers(state.unresolved)}
        onOpenChange={card.open}
        view={view}
        onViewChange={setView}
        motion={titleMotion}
      />
      <TableOfContents catalog={catalog} state={state} currentChapter={currentChapter} />
      <main>
        {catalog.map((entry) => {
          const forwardCaret = markers.carets.forward === entry.n;
          const backwardCaret = markers.carets.backward === entry.n;
          const show = forwardCaret || backwardCaret;
          const live = (forwardCaret && markers.live.forward) || (backwardCaret && markers.live.backward);
          return (
            <ChapterArticle
              key={entry.n}
              entry={entry}
              revision={revisions[entry.n] ?? null}
              revising={revising[entry.n] ?? null}
              caret={show ? { show, live } : null}
              fresh={fresh === entry.n}
              onProvenance={(blockId, button) => openChain(blockId, button.getBoundingClientRect())}
            />
          );
        })}
      </main>
      {/* §6C.5: the end matter follows the last chapter, before the discussion. */}
      <EndMatter
        imprint={front.imprint}
        lastRevisionAt={state.activity.lastFileChangeAt}
        onOpenChronicle={() => setView('chronicle')}
      />
      <Discussion
        depth={state.queue.depth}
        chapterCount={state.chapters.count}
        changes={changes}
        comments={comments}
        viewer={viewer}
        composer={composer}
        chapters={catalog}
        onPosted={() => void refreshComments()}
      />
      <Colophon state={state} imprint={front.imprint} />
      {card.change === null ? null : <ChangeCard change={card.change} onClose={card.close} />}
      {chainLoading || chain !== null ? (
        <ParagraphChain chain={chain} loading={chainLoading} onClose={closeChain} anchor={chainAnchor} />
      ) : null}
      <NoticeTicket notice={notice} onGo={go} onDismiss={() => setNotice(null)} />
      {focusView}
    </>
  );
}
