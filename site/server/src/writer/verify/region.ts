/**
 * Where a change happened (BOOK-173, BOOK-DOC-80 §"Tier 0 style invariants").
 *
 * Two measures, both pure and both in **code points** — the unit the sentence ledger stores
 * (`shared/src/sentences.ts` offers `start`/`end` in code points, and the schema keeps them).
 * A tier that mixed UTF-16 indices with code-point offsets would be off by one on the first
 * `ё`-with-a-combining-mark and nobody would notice until a chapter was flagged wrongly.
 *
 * `changedRegion` is the same measure `changedChars` (ledger/graph/plan.ts) takes, with the two
 * offsets kept instead of their sum: the region is what Tier 0 reads its ±2 sentences around and
 * what the policy tests against the chapter's edges.
 *
 * `touchedBlocks` is the paragraph-level view: a block id is content-derived, so a patched
 * paragraph loses its old identity — the two lists are the before and after ids of the paragraphs
 * that actually moved, aligned by index (the applier proves a patch keeps the block count). That
 * alignment is what lets the fact sheet ask «which ledger facts live in the paragraphs this
 * change overran?» without a database.
 */

import { normalizeForHash, parseChapter } from '../../ingest/parseChapter.ts';

export type Region = { start: number; end: number };

function codePoints(value: string): string[] {
  return Array.from(value);
}

/** The one region between the common prefix and the common suffix, in code points of `after`. */
export function changedRegion(before: string, after: string): Region {
  const left = codePoints(before);
  const right = codePoints(after);
  const limit = Math.min(left.length, right.length);
  let start = 0;
  while (start < limit && left[start] === right[start]) start += 1;
  let suffix = 0;
  while (suffix < limit - start && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
    suffix += 1;
  }
  return { start, end: Math.max(start, right.length - suffix) };
}

/** A chapter's length in the same unit, for the edge test. */
export function chapterLength(text: string): number {
  return codePoints(text).length;
}

export type TouchedBlocks = { before: string[]; after: string[] };

/**
 * The paragraphs a landing replaced, by index: identical blocks (after the writer's own
 * normalisation) are not touched, and a chapter that went from empty to written touches the
 * blocks it gained.
 */
export function touchedBlocks(beforeText: string, afterText: string, chapter: number): TouchedBlocks {
  const before = parseChapter(chapter, beforeText ?? '');
  const after = parseChapter(chapter, afterText ?? '');
  const out: TouchedBlocks = { before: [], after: [] };
  const count = Math.max(before.blocks.length, after.blocks.length);
  for (let index = 0; index < count; index += 1) {
    const from = before.blocks[index];
    const to = after.blocks[index];
    if (from !== undefined && to !== undefined && normalizeForHash(from.text) === normalizeForHash(to.text)) continue;
    if (from !== undefined) out.before.push(from.id);
    if (to !== undefined) out.after.push(to.id);
  }
  return out;
}
