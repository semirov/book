/**
 * BOOK-DOC-84 §2.2/§3.2 — the page's client state, and the two facts its frames keep.
 *
 * The shape lives apart from the dispatcher (`frames.ts`) so that both files stay one subject:
 * here the state, its apply cursors and the live block's own fold (the open passes, the stage
 * backlog, the lane); there one case per frame. `frames.ts` re-exports all of it, so a caller
 * imports `applyFrame` and the state from one place.
 */

import {
  STAGE_DEADLINE_MS,
  type ChangeDecidedPayload,
  type CommentAddedPayload,
  type EngineStatePayload,
  type ChapterAppliedPayload,
  type ChapterRevisionPayload,
  type ComposerInfo,
  type FilingUpdatePayload,
  type LiveFiling,
  type LivePass,
  type LivePayload,
  type PassAcceptedPayload,
  type PassClosedPayload,
  type PassStageEvent,
  type QueuePendingDto,
  type StateSnapshot,
  type StateUpdatedPayload,
  type ViewerDto,
} from '@book/shared';

import { catalogOutOfSync, withState, type BookData } from './bookState.ts';
import { ribbonAfterSnapshot, type Ribbon } from './cascade.ts';
import type { ReaderRecordEvent } from './ownDecisions.ts';
import { IDLE_TITLE, type TitleMotion } from './titleChange.ts';
import { appendStage, inFlightOf, type StagesLog } from './stages.ts';

/** A block a pass wrote, as `chapter:applied` and `live.applied` both carry it. */
export type AppliedWrite = Pick<
  ChapterAppliedPayload,
  'n' | 'rev' | 'appliedAt' | 'patch' | 'patchTruncated' | 'span'
>;

/** The page's notice ticket; a structural copy so `lib/` never imports a component. */
export type PageNotice = { kind: 'new'; n: number } | { kind: 'revised'; n: number } | { kind: 'front' };

/** One change's last line on the page: the queue place, the narrowed intent, the answer. */
export type ChangeLine =
  | { kind: 'queued'; at: number; eventSeq: number; ahead: number; depth: number }
  | { kind: 'processing'; at: number; eventSeq: number; ahead: number; attempt: number }
  | { kind: 'adapted'; at: number; eventSeq: number; intent: string; reason: string }
  | { kind: 'stale'; at: number; eventSeq: number; grade: string; evidence: string[]; options: string[] }
  | { kind: 'decided'; at: number; eventSeq: number; payload: ChangeDecidedPayload };

/** §3.2 — the per-domain apply cursors, monotonic, in the payload. */
export type FrameCursors = {
  /** `chapter:applied`/`chapter:revision`'s `hseq` (a revision log entry). */
  hseq: number;
  /** The snapshot's `state.version`. */
  stateVersion: number;
  /** `(passId, stageSeq)` — one number per pass: a stage is monotonic inside it. */
  stage: Readonly<Record<string, number>>;
  /** `change_events.id` — the change domain's cursor. */
  eventSeq: number;
  /** `(commentId, at)` — the filing domain's cursor. */
  filing: Readonly<Record<string, number>>;
};

