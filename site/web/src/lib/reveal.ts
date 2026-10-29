/**
 * The printing reveal (ARCHITECTURE.md §11.5, ADR-006; BOOK-220 §11.2): a client-side
 * performance over a finished file. The server ships complete blocks; the client animates only
 * what is new to this reader, in the viewport, at the book's own pace.
 *
 * **One clock.** This module decides *which* blocks print and *in what order*; the schedule is
 * the print engine's (`lib/printPlan.ts`) — the same 30 cps desk / 26 cps phone base, the same
 * seeded ±25 % jitter, the same word-end ×1.4 and punctuation pauses, the same hesitations, the
 * same runaway guard and **no duration cap**. A block reveals exactly its graphemes whose ink
 * time has come; `startAt` is absolute, so a page that mounts inside a chapter's print joins the
 * current frame instead of replaying it from zero (the owner's rule: «новая глава так же
 * пишется»).
 *
 * Everything here is pure so the pacing rules can be tested without a browser.
 */

import type { BlockDto, ChapterDto } from '@book/shared';

import { PRINT, countUntil, deviceCps, planPrint } from './printPlan.ts';

export const REVEAL = {
  /** Animate only within [scrollTop − 1.5vh, scrollTop + 2.5vh]. */
  animateWithinPx: 1.5,
  /** A chapter younger than this on join prints only its tail. */
  tailOnlyOnJoinMs: 5 * 60_000,
  tailBlocks: 8,
} as const;

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('ru', { granularity: 'grapheme' })
    : null;

