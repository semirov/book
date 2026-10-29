/**
 * WebSocket protocol seam (ARCHITECTURE.md §10, BOOK-DOC-84).
 *
 * One envelope, one place. The text of a chapter is **never** in a frame (ADR-004):
 * `chapter:created` carries metadata and a `fetch` hint, `chapter:revision` a block patch, and
 * `chapter:applied` the write's own bounded delta plus its span — the print's clock (BOOK-220).
 * A reader socket is read-only (ADR-005): it may send `ping` and `resync`, nothing else.
 *
 * **The frame set is closed (BOOK-DOC-84 §2.1): 25 types.** Every reader-visible state has a
 * frame or a `live` entry; `FRAME_REGISTRY` names the emitter and the handler of each one, so a
 * type that is declared but never emitted (or never read) is a failing test, not a habit. Three
 * types were deleted with the design: `block:revising` (the state is `state.revising`),
 * `cursor:moved` (the state is `state.current`) and `presence` (never emitted, never read).
 */

import type { AuthorsCountDto } from './authors.ts';
import type { CatalogEntry, Lane, StateSnapshot } from './types.ts';
import type { ComposerInfo } from './comment.ts';
import type { Direction, Part } from './book.ts';
import type { StageSpan } from './stage.ts';

/** The envelope version. Bumped only by an incompatible frame shape. */
export const ENVELOPE_VERSION = 1;

/** The protocol revision named in `hello` (§10.3). 4 — BOOK-DOC-84's frame set. */
export const PROTOCOL_VERSION = 4;

export type ServerEventType =
  | 'hello'
  | 'state:snapshot'
  | 'state:updated'
  | 'chapter:created'
  | 'chapter:revision'
  /** BOOK-DOC-84 D1: a pass's text write — the print's only clock. */
  | 'chapter:applied'
  | 'front:updated'
  /** The live byline count: a reader's text survived a revision or was erased (BOOK-DOC-4). */
  | 'authors:update'
  | 'change:queued'
  | 'change:processing'
  /** BOOK-DOC-84 #11: relevance narrowed the intent; the narrowed intent is public. */
  | 'change:adapted'
  | 'change:stale'
  | 'change:decided'
  /** BOOK-DOC-84 #14: a draft/premise step was claimed (a change's claim is `change:processing`). */
  | 'pass:accepted'
  /** One writer-lane stage; the payload is a `PassStageEvent`. */
  | 'pass:stage'
  /** BOOK-DOC-84 #16: the pass closed with its outcome and its own sentence. */
  | 'pass:closed'
  /** BOOK-DOC-84 #17: a filing's own row — accepted, refused, held, expired, quarantined. */
  | 'filing:update'
  | 'comment:added'
  | 'comment:decision'
  | 'feedback:batch'
  | 'cascade:progress'
  | 'engine:state'
  | 'history:event'
  | 'error'
  | 'pong';

export type Envelope<T extends ServerEventType = ServerEventType, P = unknown> = {
  v: typeof ENVELOPE_VERSION;
  type: T;
  /** Per-connection, strictly increasing; a gap means "resynchronise", never "ignore". */
  seq: number;
  /** ISO-8601 UTC. */
  ts: string;
  data: P;
};

/**
 * One line of the frame registry (BOOK-DOC-84 §6, the fitness function).
 *
 * `emitter` is the server function that emits the frame; `handler` the client function that
 * applies it, or `null` for a transport frame that has no surface by design (only `pong`).
 * The registry is the protocol's own contract: `site/server/test/protocolRegistry.test.ts`
 * refuses a `ServerEventType` that is missing from it, a transport mark anywhere but `pong`,
 * or an emitter that does not appear in `server/src`.
 */
export type FrameRegistryEntry = {
  emitter: string;
  handler: string | null;
  transport?: true;
};

