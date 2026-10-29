import type { CommentDto, Envelope } from '@book/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getChapters, getFront, getState } from './api.ts';
import { chapterInViewport, elementInViewport } from './dom.ts';
import { EndMatter } from './components/EndMatter.tsx';
import { BootWait } from './components/BootWait.tsx';
import { CapacityPlate } from './components/CapacityPlate.tsx';
import { Chronicle } from './components/Chronicle.tsx';
import { ConsentBanner } from './components/ConsentBanner.tsx';
import { ViewSwitch, type BookView } from './components/ViewSwitch.tsx';
import { ChapterList } from './components/ChapterList.tsx';
import { FootJumps } from './components/FootJumps.tsx';
import { Colophon } from './components/Colophon.tsx';
import { Discussion } from './components/Discussion.tsx';
import { NoticeTicket, type Notice } from './components/Notice.tsx';
import { Opening } from './components/Opening.tsx';
import { TableOfContents } from './components/TableOfContents.tsx';
import { TrailView } from './components/TrailView.tsx';
import { EMPTY_COMPOSER } from './lib/composer.ts';
import { historyLive, historyStarted } from './lib/historyState.ts';
import { revisingOf } from './lib/revisingMark.ts';
import { withFreshFront, withRevision, type BookData } from './lib/bookState.ts';
import { escalationMarkers } from './lib/cascade.ts';
import { spineMarkers } from './lib/spine.ts';
import { BookSocket, websocketUrl, type SocketStatus } from './lib/ws.ts';
import { publishLiveChange } from './lib/liveChange.ts';
import { applyFrame, initialClientState, type ClientState, type FrameEffect } from './lib/frames.ts';
import { useReaderFeed } from './useReaderFeed.ts';
import { useReviseTick } from './lib/useReviseTick.ts';
import { usePageTitle } from './usePageTitle.ts';
import { usePending } from './usePending.ts';
import { useParagraphChain } from './useParagraphChain.ts';
import { usePosition, jumpToChapter } from './lib/usePosition.ts';
import { setChangeOpener } from './lib/changeDoor.ts';
import { useChangeDoor } from './useChangeDoor.ts';
import { useReading } from './lib/pageTrack.ts';
import { useTrail } from './lib/useTrail.ts';
import { landFrame } from './lib/follow.ts';
import { upsertFiling } from './lib/filings.ts';
import { useFrontRevision } from './useFrontRevision.ts';

/** No chapter slots on this mode: a stable identity, so the reading hook re-runs on return. */
const NO_CHAPTERS: ReadonlyArray<{ n: number; chars: number }> = [];

/**
 * One page, the book in order (ARCHITECTURE §11.2; BOOK-DOC-5 §5): cover → page 2 → live TOC →
 * 42 chapter slots → discussion → colophon. The chronicle and a pass's record are modes of the
 * same page, chosen by the hash. Every slot exists from the first paint; prose is fetched when
 * a chapter comes within 1.5 viewports.
 *
 * BOOK-DOC-84 — every state arrives by socket and the page is one reducer (`lib/frames.ts`):
 * this component owns the socket, the effects the frames ask for, and the modes. A reconnect
 * heals by `hello` (which **is** the snapshot, `live` included); a delivery gap asks for
 * `state:snapshot`; nothing polls for a state a frame can carry. The prose is the one thing
 * fetched by design (ADR-004), and its write prints from `chapter:applied`, never from a close.
 */
