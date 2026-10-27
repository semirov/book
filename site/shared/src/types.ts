/**
 * Wire types shared by the server, the SPA and (later) the engine CLI.
 * Sources: ARCHITECTURE.md §7.1 (StateSnapshot), §9 (HTTP API), §8 (data model).
 */

import type { AuthorsCountDto } from './authors.ts';
import type { Direction, Part } from './book.ts';
import type { HistoryStateDto } from './history.ts';

/** `absent` — no engine process has ever written a heartbeat (§9, §18). */
export type EngineStatus = 'running' | 'throttled' | 'paused' | 'escalated' | 'down' | 'absent' | 'unknown';
export type Phase = 'draft' | 'reweiter' | 'polish' | 'complete';
export type Lane = 'forward' | 'backward';
export type SeamState = 'not_reached' | 'open' | 'verified' | 'failed';

export type CascadeWingState = 'waiting' | 'moving' | 'settled' | 'stopped';

/**
 * One wing of a ripple, as the ribbon and the focus view draw it. A wing is **data**: it is
 * computed from the cascade's recorded steps, so a wing that never opened reports `waiting`
 * and no reached chapters — there is never a ring for a ripple that did not run.
 */
export type CascadeWingDto = {
  /** The furthest chapter this wing reached; the origin while it has not moved. */
  frontier: number;
  /** The wing's own last wave; 0 while it has not opened a step. */
  wave: number;
  state: CascadeWingState;
  /** Chapters this wing reached, origin excluded, nearest first. */
  reached: number[];
};

/** `down` runs toward chapter 1, `up` toward chapter 67. */
export type CascadeWingsDto = { down: CascadeWingDto; up: CascadeWingDto };

export type DraftCursor = {
  lane: Lane;
  from: number;
  to: number;
  /** Last chapter this lane drafted; null before the first one. */
  cursor: number | null;
  /** The chapter this lane would draft next. */
  next: number | null;
  status: 'idle' | 'writing' | 'resting' | 'done' | 'waiting' | 'starved';
  lastPassAt: string | null;
  lastPass: { wrote: number | null } | null;
};

export type StateSnapshot = {
  /** Monotonic; clients ignore older snapshots. */
  version: number;
  at: string;
  engine: {
    status: EngineStatus;
    heartbeatAt: string | null;
    laneId: string | null;
  };
  phase: Phase;
  /**
   * The first sheet as the site last read it (§7.1): the cover title and page 2.
   * `rev: 0` means the file is absent — the site never invents a title or a blurb.
   */
  front: {
    title: string | null;
    about: string | null;
    rev: number;
    updatedAt: string | null;
  };
  chapters: {
    /** Always 67 — the book's invariant, served explicitly so the UI never hardcodes it silently. */
    total: number;
    /** Ascending chapter numbers with at least one block. */
    written: number[];
    /** The explicit complement — the UI draws its slots from this. */
    empty: number[];
    count: number;
    totalChars: number;
    /**
     * Slots that hold only their basis sentence (ch01 opens with the frozen frame, ch67 closes
     * with it): they are not written, count no characters, and the reader still sees that one
     * paragraph (BOOK-6). A subset of `empty`, never of `written`.
     */
    basis: number[];
  };
  cursors: { forward: DraftCursor; backward: DraftCursor };
  /**
   * The live table of contents (§6C.7): derived on every change, exactly 67 entries.
   * `title: null` is an empty slot or an untitled chapter — the UI labels it «Глава N».
   */
  toc: TocEntry[];
  meeting: {
    forwardFront: number | null;
    backwardFront: number | null;
    gap: number;
    converged: boolean;
    seam: SeamState;
  };
  cascade: null | {
    id: string;
    changeId: string;
    /** The chapter the change landed in; the ribbon's origin tick (§11.7). */
    origin?: number;
    wave: number;
    frontier: { forward: number | null; backward: number | null };
    /** Both wings as recorded so far: each frontier, its wave, its state and what it reached. */
    wings: CascadeWingsDto;
    touched: number[];
    /** The subset of `touched` actually written. Empty until the engine exists (M3). */
    rewritten?: number[];
    seams?: Array<{ boundary: number | 'front' | 'ending'; reason: string }>;
    /** The direction of the step in flight; `null` when the cascade is at rest. */
    wing?: 'downward' | 'upward' | null;
    lane: Lane | null;
    /** The chapter being written; `'front'` when a title step holds the lane. */
    stepChapter: number | 'front' | null;
    startedAt: string;
    budget: { steps: number; maxSteps: number; deadline: string };
  };
  queue: {
    depth: number;
    byState: { pending: number; processing: number; stale: number; escalated: number; done24h: number };
    head: null | { id: string; chapter: number; enqueuedAt: string; waitMs: number };
    processing: null | { id: string; chapter: number; startedAt: string; stage: string };
    lastDecidedAt: string | null;
  };
  revising: Array<{
    chapter: number;
    blockIds: string[];
    cause: 'draft' | 'cascade';
    changeId: string | null;
    since: string;
    expiresAt: string;
  }>;
  current: null | {
    lane: Lane;
    /** `'front'` is the title caret in the TOC, not a caret in the prose (§7.2 rule 6). */
    chapter: number | 'front';
    kind: 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep';
    blockId: string | null;
    blockIndex: number | null;
    since: string;
  };
  unresolved: Array<{
    boundary: number | 'front' | 'ending';
    reason: 'origin' | 'ending' | 'oscillation' | 'budget' | 'delta' | 'finding' | 'gate_timeout';
    changeId: string | null;
    since: string;
    /** The writer's one clause for the seam, public; never a gate finding (§11.7). */
    note?: string | null;
  }>;
  activity: {
    lastFileChangeAt: string | null;
    lastEngineEventAt: string | null;
    lastLogLineAt: string | null;
    source: 'files' | 'engine' | 'mixed';
  };
  /**
   * BOOK-56 — the one derived fact every history surface reads (chronicle, cascade,
   * provenance, revision apparatus, authors, discussion). Computed from
   * `changes.source_comment IS NOT NULL`; while `live` is false those surfaces are not
   * rendered at all, rather than hidden.
   */
  history: HistoryStateDto;
};