export const FRAME_REGISTRY: Record<ServerEventType, FrameRegistryEntry> = {
  hello: { emitter: 'ws/hub.ts → helloPayload', handler: 'lib/frames.ts → hello' },
  'state:snapshot': { emitter: 'ws/hub.ts → publishSnapshot', handler: 'lib/frames.ts → snapshot' },
  'state:updated': { emitter: 'engineState/bridge.ts → tick', handler: 'lib/frames.ts → stateUpdated' },
  'chapter:created': { emitter: 'engineState/bridge.ts → drainRevisions', handler: 'lib/frames.ts → chapterCreated' },
  'chapter:revision': { emitter: 'engineState/bridge.ts → drainRevisions', handler: 'lib/frames.ts → chapterRevision' },
  'chapter:applied': {
    emitter: 'engineState/bridge.ts → drainRevisions',
    handler: 'lib/appliedPrint.ts → useApplied',
  },
  'front:updated': { emitter: 'engineState/bridge.ts → drainFront', handler: 'lib/frames.ts → frontUpdated' },
  'authors:update': { emitter: 'ingest/watcher.ts → emitAuthors', handler: 'lib/frames.ts → authorsUpdate' },
  'change:queued': { emitter: 'engineState/bridge.ts → drainChanges', handler: 'lib/frames.ts → changeQueued' },
  'change:processing': {
    emitter: 'engineState/bridge.ts → drainChanges',
    handler: 'lib/frames.ts → changeProcessing',
  },
  'change:adapted': { emitter: 'engineState/bridge.ts → drainChanges', handler: 'lib/frames.ts → changeAdapted' },
  'change:stale': { emitter: 'engineState/bridge.ts → drainChanges', handler: 'lib/frames.ts → changeStale' },
  'change:decided': { emitter: 'engineState/bridge.ts → drainChanges', handler: 'lib/frames.ts → changeDecided' },
  'pass:accepted': { emitter: 'engineState/bridge.ts → drainPasses', handler: 'lib/frames.ts → passAccepted' },
  'pass:stage': { emitter: 'stages/tailer.ts → poll', handler: 'lib/frames.ts → passStage' },
  'pass:closed': { emitter: 'engineState/bridge.ts → drainPasses', handler: 'lib/frames.ts → passClosed' },
  'filing:update': { emitter: 'feedback/decisions.ts → apply', handler: 'lib/frames.ts → filingUpdate' },
  'comment:added': { emitter: 'comments/service.ts → post', handler: 'lib/frames.ts → commentAdded' },
  'comment:decision': { emitter: 'feedback/decisions.ts → apply', handler: 'lib/frames.ts → commentDecision' },
  'feedback:batch': { emitter: 'feedback/decisions.ts → announceBatches', handler: 'lib/frames.ts → feedbackBatch' },
  'cascade:progress': { emitter: 'engineState/bridge.ts → flushProgress', handler: 'lib/frames.ts → cascadeProgress' },
  'engine:state': { emitter: 'engineState/bridge.ts → narrateEngine', handler: 'lib/frames.ts → engineState' },
  'history:event': { emitter: 'engineState/bridge.ts → drainHistory', handler: 'lib/frames.ts → historyEvent' },
  error: { emitter: 'ws/hub.ts → onMessage', handler: 'lib/frames.ts → connectionLine' },
  // Transport liveness, not state: it has no surface, and its `seq` keeps the gap detector honest.
  pong: { emitter: 'ws/hub.ts → onMessage', handler: null, transport: true },
};

// ── hello and state ─────────────────────────────────────────────────────────

export type HelloLimits = {
  commentsPerHour: number;
  /** The note body cap (`COMMENT_MAX_CHARS`), not the intervention cap. */
  maxCommentChars: number;
  /** BOOK-DOC-4 rule 1: the cap for a reader's proposed wording (`EDIT_MAX_CHARS`). */
  maxEditChars: number;
  queueSoftCap: number;
  maxConnections: number;
  perIp: number;
  /** §14: the SPEC's edit budget, one per day per identity (SPEC «Load & network»). */
  editSubmissionsPerDay: number;
  /**
   * BOOK-DOC-4 rule 3 / BOOK-59: the wave bound a ripple is bound by. It is one, so a surface
   * prints a wave number only for a second wave, and never prints the bound beside it.
   */
  maxWave: number;
};

