/**
 * Wire types shared by the server, the SPA and (later) the engine CLI.
 * Sources: ARCHITECTURE.md §7.1 (StateSnapshot), §9 (HTTP API), §8 (data model).
 */

import type { Direction } from './chapters.ts';

export type EngineStatus = 'running' | 'throttled' | 'paused' | 'escalated' | 'down' | 'unknown';
export type Phase = 'draft' | 'reweiter' | 'polish' | 'complete';
export type Lane = 'forward' | 'backward';
export type SeamState = 'not_reached' | 'open' | 'verified' | 'failed';

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
  chapters: {
    /** Always 67 — the book's invariant, served explicitly so the UI never hardcodes it silently. */
    total: number;
    /** Ascending chapter numbers with at least one block. */
    written: number[];
    /** The explicit complement — the UI draws its slots from this. */
    empty: number[];
    count: number;
    totalChars: number;
  };
  cursors: { forward: DraftCursor; backward: DraftCursor };
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
    wave: number;
    frontier: { forward: number | null; backward: number | null };
    touched: number[];
    lane: Lane | null;
    stepChapter: number | null;
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
    chapter: number;
    kind: 'draft' | 'cascade' | 'seam' | 'sweep';
    blockId: string | null;
    blockIndex: number | null;
    since: string;
  };
  unresolved: Array<{
    boundary: number;
    reason: 'origin' | 'edge' | 'oscillation' | 'budget' | 'seam';
    changeId: string | null;
    since: string;
  }>;
  activity: {
    lastFileChangeAt: string | null;
    lastEngineEventAt: string | null;
    lastLogLineAt: string | null;
    source: 'files' | 'engine' | 'mixed';
  };
};

/** One row of `GET /api/chapters` — all 67 slots, always. */
export type CatalogEntry = {
  n: number;
  rev: number;
  chars: number;
  blocks: number;
  written: boolean;
  writtenAt: string | null;
  updatedAt: string | null;
  direction: Direction;
  line: number;
};

export type BlockDto = {
  id: string;
  /** Position in the current revision. */
  i: number;
  text: string;
  hash: string;
};

/** `GET /api/chapters/:n` — 404 for an unwritten slot. */
export type ChapterDto = {
  n: number;
  rev: number;
  chars: number;
  blocks: BlockDto[];
  writtenAt: string;
  updatedAt: string;
};

export type ApiErrorBody = {
  code: string;
  message: string;
  retryAfterMs?: number;
};

export type HealthDto = {
  ok: boolean;
  uptimeMs: number;
  version: string;
  watcher: { lastTickAt: string | null; lastEventAt: string | null };
  engine: { status: EngineStatus; heartbeatAt: string | null };
  lane: { holder: string | null };
  db: { chapters: number; comments: number };
};
