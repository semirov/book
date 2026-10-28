/**
 * The writer's pure applier (BOOK-173 §2, BOOK-176) — **before** a file exists.
 *
 * On `main` the ledger applier is the single write path: `ledger/applier.ts` owns the DB
 * transaction, and its checks live in `ledger/patchCheck.ts` (`shapeRefusal`, `resolveEdits`,
 * `frameRefusal`). The writer needs a different, earlier question answered — "what bytes does
 * this patch produce if it is applied to the exact text I built the prompt from?" — because the
 * writer's landing is a whole file (`engine/write.ts` → `applyChapterFile`), not a row update.
 * So this function runs **no duplicate check**: it calls `shapeRefusal`, `resolveEdits` and
 * `frameRefusal` and keeps patchCheck's codes (`PATCH_INVALID`, `BLOCK_NOT_FOUND`,
 * `OLD_TEXT_NOT_FOUND`, `OLD_TEXT_AMBIGUOUS`, `EMPTY_BLOCK`, `FRAME_CHANGED`). What it adds is
 * what only a whole-file producer can ask: does the resulting chapter still fit the book's own
 * band, does every untouched block keep its bytes and order, and is the change small enough to
 * be a patch at all (`PATCH_LENGTH`, `PATCH_PARAGRAPH_FLOOR`, `PATCH_INVARIANT`,
 * `PATCH_BUDGET_EXCEEDED`, §2.7 of the design).
 *
 * Pure by contract — no fs, no db, no clock, no env: the same inputs always give the same bytes.
 * The checks are pure in `patchCheck` too (a row list in, a verdict out), which is why the writer
 * can reuse them without a database.
 *
 * **The applier is exact, and the exactness is the product.** `oldText` matches the block byte for
 * byte, exactly once (`patchCheck.resolveEdits` states the rule and why a fuzzy applier would be
 * worse than a refusal); nothing here normalises the text it is about to replace — no NFC, no
 * `ё`→`е`, no quote folding, no CRLF squeezing, no trimming. A patch whose `oldText` differs from
 * the block by one space is refused with its own code and applied nowhere: an edit at a guessed
 * offset writes bytes nobody named, and the prose gates would read them as plausible.
 */

import { CHAPTER_CHARS, isChapterNumber } from '@book/shared';

import type { BlockRow } from '../../db/repo/chapters.ts';
import { parseChapter } from '../../ingest/parseChapter.ts';
import { cpLength } from '../../ledger/spans.ts';
import {
  frameRefusal,
  resolveEdits,
  shapeRefusal,
  type ApplyPatchResult,
  type ResolvedEdit,
} from '../../ledger/patchCheck.ts';
import type { PatchAnswer, PatchEdit, PatchRefusalCode } from './protocol.ts';

/** The refusal arm of the ledger's result; this module never returns its success shape. */
type LedgerRefusal = Extract<ApplyPatchResult, { ok: false }>;

function isRefusal(value: ApplyPatchResult | ResolvedEdit[]): value is LedgerRefusal {
  return !Array.isArray(value) && value.ok === false;
}

export type PatchApply =
  | { ok: true; text: string; changedChars: number; fraction: number; edits: PatchEdit[] }
  | { ok: false; code: PatchRefusalCode; detail: string; blockId?: string };

/** §2.7: a patch may change at most this share of the chapter's prose. */
export const PATCH_MAX_FRACTION = 0.15;

/** §2.6: the floor the shared chapter model enforces on every chapter, patch or not. */
const MIN_PARAGRAPHS = 3;

export type PatchApplyInput = { chapter: number; text: string; patch: PatchAnswer; maxFraction?: number };

/** The parsed chapter's blocks in the ledger's row shape: `patchCheck` reads id, text, hash. */
function rowsOf(chapter: number, blocks: ReadonlyArray<{ id: string; text: string; hash: string }>): BlockRow[] {
  return blocks.map((block, index) => ({
    id: block.id,
    chapter,
    idx: index,
    text: block.text,
    hash: block.hash,
    first_rev: 0,
    last_rev: 0,
  }));
}

