/**
 * BOOK-DOC-84 §2.1 — the page's one frame dispatcher.
 *
 * Every reader-visible state the server announces lands here, one case per type of the closed
 * frame set. The dispatcher is **pure**: it reads the frame, the state and (for the one fact
 * only the DOM knows — is this chapter on screen) a viewport callback, and answers with the
 * next state plus the side effects the page must run (a refetch where the frame is a trigger
 * by design, a resync after a delivery gap). `App.tsx` keeps the effects and the socket; it
 * keeps no switch of its own, which is what makes every transition assertable without a DOM.
 *
 * §3.2 apply cursors: a frame whose cursor is not newer than the held one is a no-op — a
 * duplicate delivery costs nothing, because the server never replays and the client may.
 * §3.1 the envelope's `seq` is the *delivery* cursor: a gap sends `resync{since}` and the
 * returned `state:snapshot` heals every domain, while the frame itself is still applied.
 *
 * The state itself is `lib/clientState.ts`; this file is the switch and nothing else.
 */

import { landingOf } from './filings.ts';

import {
  type AuthorsCountDto,
  type CascadeProgressPayload,
  type ChangeAdaptedPayload,
  type ChangeDecidedPayload,
  type ChangeProcessingPayload,
  type ChangeQueuedPayload,
  type ChangeStalePayload,
  type ChapterAppliedPayload,
  type ChapterCreatedPayload,
  type ChapterRevisionPayload,
  type CommentAddedPayload,
  type CommentDecisionPayload,
  type EngineStatePayload,
  type Envelope,
  type FilingUpdatePayload,
  type FilingReadingPayload,
  type FrontUpdatedPayload,
  type HelloPayload,
  type HistoryEventFrame,
  type PassAcceptedPayload,
  type PassClosedPayload,
  type PassStageEvent,
  type ServerEventType,
  type StateSnapshotPayload,
  type StateUpdatedPayload,
} from '@book/shared';

import {
  bookFromHello,
  catalogOutOfSync,
  withAuthorsCount,
  withChapterCreated,
  withChapterRevision,
  withFront,
  withState,
} from './bookState.ts';
import { reduceRibbon, ribbonAfterSnapshot, ribbonFromState } from './cascade.ts';
import { withReading } from './readingFrame.ts';
import { nextTitleMotion } from './titleChange.ts';
import { appendStage } from './stages.ts';
const noop = (state: ClientState): FrameResult => ({ state, effects: [] });

/** `true` when the page cannot see the chapter: the reducer never reads the DOM itself. */
const chapterOnScreen = (n: number, viewport: FrameViewport | undefined): boolean =>
  viewport?.chapter === undefined ? true : viewport.chapter(n);

import {
  INITIAL_CURSORS,
  initialClientState,
  laneOf,
  openPassesOf,
  passesOf,
  stagesFromLive,
  revisionOfApplied,
  stateUpdated,
  withLive,
  type AppliedWrite,
  type ChangeLine,
  type ClientState,
  type FrameCursors,
  type FrameEffect,
  type FrameResult,
  type FrameViewport,
  type PageNotice,
} from './clientState.ts';

export {
  INITIAL_CURSORS,
  revisionOfApplied,
  stateUpdated,
  withLive,
  initialClientState,
  laneOf,
  openPassesOf,
  passesOf,
  stagesFromLive,
};
export type { AppliedWrite, ChangeLine, ClientState, FrameCursors, FrameEffect, FrameResult, FrameViewport, PageNotice };