export type HelloPayload = {
  connId: string;
  protocolVersion: number;
  serverTime: string;
  limits: HelloLimits;
  /** Resolved from the session cookie at upgrade; anonymous readers stay `false`. */
  viewer: { signedIn: boolean; displayName: string | null };
  /** What the composer needs before it is opened; the widget itself is lazy (§12.8). */
  composer: ComposerInfo;
  front: {
    title: string | null;
    about: string | null;
    rev: number;
    imprint: { author: string; copyright: string };
    /** The title page's byline count, so a reconnect heals it without a second request. */
    authors: AuthorsCountDto;
    /** BOOK-126: the footer's gift link, already validated at boot; absent/null = no row. */
    donateUrl?: string | null;
  };
  /** All `TOTAL_CHAPTERS` slots, written or not: an empty slot is the normal state, not a 404. */
  catalog: CatalogEntry[];
  state: StateSnapshot;
  /**
   * BOOK-DOC-84 §2.2: the live block. `hello` **is** the connect-time snapshot, so a reader who
   * joins mid-pass gets the open stages, the queue and the viewer's own filings in one frame —
   * never an empty log that only the next stage row fills.
   */
  live: LivePayload;
  /** Metadata only, and only when a chapter is in flight; the text is fetched over REST. */
  currentChapter: { n: number; lane: Lane; kind: string; title: string | null } | null;
  comments: { open: number };
};

export type StateChangeReason = 'file' | 'engine' | 'cascade' | 'comment' | 'lane' | 'manual';

/** `state:updated` is the whole snapshot minus catalog, plus why it changed. */
export type StateUpdatedPayload = StateSnapshot & { reason: StateChangeReason };

/**
 * `state:snapshot` — a full snapshot with the same `live` block `hello` carries, and `since`
 * echoing the client's `resync` request. It is the only heal path: the hub keeps no
 * per-connection buffer, and the snapshot is complete for everything a surface shows.
 */
export type StateSnapshotPayload = { state: StateSnapshot; live: LivePayload; reason?: StateChangeReason; since?: number };

// ── the live block (§2.2: one builder, two carriers) ───────────────────────

/** A pass may not be clocked closer than this: a stage's deadline is its own `since` + bound. */
export const STAGE_DEADLINE_MS = 480_000;
/** The print's window (D5): an older write is simply there, never replay: a `live.applied` older
 *  than this is not carried at all, and a fresh page cannot join a print it cannot see. */
export const LIVE_APPLIED_WINDOW_MS = 6_000;
/** A `live.applied` larger than this is omitted: a big rewrite cross-fades anyway (§2.2). */
export const LIVE_APPLIED_MAX_BYTES = 8 * 1024;
/** The viewer's own filings carried by the live block (`hello`, `state:snapshot`). */
export const LIVE_FILINGS_MAX = 20;

export type LivePass = {
  /** `'front'` for the title pass, which has no chapter number. */
  chapter: number | 'front';
  passId: string;
  changeId: string | null;
  lane: Lane | null;
  /** The last stage the pass reached; `queued` before the writer's first row. */
  stage: string;
  stageSeq: number;
  /** ms epoch of that stage (the step's `at` for `queued`). */
  since: number;
  /** `since + STAGE_DEADLINE_MS`: an open pass past it is «сейчас тихо», not «работает». */
  deadlineAt: number;
};

export type LiveApplied = {
  n: number;
  rev: number;
  appliedAt: number;
  patch: PatchOp[];
  patchTruncated: boolean;
  span: StageSpan[] | null;
};

export type LiveQueue = {
  depth: number;
  pending: Array<{ id: string; chapter: number; seq: number; ahead: number; kind: string; enqueuedAt: string }>;
};

