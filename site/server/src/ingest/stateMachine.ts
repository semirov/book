/**
 * Derive `StateSnapshot` from text facts (ARCHITECTURE.md §7.1–7.2), pure and testable.
 *
 * M0/M2 have no engine: the journal overlay is empty, so the snapshot honestly reports
 * `engine.status = 'unknown'` and an empty queue (ADR-003 degraded mode). M3 fills the
 * overlay; the shape and rules 1–3, 9–12 stay exactly as they are.
 */

import {
  BACKWARD_FIRST,
  FORWARD_LAST,
  TOTAL_CHAPTERS,
  allChapterNumbers,
  isChapterNumber,
  partOf,
  type DraftCursor,
  type StateSnapshot,
  type TocEntry,
} from '@book/shared';

import type { EngineOverlay } from '../engineState/reader.ts';

/** A chapter as the projection knows it. Only chapters with at least one block count as written. */
export type ChapterFact = {
  n: number;
  rev: number;
  title: string | null;
  chars: number;
  blocks: number;
  writtenAt: string;
  updatedAt: string;
};

/** The first sheet as it was last read (§6C.2); absent means the cover has no title yet. */
export type FrontFact = {
  title: string | null;
  about: string | null;
  rev: number;
  updatedAt: string | null;
};

export const EMPTY_FRONT: FrontFact = { title: null, about: null, rev: 0, updatedAt: null };

export type DeriveInput = {
  facts: ChapterFact[];
  now: Date;
  version: number;
  front?: FrontFact;
  /** Slots that hold only their basis sentence (ch01/ch67); a subset of `empty` (BOOK-6). */
  basis?: number[];
  /** Engine facts (queue, ripple, unresolved seams, live lease); absent in degraded mode. */
  overlay?: EngineOverlay;
  /**
   * BOOK-56 — how many changes the log holds that a reader caused
   * (`changes.source_comment IS NOT NULL`). Zero keeps every history surface off; machine
   * revisions do not raise it.
   */
  readerChanges?: number;
  /**
   * The log holds its first record (`firstEventAt(db) !== null`). It makes the chronicle
   * exist from the book's start — one record, «начало книги» — while every other history
   * surface still waits for a reader change.
   */
  started?: boolean;
};

/**
 * Everything the snapshot derives from the files and the engine's rows. The money is **not**
 * derived here: BOOK-117 keeps it in one ledger reader (`budget.ts`), so `StateService` adds the
 * `budget` block to this projection — the state machine stays a function of the book.
 */
export type ProjectedState = Omit<StateSnapshot, 'budget'>;