export type ClientState = {
  book: BookData | null;
  viewer: ViewerDto;
  composer: ComposerInfo | null;
  ribbon: Ribbon | null;
  revisions: Readonly<Record<number, ChapterRevisionPayload>>;
  fresh: number | null;
  notice: PageNotice | null;
  titleMotion: TitleMotion;
  /** The stage backlog (`pass:stage`), seeded by `hello`/snapshot from `live.passes`. */
  stages: StagesLog;
  /** §2.2 — the last `live` block: open passes, the queue, the viewer's own filings, the lane. */
  live: LivePayload | null;
  /** The write inside its print window; `null` until a frame or a snapshot names one. */
  applied: AppliedWrite | null;
  /** The lane's waiting filings from the snapshot (the 10 s poll is gone). */
  queue: readonly QueuePendingDto[];
  /** The viewer's own filings (`hello.live.filings`), updated in place by `filing:update`. */
  filings: readonly LiveFiling[];
  /** The viewer's own filing rows from `filing:update`, by comment id (the trail's patch). */
  filingUpdates: Readonly<Record<string, FilingUpdatePayload>>;
  /** Thread rows `comment:added` inserted: no refetch, the DTO is the row. */
  added: readonly CommentAddedPayload['comment'][];
  /** `comment:decision.attemptsLeft`, by comment id. */
  attemptsLeft: Readonly<Record<string, number>>;
  /** The change feed's own lines, by change id. */
  lines: Readonly<Record<string, ChangeLine>>;
  /** A pass's outcome, by step id (`pass:closed`). */
  passes: Readonly<Record<string, PassClosedPayload>>;
  /** A draft/premise step's claim (`pass:accepted`), by step id. */
  accepted: Readonly<Record<string, PassAcceptedPayload>>;
  /** The engine's reason line (`engine:state`), never a toast. */
  engine: EngineStatePayload | null;
  /** «связь: <code>» — the `error` frame's state line. */
  connection: string | null;
  historyTick: number;
  /** §3.1 the last delivery cursor applied. */
  seq: number;
  cursors: FrameCursors;
};

export type FrameEffect =
  | { kind: 'resync'; since: number }
  | { kind: 'refreshCatalog' }
  | { kind: 'refreshComments'; chapter?: number }
  | { kind: 'refreshChanges' }
  | { kind: 'refreshLoaded' }
  | { kind: 'noteRevision' }
  | { kind: 'noteRecord'; event: ReaderRecordEvent }
  | { kind: 'noteDecision'; data: unknown }
  | { kind: 'landFrame'; data: ChangeDecidedPayload };

export type FrameResult = { state: ClientState; effects: FrameEffect[] };

/** What the page knows that the reducer cannot: is this chapter on screen. */
export type FrameViewport = {
  chapter?: (n: number) => boolean;
  toc?: () => boolean;
};

export const INITIAL_CURSORS: FrameCursors = Object.freeze({
  hseq: 0,
  stateVersion: 0,
  stage: {},
  eventSeq: 0,
  filing: {},
});

export function initialClientState(book: BookData | null = null): ClientState {
  return {
    book,
    viewer: { signedIn: false, displayName: null },
    composer: null,
    ribbon: null,
    revisions: {},
    fresh: null,
    notice: null,
    titleMotion: IDLE_TITLE,
    stages: {},
    live: null,
    applied: null,
    queue: [],
    filings: [],
    filingUpdates: {},
    added: [],
    attemptsLeft: {},
    lines: {},
    passes: {},
    accepted: {},
    engine: null,
    connection: null,
    historyTick: 0,
    seq: 0,
    cursors: INITIAL_CURSORS,
  };
}

/** `hello`/snapshot: the open passes become stage events, never an emptied log (§3.3). */
export function stagesFromLive(passes: readonly LivePass[]): StagesLog {
  let log: StagesLog = {};
  for (const pass of passes) {
    if (typeof pass.chapter !== 'number') continue;
    log = appendStage(log, {
      passId: pass.passId,
      chapter: pass.chapter,
      stageSeq: pass.stageSeq,
      stage: pass.stage as PassStageEvent['stage'],
      at: pass.since,
      actor: { process: 'engine', model: null },
      changeId: pass.changeId,
      summary: '',
      span: null,
      tokens: null,
      costUsd: null,
    });
  }
  return log;
}

/**
 * The passes that are open now: the snapshot's own list, plus a claim or a stage this page
 * heard after it, minus a pass whose terminal `pass:closed` arrived. Newest first.
 */