/** Apply a patch to a chapter's text. Returns the whole new file's bytes or a named refusal. */
export function applyPatch(input: PatchApplyInput): PatchApply {
  const { chapter, text, patch } = input;
  const maxFraction = input.maxFraction ?? PATCH_MAX_FRACTION;
  if (!isChapterNumber(chapter)) return { ok: false, code: 'PATCH_INVALID', detail: 'chapter is out of the book' };

  const before = parseChapter(chapter, text);
  // A basis slot (ch01/ch42 before their first edition) *is* the frozen frame: nothing to patch.
  if (before.basis) return { ok: false, code: 'FRAME_CHANGED', detail: 'a basis-only slot is the frozen frame' };
  const beforeChars = before.blocks.reduce((sum, block) => sum + cpLength(block.text), 0);
  if (beforeChars === 0) return { ok: false, code: 'PATCH_INVALID', detail: 'the chapter has no prose to patch' };

  const blocks = rowsOf(chapter, before.blocks);
  const shape = shapeRefusal({ mode: 'patch', edits: patch.edits });
  if (shape !== null && !shape.ok) return refuseOf(shape);
  const resolved = resolveEdits(blocks, patch.edits);
  if (isRefusal(resolved)) return refuseOf(resolved);
  const edits = Array.isArray(resolved) ? resolved : [];

  // The frame: the same two doors `patchCheck` closes for a ledger write (F029).
  const newTextOf = new Map(edits.map((edit) => [edit.block.id, edit.newText]));
  const frame = frameRefusal(chapter, blocks, edits, newTextOf);
  if (frame !== null && !frame.ok) return refuseOf(frame);

  let changedChars = 0;
  const after: string[] = [];
  const touched = new Set<string>();
  for (const block of before.blocks) {
    const replacement = newTextOf.get(block.id);
    if (replacement === undefined) {
      after.push(block.text);
      continue;
    }
    const edit = patch.edits.find((candidate) => candidate.blockId === block.id);
    after.push(replacement);
    touched.add(block.id);
    if (edit !== undefined && edit.newText !== edit.oldText) {
      changedChars += Math.max(cpLength(edit.oldText), cpLength(edit.newText));
    }
  }
  if (changedChars === 0) return { ok: false, code: 'PATCH_INVALID', detail: 'the patch changes no bytes' };

  const head = before.title === null ? '' : `${before.title}\n\n`;
  const textAfter = `${head}${after.join('\n\n')}\n`;
  const result = parseChapter(chapter, textAfter);

  // What only a whole-file producer can ask: the chapter is still a chapter, and every block the
  // patch did not name is byte-identical, in order, once.
  if (result.title !== before.title) {
    return { ok: false, code: 'PATCH_INVARIANT', detail: 'the title line changed: a title is not a block' };
  }
  if (result.chars < CHAPTER_CHARS.floor || result.chars > CHAPTER_CHARS.max) {
    return {
      ok: false,
      code: 'PATCH_LENGTH',
      detail: `the patched chapter is ${String(result.chars)} characters; the band is ${String(CHAPTER_CHARS.floor)}..${String(CHAPTER_CHARS.max)}`,
    };
  }
  if (result.blocks.length !== before.blocks.length) {
    return {
      ok: false,
      code: 'PATCH_INVARIANT',
      detail: `the block count changed (${String(before.blocks.length)} → ${String(result.blocks.length)}): a patch replaces text inside a block`,
    };
  }
  if (result.blocks.length < MIN_PARAGRAPHS) {
    return {
      ok: false,
      code: 'PATCH_PARAGRAPH_FLOOR',
      detail: `the patched chapter has ${String(result.blocks.length)} paragraphs; at least ${String(MIN_PARAGRAPHS)} are expected`,
    };
  }
  const untouched = before.blocks.filter((block) => !touched.has(block.id)).map((block) => block.hash);
  let cursor = 0;
  for (const block of result.blocks) {
    if (cursor < untouched.length && block.hash === untouched[cursor]) cursor += 1;
  }
  if (cursor !== untouched.length) {
    return { ok: false, code: 'PATCH_INVARIANT', detail: 'an untouched block lost its bytes, its order or its multiplicity' };
  }

  const fraction = changedChars / beforeChars;
  if (fraction > maxFraction) {
    return {
      ok: false,
      code: 'PATCH_BUDGET_EXCEEDED',
      detail: `${String(changedChars)} of ${String(beforeChars)} characters changed (${(fraction * 100).toFixed(1)} %), the bound is ${(maxFraction * 100).toFixed(0)} %`,
    };
  }
  return { ok: true, text: textAfter, changedChars, fraction, edits: patch.edits };
}

/** `patchCheck`'s refusal, in this module's result shape — one code, one detail, no new words. */
function refuseOf(result: LedgerRefusal, detail?: string): PatchApply {
  return {
    ok: false,
    code: result.code,
    detail: detail ?? result.detail ?? result.code,
    ...(result.blockId === undefined ? {} : { blockId: result.blockId }),
  };
}
