/**
 * What a landing replaced (`docs/writer-lane.md` §2): the `span` of a `landed` stage.
 *
 * The span is a hint to the reader's page, not a diff to be trusted: blocks are aligned by
 * index (the pass writes a whole chapter, so paragraph i of the new text faces paragraph i of
 * the old one), identical blocks are skipped, and each side is cut at `STAGE_SPAN_MAX_CHARS`
 * with `truncated: true` — the rest is read from the chapter itself. A first pass over an
 * empty slot has nothing to align: it is one span with `blockId: null` and an empty `before`.
 *
 * Block identity is `parseChapter`'s ids (`ch08#9c1f0a3b`), never a second hashing rule: the
 * client looks the id up in the chapter it already has.
 */

import { STAGE_SPAN_MAX_CHARS, type StageSpan } from '@book/shared';

import { normalizeForHash, parseChapter } from '../ingest/parseChapter.ts';

/** A landed stage replaces a handful of blocks; more than this and the reader reads the chapter. */
export const MAX_SPANS = 8;

function cut(value: string): { text: string; truncated: boolean } {
  if (value.length <= STAGE_SPAN_MAX_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, STAGE_SPAN_MAX_CHARS), truncated: true };
}

function spanOf(blockId: string | null, before: string, after: string): StageSpan {
  const from = cut(before);
  const to = cut(after);
  return {
    blockId,
    before: from.text,
    after: to.text,
    truncated: from.truncated || to.truncated,
  };
}

/**
 * The spans between two texts of one chapter. Pure: the chapter number is only there because
 * a block id carries it, so a caller cannot get ids from another chapter's text.
 */
export function changedSpans(beforeText: string, afterText: string, chapter: number): StageSpan[] {
  const before = parseChapter(chapter, beforeText ?? '');
  const after = parseChapter(chapter, afterText ?? '');
  const afterBody = after.body.trim();
  if (before.text.trim().length === 0 && afterBody.length === 0) return [];

  // Created from an empty slot: there is no block to align against, and no words replaced.
  if (before.text.trim().length === 0) {
    return [spanOf(null, '', afterBody)];
  }

  const spans: StageSpan[] = [];
  const count = Math.max(before.blocks.length, after.blocks.length);
  for (let index = 0; index < count && spans.length < MAX_SPANS; index += 1) {
    const from = before.blocks[index];
    const to = after.blocks[index];
    const beforeBlock = from?.text ?? '';
    const afterBlock = to?.text ?? '';
    // Whitespace is not identity: a re-wrapped paragraph is the same paragraph.
    if (normalizeForHash(beforeBlock) === normalizeForHash(afterBlock)) continue;
    spans.push(spanOf(from?.id ?? null, beforeBlock, afterBlock));
  }
  return spans;
}
