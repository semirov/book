/**
 * The applier (BOOK-173 §2): a patch that can be **discharged** against the bytes it names.
 *
 * Pure by contract — no fs, no db, no clock, no env: the same inputs always give the same
 * bytes. It resolves each `blockId` in *this* chapter, proves `oldText` occurs exactly once
 * inside that one block, and applies in block order. Anything it cannot prove is a named
 * refusal, because a patch accepted without an exact match is the one risk not worth taking
 * (§7): a typo-level filing would silently rewrite bytes nobody named, and no gate would see
 * it — the gates read the chapter whole, and a plausible sentence reads plausibly.
 *
 * The count invariant is the **subsequence** one, not "block count unchanged": a delete does
 * change the count, and a file whose blocks *are* its paragraphs has no placeholder to hold a
 * paragraph's place. Untouched blocks keep their bytes, order and multiplicity; the count is
 * accounted for by the patch (`before + inserts − deletes`); a title line is not a block.
 */

import { CHAPTER_CHARS, FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS, isChapterNumber } from '@book/shared';

import { parseChapter } from '../../ingest/parseChapter.ts';
import type { PatchAnswer, PatchEdit, PatchRefusalCode } from './protocol.ts';

export type PatchApply =
  | { ok: true; text: string; changedChars: number; fraction: number; edits: PatchEdit[] }
  | { ok: false; code: PatchRefusalCode; detail: string };

/** §2.7: a patch may change at most this share of the chapter's prose. */
export const PATCH_MAX_FRACTION = 0.15;

/** §2.6: the floor the shared chapter model enforces on every chapter, patch or not. */
const MIN_PARAGRAPHS = 3;

export type PatchApplyInput = { chapter: number; text: string; patch: PatchAnswer; maxFraction?: number };

function fail(code: PatchRefusalCode, detail: string): PatchApply {
  return { ok: false, code, detail };
}

type Zone = { index: number; from: number; to: number };

/**
 * The frame zone (§2, "the frozen frame, two doors"): ch01 opens on the first sentence and
 * ch42 closes on the last, and those sentences live *inside* a block a patch may name. The
 * zone is computed from the sentence's own length — imported from `@book/shared`, never
 * retyped — so a patch that overlaps it is refused before anything is applied.
 */
function frameZone(chapter: number, blocks: ReadonlyArray<{ text: string }>): Zone | null {
  if (chapter === 1) {
    const first = blocks[0];
    if (first === undefined) return null;
    const at = first.text.indexOf(FRAME_FIRST_SENTENCE);
    return { index: 0, from: at === -1 ? 0 : at, to: (at === -1 ? 0 : at) + FRAME_FIRST_SENTENCE.length };
  }
  if (chapter === TOTAL_CHAPTERS) {
    const index = blocks.length - 1;
    const last = blocks[index];
    if (last === undefined) return null;
    const at = last.text.lastIndexOf(FRAME_LAST_SENTENCE);
    const from = at === -1 ? Math.max(0, last.text.length - FRAME_LAST_SENTENCE.length) : at;
    return { index, from, to: from + FRAME_LAST_SENTENCE.length };
  }
  return null;
}