/** Grapheme clusters, never half a surrogate pair or a stranded combining mark. */
export function graphemes(text: string): string[] {
  if (segmenter === null) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function graphemeCount(text: string): number {
  return segmenter === null ? Array.from(text).length : Array.from(segmenter.segment(text)).length;
}

export type RevealBlockLike = { id: string; text: string };

export type RevealPlanInput = {
  blocks: readonly RevealBlockLike[];
  /**
   * `live`: the chapter arrived while the reader is here → print its opening.
   * `join`: the reader opened an existing chapter → print only a young chapter's tail.
   * `change`: a revision a reader caused landed (BOOK-117 §1) → print only what it touched.
   */
  mode: 'live' | 'join' | 'change';
  /**
   * `change`: the blocks the revision added or replaced. Everything else in the chapter is
   * already set, so only these reach the queue.
   */
  changedIds?: ReadonlySet<string>;
  chapterAgeMs: number;
  /** Blocks intersecting the viewport; default is every block. */
  visibleIds?: ReadonlySet<string>;
  reducedMotion?: boolean;
  tailBlocks?: number;
  tailOnlyOnJoinMs?: number;
};

export type RevealPlan = {
  /** In document order; the caller prints them one after another. */
  queued: string[];
  /** Everything else appears at once and never prints. */
  instant: string[];
};

export function planReveal(input: RevealPlanInput): RevealPlan {
  const all = input.blocks.map((block) => block.id);
  if (input.reducedMotion === true) return { queued: [], instant: all };

  const visible = input.visibleIds;
  const isVisible = (id: string): boolean => visible === undefined || visible.has(id);

  let candidates: readonly RevealBlockLike[] = [];
  if (input.mode === 'change') {
    // A change writes only where it wrote: the rest of the chapter is already final.
    const changed = input.changedIds ?? new Set<string>();
    // Every block the change touched prints, in document order: a print is not a sample.
    candidates = input.blocks.filter((block) => changed.has(block.id));
  } else if (input.mode === 'live') {
    // A chapter being written prints from its first character, block after block, no cap.
    candidates = input.blocks;
  } else if (input.chapterAgeMs <= (input.tailOnlyOnJoinMs ?? REVEAL.tailOnlyOnJoinMs)) {
    const tail = input.tailBlocks ?? REVEAL.tailBlocks;
    candidates = input.blocks.slice(Math.max(0, input.blocks.length - tail));
  }

  const queued = candidates.filter((block) => isVisible(block.id)).map((block) => block.id);
  const queuedSet = new Set(queued);
  return { queued, instant: all.filter((id) => !queuedSet.has(id)) };
}

/**
 * BOOK-117 §1 — whether a revision must be **printed** rather than cross-faded.
 *
 * `cause.changeId` is the evidence that a reader's intervention landed: those revisions
 * (`edit`, `polish`, `create`) are typed through `planReveal({ mode: 'change' })`. A cascade
 * or a rewrite is machinery — `changeId` is null — and keeps the cross-fade `patch.ts` gives
 * it. The rule is pure so the two callers (the patch and the refetch it falls back to) can
 * never disagree about the same frame.
 */
export function printsChange(revision: {
  kind: string;
  cause: { changeId: string | null };
}): boolean {
  if (revision.cause.changeId === null) return false;
  return revision.kind === 'edit' || revision.kind === 'polish' || revision.kind === 'create';
}

export type RevealBlockState = {
  id: string;
  text: string;
  clusters: string[];
  /** The print engine's schedule for this block, ms from its own first grapheme. */
  inkTimes: readonly number[];
  /** Where the block starts inside the queue (the blocks print one after another). */
  offsetMs: number;
  revealed: number;
  done: boolean;
  /** The block was outside the print's window: it is set at once and never prints. */
  skipped: boolean;
  /** The block's own end (`inkTimes`' last step), or the cover's sheet budget. No cap of prose. */
  durationMs: number;
};

export type RevealState = {
  blocks: RevealBlockState[];
  /** Index of the printing block; `-1` when the queue is empty or complete. */
  active: number;
  /** Time since the queue's own zero — the number `at()` is written in. */
  elapsedMs: number;
  reducedMotion: boolean;
  /**
   * A chapter being written (`startAt` was given): it prints whole, in document order, and the
   * page-load economy of skipping what the reader cannot see does not apply to it.
   */
  print: boolean;
};

export type RevealOptions = {
  reducedMotion?: boolean;
  /** The device's rate: 30 cps on a desk, 26 in the hand (default 30). */
  cps?: number;
  /**
   * The queue's own clock, absolute epoch ms (`chapter:applied.appliedAt` for a chapter being
   * written). A mount inside the print joins at `now − startAt`, never at zero.
   */
  startAt?: number;
  now?: number;
  /**
   * The cover title sheet's own budget (BOOK-DOC-49 §3): a constant of that sequence, not a
   * print and not prose. When the natural schedule is longer, its ink times are scaled to fit.
   */
  capBlockMs?: number;
  /** A seed mixed into every block's own: the same block prints the same way on a reload. */
  seed?: string;
};

/** Recompute the queue at one instant: `revealed` is the engine's count for that block. */
function at(state: RevealState, elapsedMs: number): RevealState {
  // Reduced motion has no clock: every block is the final text from the first paint.
  if (state.reducedMotion) return state;
  const elapsed = Math.max(0, elapsedMs);
  const blocks = state.blocks.map((block) => {
    if (block.skipped || block.clusters.length === 0) {
      return block.skipped && block.done ? block : { ...block, revealed: block.clusters.length, done: true };
    }
    const local = elapsed - block.offsetMs;
    const revealed = local <= 0 ? 0 : countUntil(block.inkTimes, local);
    return {
      ...block,
      revealed,
      done: local >= block.durationMs || revealed >= block.clusters.length,
    };
  });
  const active = blocks.findIndex((block) => !block.done);
  return { ...state, blocks, elapsedMs: elapsed, active: active === -1 ? -1 : active };
}

/**
 * The queue, each block on the print engine's clock. Sequential: block n starts where block n−1
 * ends, so the chapter is written in reading order.
 */
export function createReveal(queued: readonly RevealBlockLike[], options: RevealOptions = {}): RevealState {
  const reducedMotion = options.reducedMotion === true;
  const cps = options.cps ?? PRINT.cps.desktop;
  let offset = 0;
  const blocks = queued.map((block) => {
    const clusters = graphemes(block.text);
    const empty = clusters.length === 0;
    const schedule = planPrint({
      kind: 'insertion',
      before: '',
      after: block.text,
      cps,
      seed: `${options.seed ?? ''}${block.id}`,
      reducedMotion,
    });
    let inkTimes = empty ? [] : schedule.inkTimes;
    let durationMs = empty ? 0 : schedule.totalMs;
    if (!empty && options.capBlockMs !== undefined && durationMs > options.capBlockMs) {
      // The sheet's own budget: the ink times are scaled, never a second engine.
      const scale = options.capBlockMs / durationMs;
      inkTimes = inkTimes.map((time) => time * scale);
      durationMs = options.capBlockMs;
    }
    const state: RevealBlockState = {
      id: block.id,
      text: block.text,
      clusters,
      inkTimes,
      offsetMs: offset,
      revealed: reducedMotion ? clusters.length : 0,
      done: reducedMotion || empty,
      skipped: false,
      durationMs,
    };
    offset += durationMs;
    return state;
  });
  const start: RevealState = {
    blocks,
    active: reducedMotion || blocks.length === 0 ? -1 : 0,
    elapsedMs: 0,
    reducedMotion,
    print: options.startAt !== undefined,
  };
  if (reducedMotion || options.startAt === undefined) return start;
  // Joining a print that is already running: the queue is fast-forwarded to its own clock.
  return at(start, (options.now ?? Date.now()) - options.startAt);
}

/** Advance the queue by `deltaMs` of the book's clock (one rAF step, one write). */
export function tickReveal(state: RevealState, deltaMs: number): RevealState {
  if (state.active < 0 || deltaMs <= 0) return state;
  return at(state, state.elapsedMs + deltaMs);
}

/** Blocks outside the viewport appear at once: printing is only for what the reader sees. */
export function skipBlocks(state: RevealState, ids: ReadonlySet<string>): RevealState {
  if (ids.size === 0 || state.active < 0) return state;
  const targets = state.blocks.filter((block) => ids.has(block.id) && !block.skipped && !block.done);
  if (targets.length === 0) return state;
  const blocks = state.blocks.map((block) =>
    ids.has(block.id) ? { ...block, skipped: true, revealed: block.clusters.length, done: true } : { ...block },
  );
  // A skipped block takes no time: the blocks after it move up to where it began.
  let offset = 0;
  for (const block of blocks) {
    block.offsetMs = offset;
    offset += block.durationMs;
  }
  return at({ ...state, blocks }, state.elapsedMs);
}

/** «Показать сразу»: every queued block is complete, the caret disappears. */
export function finishReveal(state: RevealState): RevealState {
  if (state.active < 0 && state.blocks.every((block) => block.done)) return state;
  return {
    ...state,
    blocks: state.blocks.map((block) => ({ ...block, revealed: block.clusters.length, done: true })),
    active: -1,
    elapsedMs: 0,
  };
}

export function revealComplete(state: RevealState): boolean {
  return state.active < 0;
}

/** Text of a printing block, or its full text when it is not in the queue. */
export function blockText(reveal: RevealState, id: string, fullText: string): string {
  const queued = reveal.blocks.find((block) => block.id === id);
  if (queued === undefined) return fullText;
  return queued.clusters.slice(0, queued.revealed).join('');
}

/** The block currently receiving characters, for the caret and «показать сразу». */
export function activeBlockId(reveal: RevealState): string | null {
  return reveal.blocks[reveal.active]?.id ?? null;
}

/** `BlockDto` is what the reveal consumes; kept here so components do not restate it. */
export type ChapterBlock = Pick<BlockDto, 'id' | 'text'>;

/** The device's rate for the reveal at one width (the same function the clip renderer reads). */
export function revealCps(width: number): number {
  return deviceCps(width);
}

/**
 * The reveal a chapter's arrival deserves, decided in one place (`startReveal` in the
 * article): `changed` means a change (`BOOK-117 §1`), `live` a chapter being written now, and
 * otherwise a join — which is a page load, not a print: only a young chapter's tail is typed.
 * `startAt` is the print's clock (`chapter:applied.appliedAt`); reduced motion sets everything
 * at once.
 */
export function chapterReveal(
  loaded: Pick<ChapterDto, 'blocks' | 'writtenAt'>,
  options: {
    fresh: boolean;
    live?: boolean;
    changed?: ReadonlySet<string> | null;
    reducedMotion?: boolean;
    now?: number;
    startAt?: number;
    cps?: number;
  },
): RevealState {
  const reduced = options.reducedMotion === true;
  const now = options.now ?? Date.now();
  // A basis slot served before its chapter exists has no written moment (`null`, BOOK-187 AC3);
  // it counts as just written, the way an unreadable `writtenAt` always has.
  const writtenAt = loaded.writtenAt === null ? Number.NaN : Date.parse(loaded.writtenAt);
  const ageMs = Number.isNaN(writtenAt) ? 0 : now - writtenAt;
  const plan = planReveal({
    blocks: loaded.blocks,
    mode: options.changed == null ? (options.fresh || options.live === true ? 'live' : 'join') : 'change',
    changedIds: options.changed ?? undefined,
    chapterAgeMs: Math.max(0, ageMs),
    reducedMotion: reduced,
  });
  const queued = loaded.blocks.filter((block) => plan.queued.includes(block.id));
  return createReveal(queued, {
    reducedMotion: reduced,
    cps: options.cps,
    startAt: options.startAt,
    now,
  });
}