export type LiveFiling = {
  commentId: string;
  chapter: number;
  state: string;
  attempts: number;
  attemptsLeft: number;
  changeId: string | null;
  at: string;
};

export type LiveLane = {
  passesToday: number;
  maxPasses: number;
  writerAt: string | null;
};

export type LivePayload = {
  /** ISO-8601 UTC, the moment the block was built. */
  at: string;
  /** Every open pass, with its stage — the backlog a mid-pass joiner needs. */
  passes: LivePass[];
  /** The write inside its print window and small enough to print; `null` otherwise. */
  applied: LiveApplied | null;
  queue: LiveQueue;
  /** The viewer's own filings, newest first, ≤ `LIVE_FILINGS_MAX`. */
  filings: LiveFiling[];
  lane: LiveLane;
};

// ── chapter events ─────────────────────────────────────────────────────────

export type ChapterCause = {
  kind: 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep' | 'operator' | 'restore';
  lane: Lane | null;
  leaseId: string | null;
  changeId: string | null;
  cascadeId: string | null;
  stepId: string | null;
};

export type ChapterCreatedPayload = {
  n: number;
  title: string | null;
  rev: number;
  chars: number;
  /** Part 1..4, or null for the opening and the finale, which stand outside the parts. */
  part: Part | null;
  direction: Direction;
  cause: ChapterCause;
  fetch: { path: string; etag: string };
  createdAt: string;
  attributed: boolean;
};

/**
 * The snapshot's `state.revising` entry, as a slot renders it. BOOK-DOC-84 deleted the
 * `block:revising` **frame** (it had no emitter); the mark's carrier is the snapshot field, and
 * this type is the shape `ChapterList`/`ChapterProse` already took as a prop.
 */
export type BlockRevisingPayload = {
  n: number;
  active: boolean;
  blockIds: string[];
  cause: 'draft' | 'cascade';
  changeId: string | null;
  lane: Lane | null;
  since: string;
  expiresAt: string;
};

export type PatchOp = {
  op: 'insert' | 'remove' | 'replace';
  /** The block id in the previous revision (`replace`/`remove`). */
  id: string;
  /** Position in the new revision for `insert`/`replace`; in the old one for `remove`. */
  i: number;
  /** The id in the new revision for `insert`/`replace`. */
  newId?: string;
  /** The new text for `insert`/`replace`. */
  text?: string;
};

export type ChapterRevisionPayload = {
  n: number;
  rev: number;
  /** §3.2 — the log entry that produced the revision: the apply cursor of this domain. */
  hseq: number | null;
  /**
   * Line 1 of the file, re-parsed on every write: a retitled chapter updates the TOC
   * without a second request (§6C.3).
   */
  title: string | null;
  chars: number;
  delta: number;
  kind: 'create' | 'edit' | 'rewrite' | 'polish' | 'restore';
  cause: {
    changeId: string | null;
    cascadeId: string | null;
    wave: number | null;
    lane: Lane | null;
    direction: Direction | null;
    stepId: string | null;
    seamsIn: Array<{ boundary: number | 'front' | 'ending'; reason: string }>;
    seamsOut: Array<{ boundary: number | 'front' | 'ending'; reason: string }>;
  };
  patch: PatchOp[];
  patchTruncated: boolean;
  attributed: boolean;
  updatedAt: string;
};

/**
 * BOOK-DOC-84 D1 — the write, at the moment the revision is created. `appliedAt` is the
 * write's own wall clock in ms (the revision's `at`), never the pass's `landed.at`: the pass
 * closes minutes after the text is live, and clocking the ink from the close is the 6 s–12 min
 * lie the design removes. `patch`/`span` are derived from the revision snapshots of `rev` and
 * `rev − 1` (rev 1 has no pre-image: a create is `before: ''`), capped at 96 KB; an unreadable
 * pre-image is `patchTruncated: true, span: null` and the page prints nothing rather than a guess.
 */