/** Apply a patch to a chapter's text. Returns the whole new file's bytes or a named refusal. */
export function applyPatch(input: PatchApplyInput): PatchApply {
  const { chapter, text, patch } = input;
  const maxFraction = input.maxFraction ?? PATCH_MAX_FRACTION;
  if (!isChapterNumber(chapter)) return fail('PATCH_SHAPE', `chapter ${String(chapter)} is not 1..${String(TOTAL_CHAPTERS)}`);

  const before = parseChapter(chapter, text);
  // A basis slot (ch01/ch42 before their first edition) *is* the frozen frame: nothing to patch.
  if (before.basis) return fail('PATCH_FRAME_TOUCHED', 'a basis-only slot is the frozen frame and takes no patch');
  if (before.chars === 0) return fail('PATCH_LENGTH', 'the chapter has no prose to patch');

  const blocks = before.blocks;
  const byId = new Map(blocks.map((block, index) => [block.id, index]));
  const edits = patch.edits;

  // 1. Resolve every id in this chapter's own map, and refuse two edits on one block.
  const touched = new Map<number, number>();
  const insertsAfter = new Map<number, PatchEdit[]>();
  for (const [editIndex, edit] of edits.entries()) {
    if (edit.blockId === null) {
      const after = byId.get(edit.afterBlockId ?? '');
      if (after === undefined) {
        return fail('PATCH_UNKNOWN_BLOCK', `edit ${String(editIndex + 1)}: ${String(edit.afterBlockId)} is not a block of chapter ${String(chapter)}`);
      }
      if (insertsAfter.has(after)) return fail('PATCH_OVERLAP', `edit ${String(editIndex + 1)}: two insertions after one block`);
      if (edit.newText.length === 0) continue;
      insertsAfter.set(after, [edit]);
      continue;
    }
    const index = byId.get(edit.blockId);
    if (index === undefined) {
      return fail('PATCH_UNKNOWN_BLOCK', `edit ${String(editIndex + 1)}: ${edit.blockId} is not a block of chapter ${String(chapter)}`);
    }
    if (touched.has(index)) return fail('PATCH_OVERLAP', `edit ${String(editIndex + 1)}: a second edit on block ${edit.blockId}`);
    touched.set(index, editIndex);
  }

  // 2. Prove each `oldText`: present, exactly once, inside its own block only.
  const located = new Map<number, number>();
  for (const [index, editIndex] of touched) {
    const block = blocks[index];
    const edit = edits[editIndex];
    if (block === undefined || edit === undefined) continue;
    if (edit.oldText.length === 0) {
      return fail('PATCH_OLD_TEXT_EMPTY', `block ${block.id} is named but no pre-image is quoted`);
    }
    const at = block.text.indexOf(edit.oldText);
    if (at === -1) {
      return fail('PATCH_OLD_TEXT_NOT_FOUND', `block ${block.id}: the quoted text does not occur in it (one quote never spans two blocks)`);
    }
    if (block.text.indexOf(edit.oldText, at + 1) !== -1) {
      return fail('PATCH_OLD_TEXT_AMBIGUOUS', `block ${block.id}: the quoted text occurs more than once`);
    }
    located.set(index, at);
  }

  // 3. The frame, before a byte moves: an edit whose matched range overlaps the zone is refused.
  const zone = frameZone(chapter, blocks);
  if (zone !== null) {
    for (const [index, editIndex] of touched) {
      const edit = edits[editIndex];
      const at = located.get(index);
      if (index !== zone.index || edit === undefined || at === undefined) continue;
      if (edit.newText === edit.oldText) continue;
      if (at < zone.to && at + edit.oldText.length > zone.from) {
        return fail('PATCH_FRAME_TOUCHED', `block ${String(index)}: the edit overlaps the frozen frame sentence`);
      }
    }
  }

  // 4. Apply in block order; reparse once, at the end.
  const after: string[] = [];
  let changedChars = 0;
  let removed = 0;
  let inserted = 0;
  for (const [index, block] of blocks.entries()) {
    const editIndex = touched.get(index);
    let blockText = block.text;
    if (editIndex !== undefined) {
      const edit = edits[editIndex];
      const at = located.get(index);
      if (edit !== undefined && at !== undefined && edit.newText !== edit.oldText) {
        blockText = `${block.text.slice(0, at)}${edit.newText}${block.text.slice(at + edit.oldText.length)}`;
        changedChars += Math.max(edit.oldText.length, edit.newText.length);
      }
    }
    if (blockText.length > 0) after.push(blockText);
    else if (editIndex !== undefined) removed += 1;
    for (const insert of insertsAfter.get(index) ?? []) {
      after.push(insert.newText);
      changedChars += Math.max(insert.oldText.length, insert.newText.length);
      inserted += 1;
    }
  }
  if (changedChars === 0) return fail('PATCH_EMPTY', 'the patch changes no bytes');

  const head = before.title === null ? '' : `${before.title}\n\n`;
  const textAfter = `${head}${after.join('\n\n')}\n`;
  const result = parseChapter(chapter, textAfter);

  // 5. The invariants the file must still honour.
  if (result.title !== before.title) {
    return fail('PATCH_TITLE', 'the title line changed: a title is not a block, and a patch may not name one');
  }
  if (result.chars < CHAPTER_CHARS.floor || result.chars > CHAPTER_CHARS.max) {
    return fail('PATCH_LENGTH', `the patched chapter is ${String(result.chars)} characters; the band is ${String(CHAPTER_CHARS.floor)}..${String(CHAPTER_CHARS.max)}`);
  }
  if (result.blocks.length < MIN_PARAGRAPHS) {
    return fail('PATCH_PARAGRAPH_FLOOR', `the patched chapter has ${String(result.blocks.length)} paragraphs; at least ${String(MIN_PARAGRAPHS)} are expected`);
  }
  const untouched = blocks.filter((_, index) => !touched.has(index)).map((block) => block.hash);
  let cursor = 0;
  for (const block of result.blocks) {
    if (cursor < untouched.length && block.hash === untouched[cursor]) cursor += 1;
  }
  if (cursor !== untouched.length) {
    return fail('PATCH_INVARIANT', 'an untouched block lost its bytes, its order or its multiplicity');
  }
  if (result.blocks.length !== blocks.length + inserted - removed) {
    return fail('PATCH_INVARIANT', `the block count is ${String(result.blocks.length)}, the patch accounts for ${String(blocks.length + inserted - removed)}`);
  }
  const fraction = changedChars / before.chars;
  if (fraction > maxFraction) {
    return fail('PATCH_BUDGET_EXCEEDED', `${String(changedChars)} of ${String(before.chars)} characters changed (${(fraction * 100).toFixed(1)} %), the bound is ${(maxFraction * 100).toFixed(0)} %`);
  }
  return { ok: true, text: textAfter, changedChars, fraction, edits };
}