export function App() {
  const [page, setPage] = useState<ClientState>(() => initialClientState());
  /** The reducer's own copy of the page: a frame is applied synchronously, in order. */
  const pageRef = useRef(page);
  const [failed, setFailed] = useState(false);
  const [connection, setConnection] = useState<SocketStatus>('connecting');
  /**
   * BOOK-DOC-84 §11.1 — the moment the page lost the machine, `null` while it can see it. The
   * head's `нет связи` is that fact and not a stage: it appears on a dropped socket only after a
   * `hello` proved the page was connected, and it is cleared by the reconnect's own `hello`.
   */
  const [offlineAt, setOfflineAt] = useState<number | null>(null);
  /** «книга · хроника»: one page, two ways of reading it (§11.10). */
  const [view, setView] = useState<BookView>('book');
  /**
   * BOOK-128 comment #3815 — the phrase's facts are the paragraph's own margin item now, so the
   * page hands the whole mode down to the article instead of drawing a floating box at its root.
   */
  const sentence = useParagraphChain();
  const trail = useTrail();
  const helloSeen = useRef(false);
  const socketRef = useRef<BookSocket | null>(null);
  const readingRef = useRef({ n: null as number | null, page: null as number | null });

  /** One write of the page: the ref and React's state move together, never apart. */
  const commit = useCallback((next: ClientState) => {
    pageRef.current = next;
    // BOOK-220 B2 — the record's `правка` section is a leaf: the change's live line and its
    // closed pass reach it through the facts store, and identity is the whole diff.
    publishLiveChange({ lines: next.lines, passes: next.passes });
    setPage(next);
  }, []);
  const update = useCallback(
    (mutate: (current: ClientState) => ClientState) => commit(mutate(pageRef.current)),
    [commit],
  );

  const book = page.book;
  // BOOK-104 / BOOK-207 — the page's one reading model; a mode without chapter slots hands
  // the hook a stable empty list, so leaving it re-measures the book.
  const readingCatalog = trail || view !== 'book' || book === null ? NO_CHAPTERS : book.catalog;
  const reading = useReading(readingCatalog);
  readingRef.current = reading;
  usePageTitle(book === null ? undefined : book.front.title);

  /**
   * The thread, the summary of decisions and the record behind it (BOOK-13): a frame is the
   * trigger where the payload is a tick by design; the durable answer is the REST line the page
   * reloads into.
   */
  const {
    changes,
    comments: feedComments,
    commentsComplete,
    commentsFailed,
    chapterFeed,
    threadSettled,
    loadThread,
    refreshChanges,
    refreshComments,
    acceptComment,
    loadChapter,
    refreshLoaded,
    noteRecord,
    noteDecision,
  } = useReaderFeed();
  // BOOK-158: the frozen `revise` is re-read from this one clock (countdown + chapter refresh).
  const nowMs = useReviseTick(feedComments, chapterFeed, refreshComments);
  /** §4 — the thread waits until both feeds settle; a later frame never re-arms it. */
  const stage = usePending(!threadSettled);
  /**
   * The one door to a change: it lands on the change's sentence and opens the record there with
   * the `правка` section expanded. A change never gets a surface of its own again.
   */
  const changeDoor = useChangeDoor({ ready: book !== null && view === 'book', loadChapter });
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
   * REST, for the two things a frame does not carry by design: the catalogue and the prose.
   * The initial call must not overwrite a `hello` that already arrived; a resync after a gap
   * must. BOOK-138: the edition's size travels with its number.
   */
  const setBook = useCallback<React.Dispatch<React.SetStateAction<BookData | null>>>(
    (action) => {
      update((current) => {
        const next = typeof action === 'function' ? action(current.book) : action;
        return { ...current, book: next };
      });
    },
    [update],
  );
  const noteRevision = useFrontRevision(setBook);

  const refreshAll = useCallback(
    async (force = false) => {
      try {
        const [snapshot, catalog, front] = await Promise.all([getState(), getChapters(), getFront()]);
        update((current) => ({
          ...current,
          book:
            helloSeen.current && current.book !== null && !force
              ? withRevision(current.book, front.revision, front.exportBytes)
              : withFreshFront({ state: snapshot, catalog, front }, current.book),
        }));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    },
    [update],
  );

  const refreshCatalog = useCallback(async () => {
    try {
      const catalog = await getChapters();
      update((current) =>
        current.book === null ? current : { ...current, book: { ...current.book, catalog } },
      );
    } catch {
      /* the next snapshot or reconnect retries */
    }
  }, [update]);

  // BOOK-209 — the place layer owns landing, the fragment and back/forward; BOOK-220's page
  // hands it only its readiness and whether the reader is signed in.
  usePosition(book !== null, page.viewer.signedIn);
  useEffect(() => {
    void refreshAll(false);
    void loadThread();
  }, [refreshAll, loadThread]);

  /**
   * The frames' side effects, and nothing else: a refetch where the frame is a trigger by
   * design, one record tick, one land, and the resync a delivery gap asks for.
   */
  const run = useCallback(
    (effect: FrameEffect) => {
      switch (effect.kind) {
        case 'resync':
          socketRef.current?.sendResync(effect.since);
          break;
        case 'refreshCatalog':
          void refreshCatalog();
          break;
        case 'refreshComments':
          void refreshComments(effect.chapter);
          break;
        case 'refreshChanges':
          void refreshChanges();
          break;
        case 'refreshLoaded':
          void refreshLoaded();
          break;
        case 'noteRevision':
          noteRevision();
          break;
        case 'noteRecord':
          noteRecord(effect.event);
          break;
        case 'noteDecision':
          noteDecision(effect.data);
          break;
        case 'landFrame':
          landFrame(effect.data, readingRef.current.n);
          break;
      }
    },
    [refreshCatalog, refreshChanges, refreshComments, refreshLoaded, noteRecord, noteDecision, noteRevision],
  );

  const handle = useCallback(
    (event: Envelope) => {
      const result = applyFrame(pageRef.current, event, {
        chapter: (n: number) => chapterInViewport(n),
        toc: () => elementInViewport('toc'),
      });
      if (event.type === 'hello') helloSeen.current = true;
      commit(result.state);
      for (const effect of result.effects) run(effect);
    },
    [commit, run],
  );
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    const socket = new BookSocket(websocketUrl(window.location.origin), {
      onEvent: (event) => handleRef.current(event),
      onStatus: (status) => {
        setConnection(status);
        // A socket that never opened is a page still booting, not a lost connection.
        setOfflineAt(status === 'closed' && helloSeen.current ? Date.now() : null);
      },
      // §3.3 — a delivery gap is healed by one snapshot, never by a replay (the hub keeps none).
      onGap: () => socketRef.current?.sendResync(pageRef.current.seq),
    });
    socket.connect();
    socketRef.current = socket;
    const ping = window.setInterval(() => socket.sendPing(), 25_000);
    return () => {
      window.clearInterval(ping);
      socket.close();
      socketRef.current = null;
    };
  }, []);

  /** A fresh chapter keeps its ticket for ten seconds, and the timer belongs to the page. */
  useEffect(() => {
    const fresh = page.fresh;
    if (fresh === null) return;
    const timer = window.setTimeout(() => {
      update((current) => (current.fresh === fresh ? { ...current, fresh: null } : current));
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [page.fresh, update]);

  /**
   * The register reads the durable feed plus the rows `comment:added` inserted: the frame
   * carries the DTO, so a second tab and the poster see the same row with no refetch.
   */
  const comments = useMemo(() => {
    let list: readonly CommentDto[] = feedComments;
    for (const dto of page.added) list = upsertFiling(list, dto) ?? list;
    return list;
  }, [feedComments, page.added]);

  if (failed && book === null) {
    return (
      <main className="page">
        <div className="state-line">
          <span>опись не прочиталась</span>
          <button type="button" onClick={() => void refreshAll()}>повторить</button>
        </div>
      </main>
    );
  }

  if (book === null) {
    // The failing branch returned above, so this is the wait and nothing else — no `failed`.
    return <main className="page boot-wait" aria-busy="true"><BootWait active /></main>;
  }

  const { state, catalog, front } = book;
  /** BOOK-56: the one fact every history surface reads. */
  const history = historyLive(state);
  /** BOOK-56: the book has begun, so the chronicle exists from its first record. */
  const chronicle = historyStarted(state);
  const markers = spineMarkers(state);
  const currentChapter = state.current !== null && state.current.chapter !== 'front' ? state.current.chapter : null;
  const composer = page.composer ?? EMPTY_COMPOSER;
  const notice: Notice | null = page.notice;

  const go = (target: Notice): void => {
    update((current) => ({ ...current, notice: null }));
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
    noteRecord({ kind: 'posted', signedIn: page.viewer.signedIn });
  };

  // BOOK-166 — the record is a mode of the same page: the head, the record, the colophon.
  const doorLine =
    changeDoor.failed === null ? null : (
      <p className="state-line" role="status">
        {changeDoor.failed}
      </p>
    );
  const connectionLine =
    page.connection === null ? null : (
      // BOOK-DOC-84 #24 — an `error` frame is a state line, never a toast.
      <p className="state-line" role="status">
        связь: {page.connection}
      </p>
    );
  if (trail) {
    return (
      <>
        <TrailView
          state={state} ribbon={page.ribbon} catalog={catalog}
          markers={escalationMarkers(state.unresolved)} onOpenChange={openChange}
          live={history} client={page} offlineAt={offlineAt}
          reading={reading} viewer={page.viewer}
          filings={page.filings} filingUpdates={page.filingUpdates}
          imprint={front.imprint} donateUrl={front.donateUrl ?? null}
          exportBytes={front.exportBytes ?? null} loadChapter={loadChapter}
        />
        <ConsentBanner />
        <CapacityPlate active={connection === 'capacity'} />
        {doorLine}
        {connectionLine}
      </>
    );
  }

  if (view === 'chronicle' && chronicle) {
    return (
      <>
        <ViewSwitch view={view} onChange={setView} live={chronicle} />
        <ConsentBanner />
        <Chronicle
          catalog={catalog}
          frontRev={front.rev}
          tick={page.historyTick}
          onOpenChange={openChange}
          started={chronicle}
          live={history}
          onLoadChapter={loadChapter}
        />
        <CapacityPlate active={connection === 'capacity'} />
        {doorLine}
        {connectionLine}
      </>
    );
  }

  return (
    <>
      <Opening
        front={front}
        state={state}
        ribbon={page.ribbon}
        catalog={catalog}
        escalation={escalationMarkers(state.unresolved)}
        onOpenChange={openChange}
        view={view}
        onViewChange={setView}
        motion={page.titleMotion}
        live={history} chronicle={chronicle}
        client={page} offlineAt={offlineAt}
        reading={reading}
      />
      <ConsentBanner />
      <TableOfContents catalog={catalog} state={state} currentChapter={currentChapter} />
      <ChapterList
        catalog={catalog}
        revisions={page.revisions}
        revising={revisingOf(state.revising)}
        markers={markers}
        fresh={page.fresh}
        applied={page.applied}
        chapterFeed={chapterFeed}
        changes={changes}
        nowMs={nowMs}
        onRead={loadChapter}
        onPosted={onPosted}
        sentence={sentence}
        composer={composer}
        viewer={page.viewer}
        history={history}
      />
      {/* §6C.5: the end matter follows the last chapter, before the discussion. */}
      <EndMatter
        imprint={front.imprint}
        lastRevisionAt={state.activity.lastFileChangeAt}
        live={history}
        exportBytes={front.exportBytes ?? null}
      />
      <Discussion
        depth={state.queue.depth}
        pending={page.queue}
        stage={stage}
        busy={!threadSettled}
        complete={commentsComplete}
        changes={changes}
        comments={comments}
        nowMs={nowMs}
        live={history}
        failed={commentsFailed}
        onLoadChapter={loadChapter}
      />
      <Colophon state={state} imprint={front.imprint} viewer={page.viewer} donateUrl={front.donateUrl ?? null} exportBytes={front.exportBytes ?? null} />
      {doorLine}
      {connectionLine}
      <NoticeTicket notice={notice} onGo={go} onDismiss={() => update((current) => ({ ...current, notice: null }))} />
      <FootJumps live={history} plate={connection === 'capacity'} />
      <CapacityPlate active={connection === 'capacity'} />
    </>
  );
}