export function openPassesOf(state: ClientState): LivePass[] {
  const held = new Map<string, LivePass>();
  for (const pass of state.live?.passes ?? []) held.set(pass.passId, pass);
  for (const [passId, claim] of Object.entries(state.accepted)) {
    if (held.has(passId)) continue;
    held.set(passId, {
      chapter: claim.chapter,
      passId,
      changeId: claim.premiseChangeId,
      lane: claim.lane,
      stage: claim.pass,
      stageSeq: 0,
      since: claim.at,
      deadlineAt: claim.at + STAGE_DEADLINE_MS,
    });
  }
  for (const [passId, events] of Object.entries(state.stages)) {
    const open = held.get(passId);
    if (open === undefined) continue;
    const latest = [...events].sort((left, right) => left.stageSeq - right.stageSeq).at(-1);
    if (latest === undefined) continue;
    held.set(passId, {
      ...open,
      stage: latest.stage,
      stageSeq: latest.stageSeq,
      since: latest.at,
      deadlineAt: latest.at + STAGE_DEADLINE_MS,
    });
  }
  for (const [stepId, closed] of Object.entries(state.passes)) {
    // `holds`/`refused` are parks (the pass ended for now); every recorded close ends the open
    // pass a reader sees, so the head never claims work the engine has already booked.
    if (closed.outcome !== 'escalated') held.delete(stepId);
  }
  return [...held.values()].sort((left, right) => right.since - left.since);
}

/** The chapters a pass is working on right now: the page's `passActive` fact. */
export function workingChapters(state: ClientState): ReadonlySet<number> {
  const set = new Set<number>();
  for (const pass of openPassesOf(state)) {
    if (typeof pass.chapter === 'number') set.add(pass.chapter);
  }
  return set;
}

/** The stage log's own chapter → pass fold, for the surfaces that still read it. */
export function passesOf(state: ClientState): ReturnType<typeof inFlightOf> {
  return inFlightOf(state.stages);
}

/** The lane's day, as `hello.live.lane` / the snapshot's `state.lane` carry it. */
export function laneOf(state: ClientState): LivePayload['lane'] | null {
  if (state.live !== null) return state.live.lane;
  return state.book?.state.lane ?? null;
}

/** One `chapter:revision` shape built from an applied write: the catalog merge reads it. */
export function revisionOfApplied(applied: ChapterAppliedPayload, title: string | null): ChapterRevisionPayload {
  return {
    n: applied.n,
    rev: applied.rev,
    hseq: applied.hseq,
    title,
    chars: applied.chars,
    delta: applied.delta,
    kind: applied.kind,
    cause: {
      changeId: applied.cause.changeId,
      cascadeId: applied.cause.cascadeId,
      wave: null,
      lane: applied.cause.lane,
      direction: applied.cause.direction,
      stepId: applied.cause.stepId,
      seamsIn: [],
      seamsOut: [],
    },
    patch: applied.patch,
    patchTruncated: applied.patchTruncated,
    attributed: applied.attributed,
    updatedAt: applied.createdAt,
  };
}

/** §2.2: one `live` block, applied by both of its carriers. */
export function withLive(state: ClientState, live: LivePayload): ClientState {
  const stage: Record<string, number> = { ...state.cursors.stage };
  for (const pass of live.passes) stage[pass.passId] = Math.max(stage[pass.passId] ?? 0, pass.stageSeq);
  return {
    ...state,
    live,
    queue: live.queue.pending,
    filings: live.filings,
    applied: live.applied,
    stages: stagesFromLive(live.passes),
    cursors: { ...state.cursors, stage },
  };
}

const noop = (state: ClientState): FrameResult => ({ state, effects: [] });

export function stateUpdated(
  state: ClientState,
  snapshot: StateUpdatedPayload,
  viewport: FrameViewport | undefined,
): FrameResult {
  void viewport;
  if (state.book === null) return noop(state);
  if (snapshot.version < state.book.state.version) return noop(state);
  const next = withState(state.book, snapshot as StateSnapshot);
  const effects: FrameEffect[] = [];
  if (catalogOutOfSync(next.state, next.catalog)) effects.push({ kind: 'refreshCatalog' });
  return {
    state: {
      ...state,
      book: next,
      ribbon: ribbonAfterSnapshot(state.ribbon, snapshot),
      queue: snapshot.queue.pending ?? state.queue,
      cursors: { ...state.cursors, stateVersion: snapshot.version },
    },
    effects,
  };
}
