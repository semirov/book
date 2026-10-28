/**
 * WebSocket protocol seam (ARCHITECTURE.md §10).
 *
 * One envelope, one place. The text of a chapter is **never** in a frame (ADR-004):
 * `chapter:created` carries metadata and a `fetch` hint, `chapter:revision` a block patch.
 * A reader socket is read-only (ADR-005): it may send `ping` and `resync`, nothing else.
 *
 * M2 implements `hello`, `state:snapshot`, `state:updated`, `chapter:created`,
 * `chapter:revision`, `front:updated`, `cursor:moved`, `block:revising`, `presence`,
 * `pong` and `error`. The engine events (`change:*`, `cascade:progress`, `engine:state`)
 * are declared here because M3–M4 emit them and a second, divergent envelope would be
 * the defect this file exists to prevent; their **payloads** live in `publicChange.ts`,
 * the site-facing projection that carries no gate fact (§6B.6).
 */

import type { AuthorsCountDto } from './authors.ts';
import type { CatalogEntry, Lane, StateSnapshot } from './types.ts';
import type { ComposerInfo } from './comment.ts';
import type { Direction, Part } from './book.ts';

/** The envelope version. Bumped only by an incompatible frame shape. */
export const ENVELOPE_VERSION = 1;

/** The protocol revision named in `hello` (§10.3). */
export const PROTOCOL_VERSION = 3;

export type ServerEventType =
  | 'hello'
  | 'state:snapshot'
  | 'state:updated'
  | 'chapter:created'
  | 'chapter:revision'
  | 'block:revising'
  | 'cursor:moved'
  | 'front:updated'
  /** The live byline count: a reader's text survived a revision or was erased (BOOK-DOC-4). */
  | 'authors:update'
  | 'change:queued'
  | 'change:processing'
  | 'change:stale'
  | 'change:decided'
  | 'cascade:progress'
  | 'engine:state'
  | 'comment:added'
  | 'comment:decision'
  | 'feedback:batch'
  | 'history:event'
  /** One writer-lane stage (docs/writer-lane.md §3); the payload is a `PassStageEvent`. */
  | 'pass:stage'
  | 'presence'
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
  /** All 67 slots, written or not: an empty slot is the normal state, not a 404. */
  catalog: CatalogEntry[];
  state: StateSnapshot;
  /** Metadata only, and only when a chapter is in flight; the text is fetched over REST. */
  currentChapter: { n: number; lane: Lane; kind: string; title: string | null } | null;
  comments: { open: number };
};

export type StateChangeReason = 'file' | 'engine' | 'cascade' | 'comment' | 'lane' | 'manual';

/** `state:updated` is the whole snapshot minus catalog, plus why it changed. */
export type StateUpdatedPayload = StateSnapshot & { reason: StateChangeReason };

export type StateSnapshotPayload = { state: StateSnapshot; reason?: StateChangeReason };

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
  part: Part;
  direction: Direction;
  cause: ChapterCause;
  fetch: { path: string; etag: string };
  createdAt: string;
  attributed: boolean;
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

export type CursorMovedPayload = {
  lane: Lane;
  chapter: number;
  blockId: string | null;
  blockIndex: number | null;
  kind: 'draft';
  state: 'writing' | 'resting';
  at: string;
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

// ── client frames ──────────────────────────────────────────────────────────

export type ClientEvent =
  | { type: 'ping'; data: { t: number } }
  | { type: 'resync'; data: { since?: number } };

export type PongPayload = { t: number; serverTime: string };

export type ErrorPayload = { code: string; message: string; retryAfterMs?: number };

export type PresencePayload = { viewers: number; peak: number };