export function deriveState(input: DeriveInput): ProjectedState {
  const facts = [...input.facts].filter((fact) => fact.blocks > 0).sort((a, b) => a.n - b.n);
  const readerChanges = Math.max(0, Math.trunc(input.readerChanges ?? 0));
  // A reader change is a record too, so it starts the chronicle even if the caller did not say
  // so; the log's first row is the other, smaller way for a book to have begun.
  const started = readerChanges > 0 || input.started === true;
  const written = facts.map((fact) => fact.n);
  const writtenSet = new Set(written);
  const empty = allChapterNumbers().filter((n) => !writtenSet.has(n));
  const basis = [...new Set(input.basis ?? [])]
    .filter((n) => isChapterNumber(n) && !writtenSet.has(n))
    .sort((a, b) => a - b);
  const totalChars = facts.reduce((sum, fact) => sum + fact.chars, 0);

  const forwardFront = written.filter((n) => n <= FORWARD_LAST).at(-1) ?? null;
  const backwardFront = written.filter((n) => n >= BACKWARD_FIRST).at(0) ?? null;

  const haveBothFronts = forwardFront !== null && backwardFront !== null;
  const gap = haveBothFronts ? Math.max(0, backwardFront - forwardFront - 1) : TOTAL_CHAPTERS - facts.length;
  // Adjacent (33|34) or overlapping (34|34) fronts have gap 0. ARCHITECTURE §7.2 rule 3
  // spells the test as `forwardFront + 1 >= backwardFront - 1`, which would call a
  // one-chapter hole "converged"; the prose ("adjacent or overlapping") and the gap
  // itself are the definition used here.
  const converged = haveBothFronts && gap === 0;

  const lastFileChangeAt =
    facts
      .map((fact) => fact.updatedAt)
      .sort()
      .at(-1) ?? null;

  return {
    version: input.version,
    at: input.now.toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    engine: input.overlay?.engine ?? { status: 'unknown', heartbeatAt: null, laneId: null },
    phase: 'draft',
    front: input.front ?? EMPTY_FRONT,
    chapters: {
      total: TOTAL_CHAPTERS,
      written,
      empty,
      count: facts.length,
      totalChars,
      basis,
    },
    cursors: {
      forward: cursorFor('forward', forwardFront),
      backward: cursorFor('backward', backwardFront),
    },
    toc: buildToc(facts),
    meeting: {
      forwardFront,
      backwardFront,
      gap: Math.max(0, gap),
      converged,
      seam: converged ? 'open' : 'not_reached',
    },
    cascade: input.overlay?.cascade ?? null,
    queue: input.overlay?.queue ?? {
      depth: 0,
      byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
      head: null,
      processing: null,
      lastDecidedAt: null,
    },
    revising: [],
    current: input.overlay?.current ?? null,
    unresolved: input.overlay?.unresolved ?? [],
    activity: {
      lastFileChangeAt,
      lastEngineEventAt: input.overlay?.engine.heartbeatAt ?? null,
      lastLogLineAt: null,
      source: input.overlay === undefined ? 'files' : 'mixed',
    },
    history: {
      live: readerChanges > 0,
      readerChanges,
      started,
    },
  };
}

/** Exactly 67 entries, always (§7.2 rule 11); `title` comes only from a chapter's line 1. */
export function buildToc(facts: readonly ChapterFact[]): TocEntry[] {
  const byNumber = new Map(facts.filter((fact) => fact.blocks > 0).map((fact) => [fact.n, fact]));
  return allChapterNumbers().map((n) => {
    const fact = byNumber.get(n);
    return {
      part: partOf(n),
      n,
      title: fact?.title ?? null,
      written: fact !== undefined,
      rev: fact?.rev ?? 0,
    };
  });
}

function cursorFor(lane: 'forward' | 'backward', front: number | null): DraftCursor {
  const from = lane === 'forward' ? 1 : TOTAL_CHAPTERS;
  const to = lane === 'forward' ? FORWARD_LAST : BACKWARD_FIRST;
  const next =
    front === null ? from : lane === 'forward' ? (front < FORWARD_LAST ? front + 1 : null) : front > BACKWARD_FIRST ? front - 1 : null;
  return {
    lane,
    from,
    to,
    cursor: front,
    next,
    // Degraded mode: files say what exists, not whether a lane is running.
    status: 'idle',
    lastPassAt: null,
    lastPass: null,
  };
}

/**
 * Fingerprint of everything that changes the snapshot except `version` and `at`
 * (§7.2 rule 10). Titles and the first sheet are included: a retitled chapter and a
 * rewritten annotation are changes a reader must see. `basis` is included too: a slot that
 * gains or loses its basis sentence changes what the page shows (BOOK-6).
 */
export function stateFingerprint(
  facts: ChapterFact[],
  front: FrontFact = EMPTY_FRONT,
  engine = '',
  basis: readonly number[] = [],
  readerChanges = 0,
  started = false,
): string {
  return JSON.stringify({
    chapters: [...facts]
      .sort((a, b) => a.n - b.n)
      .map((fact) => [fact.n, fact.rev, fact.title, fact.chars, fact.blocks, fact.updatedAt]),
    front: [front.rev, front.title, front.about, front.updatedAt],
    basis: [...basis].sort((a, b) => a - b),
    engine,
    // BOOK-56: the first reader change changes what the page renders, so the snapshot it
    // serves must not be the cached one.
    readerChanges,
    // …and so does the first record in the log: it is the chronicle's one starting record,
    // so a begun book renders a surface an empty one does not.
    started,
  });
}