export type ChapterAppliedPayload = {
  n: number;
  rev: number;
  /** §3.2 — `revisions.hseq`: the apply cursor of the revision domain. */
  hseq: number | null;
  appliedAt: number;
  createdAt: string;
  kind: 'create' | 'edit' | 'rewrite' | 'polish' | 'restore';
  cause: {
    stepId: string | null;
    changeId: string | null;
    cascadeId: string | null;
    lane: Lane | null;
    direction: Direction | null;
  };
  patch: PatchOp[];
  patchTruncated: boolean;
  span: StageSpan[] | null;
  chars: number;
  delta: number;
  blocksTouched: number;
  attributed: boolean;
};

// ── the first sheet ────────────────────────────────────────────────────────

export type FrontUpdatedPayload = {
  title: string | null;
  about: string | null;
  rev: number;
  previousRev: number;
  /** A front revision may change the title alone; page 2 changes only on an owner edit (BOOK-7). */
  cause: { kind: string; changeId: string | null; cascadeId: string | null; stepId: string | null };
};

// ── passes (§2.1 #14, #16) ─────────────────────────────────────────────────

/** The pass vocabulary the reader's page names; `sweep` is an operator pass, never announced. */
export type PassKind = 'draft' | 'change' | 'cascade' | 'front' | 'ending';

/**
 * BOOK-DOC-84 #14 — a draft/premise step was claimed. A change's claim is `change:processing`;
 * this frame is what fills the queue wait the state table measured as 0 s – 1 256 s.
 */
export type PassAcceptedPayload = {
  stepId: string;
  chapter: number;
  lane: Lane | null;
  pass: PassKind;
  premiseChangeId: string | null;
  at: number;
  /** Pending filings older than this pass's own change; 0 for a draft/premise step. */
  ahead: number;
};

/**
 * BOOK-DOC-84 #16 — the pass closed. `outcome` is read from the step's own recorded outcome,
 * and `refused` is the writer's own `refused` stage on that pass (a park), not a guess.
 */
export type PassClosedPayload = {
  stepId: string;
  changeId: string | null;
  chapter: number | null;
  pass: PassKind;
  outcome: 'closed' | 'holds' | 'refused' | 'escalated' | 'interrupted' | 'gone';
  /** The writer's own one-liner (the step's note), `''` when it left none. */
  sentence: string;
  at: number;
  /** The engine recorded an interrupted close: the pass did not land its own close. */
  closeFailed: boolean;
  /** The pass's ledger row (`pass_spend.usd`), `null` when it was never priced. */
  costUsd: number | null;
  tokens: { in: number; out: number } | null;
};

// ── filings (§2.1 #17) ─────────────────────────────────────────────────────

export type FilingState = 'new' | 'accepted' | 'refused' | 'held' | 'expired' | 'quarantined' | 'registered';

/**
 * BOOK-DOC-84 #17 — the reader's own filing, framed. It replaces the thread refetch and the
 * `GET /api/me/filings` mount-only trail: the attempt counter and the held/expired state are
 * state with a frame, never a fetch-only fact (D6).
 */
export type FilingUpdatePayload = {
  commentId: string;
  chapter: number;
  state: FilingState;
  attempts: number;
  attemptsLeft: number;
  changeId: string | null;
  at: number;
};

/** BOOK-DOC-84 #11 — relevance narrowed the intent; `intent` is the narrowed text. */
export type ChangeAdaptedPayload = {
  id: string;
  chapter: number;
  intent: string;
  reason: string;
  at: number;
  eventSeq: number;
};

// ── client frames ──────────────────────────────────────────────────────────

export type ClientEvent =
  | { type: 'ping'; data: { t: number } }
  | { type: 'resync'; data: { since?: number } };

export type PongPayload = { t: number; serverTime: string };

export type ErrorPayload = { code: string; message: string; retryAfterMs?: number };