/** One row of `GET /api/chapters` — all 67 slots, always. */
export type CatalogEntry = {
  n: number;
  /** TOC volume 1..4 — pure numbering, no narrative meaning (§6C.1). */
  part: Part;
  /** Line 1 of the file; null for an empty slot or an untitled chapter (§6C.3). */
  title: string | null;
  rev: number;
  chars: number;
  blocks: number;
  written: boolean;
  /**
   * The slot holds only its basis sentence (ch01/ch67, BOOK-6): one paragraph of the frozen
   * frame, served like prose but never written prose. `basis` is true exactly when the
   * reader must see that paragraph while `written` stays false and `chars` stays 0.
   */
  basis: boolean;
  writtenAt: string | null;
  updatedAt: string | null;
  /** Which lane drafted the chapter; says nothing about who may revise it (§9). */
  direction: Direction;
};

/** One TOC entry; the TOC is derived on every state change and never stored (§6C.7). */
export type TocEntry = {
  part: Part;
  n: number;
  title: string | null;
  written: boolean;
  rev: number;
};

/** `GET /api/front` — the whole front matter in one call (§6C.2, §9). */
export type FrontDto = {
  /** `00-front.md` line 1; null when the file is missing or its title line is malformed. */
  title: string | null;
  /** «о чём эта книга»; null when the first sheet is malformed (page 2 renders nothing, §11.8). */
  about: string | null;
  /** Hash of `about` as published — the basis a leased pass is compared against (BOOK-7). */
  aboutSha256?: string | null;
  rev: number;
  toc: TocEntry[];
  imprint: { author: string; copyright: string };
  /** The title page's byline count, measured server-side (BOOK-DOC-4); always present. */
  authors: AuthorsCountDto;
};

export type BlockDto = {
  id: string;
  /** Position in the current revision. */
  i: number;
  text: string;
  hash: string;
};

/** `GET /api/chapters/:n` — 404 for an unwritten slot that holds no basis sentence. */
export type ChapterDto = {
  n: number;
  /** Chapter title from line 1; null when the writer omitted it (F022 is a commit gate). */
  title: string | null;
  rev: number;
  /** Written prose only: a basis-only slot serves its paragraph with `chars: 0` (BOOK-6). */
  chars: number;
  /** True when the whole chapter is its basis sentence: prose to read, not a written chapter. */
  basis: boolean;
  blocks: BlockDto[];
  writtenAt: string;
  updatedAt: string;
};

export type ApiErrorBody = {
  code: string;
  message: string;
  retryAfterMs?: number;
};

/**
 * `GET /healthz` — liveness only, and the watcher/engine state a reader's page can show.
 * Counts, the version and the lane's holder are operator facts: they leak how busy the book
 * is and who holds the pen, so they live behind the admin token (audit m4).
 */
export type HealthDto = {
  ok: boolean;
  watcher: { lastTickAt: string | null; lastEventAt: string | null; missing: boolean };
  engine: { status: EngineStatus };
};

/** `GET /api/admin/health` — the operator's half of the health, token-guarded (§17). */
export type AdminHealthDto = {
  uptimeMs: number;
  version: string;
  lane: { holder: string | null };
  front: { present: boolean };
  db: { chapters: number; comments: number };
  engine: { status: EngineStatus; heartbeatAt: string | null };
};

