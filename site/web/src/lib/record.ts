import { useSyncExternalStore } from 'react';

import type { CommentDto } from '@book/shared';

import { track, type SeamSurface } from './analytics.ts';
import { closeOtherOverlays, registerOverlay } from './overlayRegistry.ts';
import type { SeamAnchor } from './seam.ts';

/**
 * BOOK-128 comment #3852 — **one block per page**, keyed by the span it speaks about.
 *
 * The accordion replaced the floating reader layer: a word's record, a phrase's facts, a filing
 * card and the intervention form are one node in the flow after the paragraph. This store is
 * the seam store's successor — it holds `{chapter, blockId, start, end}` and the anchor the
 * block speaks for — but it is kept separate while the shipped premise strip still reads
 * `useSeam`. Nothing opens both, and each store closes the other through `overlayRegistry`, so
 * the page can never hold two blocks.
 */

/** The exact touched range: the word under the caret, or the sentence when there is no word. */
export type RecordRange = { chapter: number; blockId: string; start: number; end: number };

export type OpenRecord = RecordRange & {
  anchor: SeamAnchor | null;
  /** The word the tap landed on, in paragraph offsets — the quote underlines it. */
  word?: { start: number; end: number } | null;
  /** The element the tap came from, so focus can return there with `preventScroll`. */
  origin: HTMLElement | null;
  surface?: SeamSurface;
  /**
   * The change the record was opened for: its `правка` section is expanded on mount, and the
   * record reads it. Absent for every ordinary tap on a sentence.
   */
  changeId?: string | null;
  /**
   * The sentence as the change's filing stored it. A landed change rewrites its own sentence,
   * so the record's anchor quote is the **after**; this quote is the **before** and travels with
   * the door, because the sentence's live filing list no longer carries it.
   */
  changeQuote?: string | null;
  /**
   * The filing the record was opened for (a numeral, a margin note, a place door): the record
   * opens with the filing's body in the same register, never in a panel of its own.
   */
  filing?: CommentDto | null;
};

/**
 * A change with no anchored sentence (a premise, an author's own change, a filing whose
 * paragraph is gone) stands on the chapter's own row: the chapter prints the change's section
 * after the premise row instead of inventing a paragraph to open. One at a time, like the block.
 */
export type ChapterChange = { chapter: number; changeId: string };

let current: OpenRecord | null = null;
let chapterChange: ChapterChange | null = null;
/**
 * The place's memory: the last range a reader touched in this session. It is what keeps the
 * quiet dotted mark after the block closes, and what drops it when another span is touched.
 */
let last: RecordRange | null = null;
const listeners = new Set<() => void>();

/** The key the block is keyed by: the paragraph and the exact range, nothing else. */
export function recordKey(range: RecordRange): string {
  return `${range.chapter}:${range.blockId}:${range.start}:${range.end}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Open the block on a span. A second span **replaces** the first in one commit — never two
 * blocks. The swap is atomic: React keys the block by its range, so the old node leaves in the
 * same frame the new one enters, and no closing ghost is left above the touched line.
 */
export function openRecord(next: OpenRecord): void {
  const first = current === null;
  current = next;
  chapterChange = null;
  last = { chapter: next.chapter, blockId: next.blockId, start: next.start, end: next.end };
  // BOOK-111/BOOK-128: one block on the page. The premise strip, a card and the revision
  // object are the other slots; opening a record closes them rather than standing beside them.
  closeOtherOverlays('record');
  if (first) track('seam_open', { surface: next.surface ?? 'text' });
  emit();
}

/** Close the block. `last` survives on purpose: the closed state is the page plus one mark. */
export function closeRecord(): void {
  if (current === null && chapterChange === null) return;
  current = null;
  // The chapter's own change row is the record's slot too: another overlay replaces both.
  chapterChange = null;
  emit();
}

export function currentRecord(): OpenRecord | null {
  return current;
}

export function useOpenRecord(): OpenRecord | null {
  return useSyncExternalStore(subscribe, currentRecord, () => null);
}

/**
 * Open the chapter's own row for a change with no sentence. It takes the record's slot: the
 * block closes, the other overlays close, and the chapter prints one section — never two.
 */
export function openChapterChange(next: ChapterChange): void {
  const same = chapterChange !== null && chapterChange.chapter === next.chapter && chapterChange.changeId === next.changeId;
  if (same) return;
  current = null;
  chapterChange = next;
  closeOtherOverlays('record');
  emit();
}

export function closeChapterChange(): void {
  if (chapterChange === null) return;
  chapterChange = null;
  emit();
}

export function useChapterChange(): ChapterChange | null {
  return useSyncExternalStore(subscribe, () => chapterChange, () => null);
}

/** The chapter-level change this page holds, for callers that are not components (tests). */
export function currentChapterChange(): ChapterChange | null {
  return chapterChange;
}

/** The quiet mark a closed block leaves: the last touched range, for this paragraph only. */
export function lastTouchOf(chapter: number, blockId: string): RecordRange | null {
  if (last === null || last.chapter !== chapter || last.blockId !== blockId) return null;
  return last;
}

/** The place's memory is session state; a fresh page (and every test) starts with nothing. */
export function resetRecordMemory(): void {
  current = null;
  chapterChange = null;
  last = null;
}

registerOverlay('record', closeRecord);