/** The dispatcher: one frame in, the next state and the page's effects out. */
export function applyFrame(
  state: ClientState,
  frame: Envelope<ServerEventType, unknown>,
  viewport?: FrameViewport,
): FrameResult {
  // §3.1 — the delivery cursor. A repeat is not state; a gap asks the hub for one snapshot.
  // `hello` is the one exception: it opens a **new** connection, whose `seq` starts at 0, so it
  // can be lower than the cursor a dead connection left behind — it is applied and becomes the
  // cursor, or the page would ignore the reconnect and every frame after it (BOOK-220 B1).
  const opens = frame.type === 'hello';
  if (!opens && frame.seq <= state.seq) return noop(state);
  const effects: FrameEffect[] = [];
  if (!opens && state.seq > 0 && frame.seq > state.seq + 1) effects.push({ kind: 'resync', since: state.seq });
  const base: ClientState = { ...state, seq: frame.seq };

  switch (frame.type) {
    case 'hello': {
      const hello = frame.data as HelloPayload;
      effects.push(
        { kind: 'refreshChanges' },
        { kind: 'refreshLoaded' },
        { kind: 'refreshComments' },
        { kind: 'noteRecord', event: { kind: 'hello', signedIn: hello.viewer.signedIn } },
      );
      // A reconnect is a new server session: `hello` **is** the snapshot, so it replaces the
      // book, the live block and the stage log (from `live.passes`, never with an empty one).
      const seeded = withLive(
        { ...base, book: bookFromHello(hello, base.book), viewer: hello.viewer, composer: hello.composer },
        hello.live,
      );
      return {
        state: {
          ...seeded,
          revisions: {},
          fresh: null,
          notice: null,
          ribbon: ribbonFromState(hello.state),
          engine: null,
          connection: null,
        },
        effects,
      };
    }
    case 'state:snapshot': {
      const payload = frame.data as StateSnapshotPayload;
      const seeded = withLive({ ...base, connection: null }, payload.live);
      if (base.book === null) {
        return { state: { ...seeded, cursors: { ...seeded.cursors, stateVersion: payload.state.version } }, effects };
      }
      const next = withState(base.book, payload.state);
      if (catalogOutOfSync(next.state, next.catalog)) effects.push({ kind: 'refreshCatalog' });
      return {
        state: {
          ...seeded,
          book: next,
          ribbon: ribbonAfterSnapshot(base.ribbon, payload.state),
          queue: payload.live.queue.pending,
          cursors: { ...seeded.cursors, stateVersion: payload.state.version },
        },
        effects,
      };
    }
    case 'state:updated': {
      const result = stateUpdated(base, frame.data as StateUpdatedPayload, viewport);
      return { state: result.state, effects: [...effects, ...result.effects] };
    }
    case 'chapter:created': {
      const created = frame.data as ChapterCreatedPayload;
      const onScreen = chapterOnScreen(created.n, viewport);
      return {
        state: {
          ...base,
          book: base.book === null ? null : withChapterCreated(base.book, created),
          fresh: created.n,
          notice: onScreen ? base.notice : { kind: 'new', n: created.n },
        },
        effects: [...effects, { kind: 'noteRevision' }],
      };
    }
    case 'chapter:revision': {
      const revision = frame.data as ChapterRevisionPayload;
      if (revision.hseq !== null && revision.hseq <= base.cursors.hseq) return noop(state);
      const onScreen = chapterOnScreen(revision.n, viewport);
      return {
        state: {
          ...base,
          book: base.book === null ? null : withChapterRevision(base.book, revision),
          revisions: { ...base.revisions, [revision.n]: revision },
          notice: onScreen ? base.notice : { kind: 'revised', n: revision.n },
          cursors: { ...base.cursors, hseq: Math.max(base.cursors.hseq, revision.hseq ?? 0) },
        },
        effects: [...effects, { kind: 'noteRevision' }],
      };
    }
    case 'chapter:applied': {
      const applied = frame.data as ChapterAppliedPayload;
      const held = base.applied;
      if (held !== null && held.n === applied.n && held.rev >= applied.rev) return noop(state);
      if (applied.hseq !== null && applied.hseq <= base.cursors.hseq) return noop(state);
      const entry = base.book?.catalog.find((row) => row.n === applied.n);
      const onScreen = chapterOnScreen(applied.n, viewport);
      return {
        state: {
          ...base,
          book: base.book === null ? null : withChapterRevision(base.book, revisionOfApplied(applied, entry?.title ?? null)),
          // The text change goes through the ordinary revision path (the article patches and
          // cross-fades), while the write itself is the print's clock: `applied` is what the
          // article plans the ink from (§4/D2). Nothing here refetches.
          revisions: { ...base.revisions, [applied.n]: revisionOfApplied(applied, entry?.title ?? null) },
          applied: {
            n: applied.n,
            rev: applied.rev,
            appliedAt: applied.appliedAt,
            patch: applied.patch,
            patchTruncated: applied.patchTruncated,
            span: applied.span,
          },
          notice: onScreen ? base.notice : { kind: 'revised', n: applied.n },
          cursors: { ...base.cursors, hseq: Math.max(base.cursors.hseq, applied.hseq ?? 0) },
        },
        effects: [...effects, { kind: 'noteRevision' }],
      };
    }
    case 'front:updated': {
      const front = frame.data as FrontUpdatedPayload;
      const tocVisible = viewport?.toc === undefined ? true : viewport.toc();
      return {
        state: {
          ...base,
          book: base.book === null ? null : withFront(base.book, front),
          titleMotion: nextTitleMotion(base.titleMotion, front),
          notice: tocVisible ? base.notice : { kind: 'front' },
        },
        effects: [...effects, { kind: 'noteRevision' }],
      };
    }
    case 'authors:update': {
      const count = frame.data as AuthorsCountDto;
      return { state: { ...base, book: base.book === null ? null : withAuthorsCount(base.book, count) }, effects };
    }
    case 'change:queued': {
      const queued = frame.data as ChangeQueuedPayload;
      if (queued.eventSeq <= base.cursors.eventSeq) return noop(state);
      return {
        state: {
          ...base,
          lines: {
            ...base.lines,
            [queued.id]: {
              kind: 'queued',
              at: queued.at,
              eventSeq: queued.eventSeq,
              ahead: queued.queue.ahead,
              depth: queued.queue.depth,
              chapter: queued.chapter,
              commentId: queued.source.commentId,
            },
          },
          changeSeq: { ...base.changeSeq, [queued.id]: queued.seq },
          filingChange:
            queued.source.commentId === null ? base.filingChange : { ...base.filingChange, [queued.source.commentId]: queued.id },
          cursors: { ...base.cursors, eventSeq: queued.eventSeq },
          // BOOK-65: an accepted comment appends `change.queued`; the record re-reads it.
          historyTick: base.historyTick + 1,
        },
        effects,
      };
    }
    case 'change:processing': {
      const processing = frame.data as ChangeProcessingPayload;
      if (processing.eventSeq <= base.cursors.eventSeq) return noop(state);
      const book = base.book;
      return {
        state: {
          ...base,
          book:
            book === null
              ? null
              : {
                  ...book,
                  state: {
                    ...book.state,
                    queue: {
                      ...book.state.queue,
                      processing: {
                        id: processing.id,
                        chapter: processing.chapter,
                        startedAt: processing.startedAt,
                        stage: 'processing',
                      },
                    },
                  },
                },
          lines: {
            ...base.lines,
            [processing.id]: {
              kind: 'processing',
              at: processing.at,
              eventSeq: processing.eventSeq,
              ahead: processing.queue.ahead,
              attempt: processing.attempt,
            },
          },
          ribbon: reduceRibbon(base.ribbon, { type: 'change:processing', data: processing }),
          cursors: { ...base.cursors, eventSeq: processing.eventSeq },
        },
        // BOOK-206 audit B1 — the writer claimed the change: the filing that caused it moves from
        // «ждёт» to «идёт» now, not on the next comment frame. A claim is not a landing, so the
        // text and the edition line are untouched.
        effects: [...effects, { kind: 'refreshComments', chapter: processing.chapter }],
      };
    }
    case 'change:adapted': {
      const adapted = frame.data as ChangeAdaptedPayload;
      if (adapted.eventSeq <= base.cursors.eventSeq) return noop(state);
      return {
        state: {
          ...base,
          lines: {
            ...base.lines,
            [adapted.id]: {
              kind: 'adapted',
              at: adapted.at,
              eventSeq: adapted.eventSeq,
              intent: adapted.intent,
              reason: adapted.reason,
            },
          },
          cursors: { ...base.cursors, eventSeq: adapted.eventSeq },
        },
        effects,
      };
    }
    case 'change:stale': {
      const stale = frame.data as ChangeStalePayload;
      if (stale.eventSeq <= base.cursors.eventSeq) return noop(state);
      return {
        state: {
          ...base,
          lines: {
            ...base.lines,
            [stale.id]: {
              kind: 'stale',
              at: stale.at,
              eventSeq: stale.eventSeq,
              grade: stale.grade,
              evidence: stale.evidence,
              options: stale.options,
            },
          },
          cursors: { ...base.cursors, eventSeq: stale.eventSeq },
        },
        effects,
      };
    }
    case 'change:decided': {
      const decided = frame.data as ChangeDecidedPayload;
      if (decided.eventSeq <= base.cursors.eventSeq) return noop(state);
      return {
        state: {
          ...base,
          lines: {
            ...base.lines,
            [decided.id]: { kind: 'decided', at: decided.at, eventSeq: decided.eventSeq, payload: decided },
          },
          ribbon: reduceRibbon(base.ribbon, { type: 'change:decided', data: decided }),
          cursors: { ...base.cursors, eventSeq: decided.eventSeq },
        },
        effects: [
          ...effects,
          { kind: 'noteRecord', event: { kind: 'frame', type: 'change:decided', data: decided } },
          { kind: 'landFrame', data: decided },
          // BOOK-206 audit B1 — `chapters[0]` is the change's own chapter; a payload that names
          // none re-reads the thread alone, which is still the durable truth for the row.
          { kind: 'refreshComments', chapter: decided.chapters[0] },
        ],
      };
    }
    case 'pass:accepted': {
      const accepted = frame.data as PassAcceptedPayload;
      return { state: { ...base, accepted: { ...base.accepted, [accepted.stepId]: accepted } }, effects };
    }
    case 'pass:stage': {
      const event = frame.data as PassStageEvent;
      if (event.stageSeq <= (base.cursors.stage[event.passId] ?? 0)) return noop(state);
      return {
        state: {
          ...base,
          stages: appendStage(base.stages, event),
          cursors: { ...base.cursors, stage: { ...base.cursors.stage, [event.passId]: event.stageSeq } },
        },
        // BOOK-206 audit B1 — a landed pass published a revision the site's watcher never sees,
        // so the page takes the pair a landing takes: the chapter's filings, the catalog (a
        // chapter's `rev` makes its slot fetch the prose again) and the edition line. Every other
        // stage is the log's own story.
        effects:
          event.stage === 'landed'
            ? [
                ...effects,
                { kind: 'refreshComments', chapter: event.chapter },
                { kind: 'refreshCatalog' },
                { kind: 'noteRevision' },
              ]
            : effects,
      };
    }
    case 'pass:closed': {
      const closed = frame.data as PassClosedPayload;
      return { state: { ...base, passes: { ...base.passes, [closed.stepId]: closed } }, effects };
    }
    case 'filing:reading':
      // §10.1 — the reading's own fold and its domain cursor live in `readingFrame.ts`.
      return withReading(base, frame.data as FilingReadingPayload);
    case 'filing:update': {
      const update = frame.data as FilingUpdatePayload;
      if (update.at <= (base.cursors.filing[update.commentId] ?? 0)) return noop(state);
      // BOOK-220 M1 — the frame is a broadcast and `live.filings` is the viewer's own list: a
      // filing the page does not hold is somebody else's, and the own list is seeded by
      // `hello`/`state:snapshot` alone. An unknown id moves the delivery cursor and nothing
      // else — never a row, never a read of `/api/me/filings` by another reader's filing.
      if (!base.filings.some((filing) => filing.commentId === update.commentId)) return { state: base, effects };
      return {
        state: {
          ...base,
          filings: base.filings.map((filing) =>
            filing.commentId === update.commentId
              ? {
                  ...filing,
                  state: update.state,
                  attempts: update.attempts,
                  attemptsLeft: update.attemptsLeft,
                  changeId: update.changeId,
                }
              : filing,
          ),
          filingUpdates: { ...base.filingUpdates, [update.commentId]: update },
          cursors: { ...base.cursors, filing: { ...base.cursors.filing, [update.commentId]: update.at } },
        },
        effects,
      };
    }
    case 'comment:added': {
      const payload = frame.data as CommentAddedPayload;
      const dto = payload.comment;
      if (typeof dto !== 'object' || dto === null) {
        // An older server's frame is only a trigger: the register re-reads its own page.
        return { state: base, effects: [...effects, { kind: 'refreshComments', chapter: payload.chapter }] };
      }
      if (base.added.some((row) => row.id === dto.id)) return noop(state);
      return { state: { ...base, added: [dto, ...base.added] }, effects };
    }
    case 'comment:decision': {
      const decision = frame.data as CommentDecisionPayload;
      return {
        state: {
          ...base,
          attemptsLeft: { ...base.attemptsLeft, [decision.id]: decision.attemptsLeft },
          decisions: { ...base.decisions, [decision.id]: decision },
        },
        effects: [
          ...effects,
          { kind: 'noteRecord', event: { kind: 'frame', type: 'comment:decision', data: decision } },
          { kind: 'noteDecision', data: decision },
          { kind: 'refreshComments', chapter: decision.chapter },
          // BOOK-219 — a landing frame carries the receipt of the text it moved, so the page reads
          // the text again on the path every text frame takes: the catalog (a chapter's `rev` is
          // what makes its slot fetch the prose) and the edition line. A refusal names none.
          ...(landingOf(decision) === null ? [] : [{ kind: 'refreshCatalog' as const }, { kind: 'noteRevision' as const }]),
        ],
      };
    }
    case 'feedback:batch':
      return { state: base, effects: [...effects, { kind: 'refreshComments' }] };
    case 'cascade:progress': {
      const progress = frame.data as CascadeProgressPayload;
      return {
        state: { ...base, ribbon: reduceRibbon(base.ribbon, { type: 'cascade:progress', data: progress }) },
        effects,
      };
    }
    case 'engine:state':
      return { state: { ...base, engine: frame.data as EngineStatePayload }, effects };
    case 'history:event': {
      const tick = frame.data as HistoryEventFrame;
      return { state: { ...base, historyTick: tick.hseq > 0 ? base.historyTick + 1 : base.historyTick }, effects };
    }
    case 'error': {
      const payload = frame.data as { code?: unknown } | null;
      const code = typeof payload?.code === 'string' ? payload.code : 'ERROR';
      return { state: { ...base, connection: code }, effects };
    }
    case 'pong':
      // Transport liveness, not state: the `seq` above is the whole of it.
      return { state: base, effects };
    default:
      return { state: base, effects };
  }
}
