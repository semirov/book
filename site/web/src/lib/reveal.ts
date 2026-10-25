/**
 * The printing reveal (ARCHITECTURE.md §11.5, ADR-006): a client-side performance over a
 * finished file. The server ships complete blocks; the client animates only what is new
 * to this reader, in the viewport, at a human pace.
 *
 * Everything here is pure so the pacing rules can be tested without a browser:
 * `planReveal` decides what prints, `tickReveal` advances the queue by grapheme clusters.
 */

import type { BlockDto } from '@book/shared';

export const REVEAL = {
  /** Characters per second ≈ 180 wpm of printed prose. */
  cps: 18,
  minBlockMs: 260,
  maxBlockMs: 2_600,
  /** Animate only within [scrollTop − 1.5vh, scrollTop + 2.5vh]. */
  animateWithinPx: 1.5,
  /** Drain the queue at 8× when the reader scrolls away. */
  offscreenSpeedUp: 8,
  /** A chapter younger than this on join prints only its tail. */
  tailOnlyOnJoinMs: 5 * 60_000,
  tailBlocks: 8,
  /** A 25 000-character chapter is ~200 blocks; print the first 12, the rest instantly. */
  maxQueueBlocks: 12,
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `clamp(len / cps, min, max)` in milliseconds, divided by the current speed. */
export function blockDurationMs(text: string, speed = 1): number {
  const speedFactor = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const raw = (graphemeCount(text) / REVEAL.cps) * 1_000;
  return clamp(raw, REVEAL.minBlockMs, REVEAL.maxBlockMs) / speedFactor;
}

export type RevealBlockLike = { id: string; text: string };

export type RevealPlanInput = {
  blocks: readonly RevealBlockLike[];
  /**
   * `live`: the chapter arrived while the reader is here → print its opening.
   * `join`: the reader opened an existing chapter → print only a young chapter's tail.
   */
  mode: 'live' | 'join';
  chapterAgeMs: number;
  /** Blocks intersecting the viewport; default is every block. */
  visibleIds?: ReadonlySet<string>;
  reducedMotion?: boolean;
  maxQueueBlocks?: number;
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
  if (input.mode === 'live') {
    candidates = input.blocks.slice(0, input.maxQueueBlocks ?? REVEAL.maxQueueBlocks);
  } else if (input.chapterAgeMs <= (input.tailOnlyOnJoinMs ?? REVEAL.tailOnlyOnJoinMs)) {
    const tail = input.tailBlocks ?? REVEAL.tailBlocks;
    candidates = input.blocks.slice(Math.max(0, input.blocks.length - tail));
  }

  const queued = candidates.filter((block) => isVisible(block.id)).map((block) => block.id);
  const queuedSet = new Set(queued);
  return { queued, instant: all.filter((id) => !queuedSet.has(id)) };
}

export type RevealBlockState = {
  id: string;
  text: string;
  clusters: string[];
  revealed: number;
  done: boolean;
  durationMs: number;
};

export type RevealState = {
  blocks: RevealBlockState[];
  /** Index of the printing block; `-1` when the queue is empty. */
  active: number;
  /** Elapsed time inside the active block. */
  elapsedMs: number;
  reducedMotion: boolean;
};

export function createReveal(
  queued: readonly RevealBlockLike[],
  options: { reducedMotion?: boolean; speed?: number } = {},
): RevealState {
  const reducedMotion = options.reducedMotion === true;
  const blocks = queued.map((block) => {
    const clusters = graphemes(block.text);
    return {
      id: block.id,
      text: block.text,
      clusters,
      revealed: reducedMotion ? clusters.length : 0,
      done: reducedMotion,
      durationMs: blockDurationMs(block.text, options.speed ?? 1),
    };
  });
  const active = reducedMotion || blocks.length === 0 ? -1 : 0;
  return { blocks, active, elapsedMs: 0, reducedMotion };
}

/** Advance the queue by `deltaMs`; `speed` 8 drains a queue the reader scrolled away from. */
export function tickReveal(state: RevealState, deltaMs: number, speed = 1): RevealState {
  if (state.active < 0 || deltaMs <= 0) return state;
  const speedFactor = Number.isFinite(speed) && speed > 0 ? speed : 1;
  let remaining = deltaMs * speedFactor;
  let active = state.active;
  let elapsed = state.elapsedMs;
  const blocks = [...state.blocks];

  while (remaining > 0 && active >= 0 && active < blocks.length) {
    const block = blocks[active];
    if (block === undefined) break;
    if (block.done) {
      active += 1;
      elapsed = 0;
      continue;
    }
    const total = block.clusters.length;
    const nextElapsed = Math.min(block.durationMs, elapsed + remaining);
    const consumed = nextElapsed - elapsed;
    remaining -= consumed;
    elapsed = nextElapsed;

    const revealed =
      nextElapsed >= block.durationMs || total === 0
        ? total
        : Math.min(total, Math.floor((total * nextElapsed) / block.durationMs));
    blocks[active] = { ...block, revealed, done: revealed >= total };
    if (nextElapsed >= block.durationMs) {
      active += 1;
      elapsed = 0;
    } else {
      break;
    }
  }

  return {
    blocks,
    active: active >= blocks.length ? -1 : active,
    elapsedMs: elapsed,
    reducedMotion: state.reducedMotion,
  };
}

/** Blocks outside the viewport appear at once: printing is only for what the reader sees. */
export function skipBlocks(state: RevealState, ids: ReadonlySet<string>): RevealState {
  if (ids.size === 0 || state.active < 0) return state;
  const blocks = state.blocks.map((block) =>
    ids.has(block.id) ? { ...block, revealed: block.clusters.length, done: true } : block,
  );
  let active = state.active;
  let elapsedMs = state.elapsedMs;
  if (ids.has(blocks[active]?.id ?? '')) {
    active = blocks.findIndex((block, index) => index >= state.active && !block.done);
    elapsedMs = 0;
  }
  return { ...state, blocks, active, elapsedMs };
}

/** «Показать сразу»: every queued block is complete, the caret disappears. */
export function finishReveal(state: RevealState): RevealState {  if (state.active < 0 && state.blocks.every((block) => block.done)) return state;
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
