/**
 * The applier's contract and its pre-flight (BOOK-176, BOOK-DOC-69/ADR-043).
 *
 * Everything here is decided **before** a single row moves: what a patch may be, whether the text
 * it names is really there and really unique, whether the stored hashes still describe the
 * projection, and whether the frozen frame (F029) survives. A refusal costs no writes, no file
 * and no revision, which is why the checks and the transaction live in two files: this one is
 * pure (a database row list in, a verdict out) and `applier.ts` owns the write.
 *
 * The refusal codes are the contract: a caller branches on `code`, never on a message.
 */

import { frameSentenceOf, TOTAL_CHAPTERS } from '@book/shared';

import type { Db } from '../db/db.ts';
import type { BlockRow } from '../db/repo/chapters.ts';
import type { WriteActor, WriteCause } from '../ingest/attribution.ts';
import { AUTHOR_LABEL, OPERATOR_LABEL } from '../ingest/attribution.ts';
import { normalizeForHash } from '../ingest/parseChapter.ts';
import { sha1Hex } from '../util/hash.ts';
import { cpLength, cpOffsetOf } from './spans.ts';

export type PatchEdit = { blockId: string; oldText: string; newText: string };
export type Patch = { mode: 'patch'; edits: PatchEdit[] };

export type PatchCause = {
  kind: 'change' | 'cascade' | 'draft' | 'operator';
  changeId?: string | null;
  stepId?: string | null;
  cascadeId?: string | null;
  label?: string;
};

export type ApplyPatchInput = {
  db: Db;
  dataDir: string;
  chapter: number;
  patch: Patch;
  cause: PatchCause;
  nowMs?: number;
};

export type ApplyRefusalCode =
  | 'PATCH_INVALID'
  | 'CHAPTER_NOT_FOUND'
  | 'BLOCK_NOT_FOUND'
  | 'OLD_TEXT_NOT_FOUND'
  | 'OLD_TEXT_AMBIGUOUS'
  | 'FRAME_CHANGED'
  | 'HASH_MISMATCH'
  | 'EMPTY_BLOCK'
  | 'NOT_REVERSIBLE'
  | 'NOTHING_TO_REVERT';

export type ApplyPatchResult =
  | {
      ok: true;
      chapter: number;
      rev: number;
      hseq: number;
      spans: number;
      mentions: number;
      literals: number;
      blocksChanged: number;
      /** ADR-043 L8: 1 when the revision recorded a `FACT_SHAPED_UNBOUND` warning, else 0. */
      warnings: number;
      /** ADR-043 D9: the chapter's whole gap after this patch. */
      ledgerGap: number;
    }
  | { ok: false; code: ApplyRefusalCode; blockId?: string; detail?: string };

/** One patch is a step's delta, not a rewrite: eight paragraphs is the ceiling. */
export const MAX_EDITS = 8;
export const MAX_OLD_CP = 2000;
export const MAX_NEW_CP = 4000;

export function refuse(code: ApplyRefusalCode, detail?: string, blockId?: string): ApplyPatchResult {
  return blockId === undefined
    ? { ok: false, code, ...(detail === undefined ? {} : { detail }) }
    : { ok: false, code, blockId, ...(detail === undefined ? {} : { detail }) };
}

/** The block's stored hash: the first eight hex digits of the normalised text (§6C.3). */
export function blockHashOf(text: string): string {
  return sha1Hex(normalizeForHash(text)).slice(0, 8);
}

/** Every UTF-16 index at which `needle` occurs; overlapping occurrences count as ambiguous. */
export function occurrenceIndices(text: string, needle: string): number[] {
  if (needle === '') return [];
  const indices: number[] = [];
  let from = text.indexOf(needle);
  while (from !== -1) {
    indices.push(from);
    from = text.indexOf(needle, from + needle.length);
  }
  return indices;
}

/** The chapter's canonical text: the title line, a blank line, then the blocks (§6C.3). */
export function canonicalChapterText(title: string | null, texts: ReadonlyArray<string>): string {
  const body = texts.join('\n\n');
  return title === null || title === '' ? body : `${title}\n\n${body}`;
}

export function actorFor(cause: PatchCause): WriteActor {
  const operator = cause.kind === 'operator';
  return {
    kind: operator ? 'operator' : 'writer',
    identityId: null,
    label: cause.label ?? (operator ? OPERATOR_LABEL : AUTHOR_LABEL),
  };
}

export function writeCauseOf(cause: PatchCause): WriteCause {
  return {
    kind: cause.kind,
    lane: null,
    leaseId: null,
    changeId: cause.changeId ?? null,
    cascadeId: cause.cascadeId ?? null,
    stepId: cause.stepId ?? null,
  };
}

export type ResolvedEdit = {
  edit: PatchEdit;
  block: BlockRow;
  /** UTF-16 index of the replaced stretch in the block's current text. */
  start: number;
  /** Code-point offset of the same stretch — the span's coordinates. */
  from: number;
  newText: string;
};

/** Everything the patch may not be, checked before a single row moves. */
export function shapeRefusal(patch: Patch): ApplyPatchResult | null {
  if (patch.mode !== 'patch') return refuse('PATCH_INVALID', 'mode must be "patch"');
  const edits = patch.edits;
  if (!Array.isArray(edits) || edits.length === 0) return refuse('PATCH_INVALID', 'no edits');
  if (edits.length > MAX_EDITS) return refuse('PATCH_INVALID', `more than ${String(MAX_EDITS)} edits`);
  const seen = new Set<string>();
  for (const edit of edits) {
    if (typeof edit.blockId !== 'string' || edit.blockId === '') {
      return refuse('PATCH_INVALID', 'blockId must be a non-empty string');
    }
    if (seen.has(edit.blockId)) return refuse('PATCH_INVALID', 'duplicate blockId', edit.blockId);
    seen.add(edit.blockId);
    if (typeof edit.oldText !== 'string' || cpLength(edit.oldText) === 0) {
      return refuse('PATCH_INVALID', 'oldText must not be empty', edit.blockId);
    }
    if (cpLength(edit.oldText) > MAX_OLD_CP) return refuse('PATCH_INVALID', 'oldText too long', edit.blockId);
    if (typeof edit.newText !== 'string') return refuse('PATCH_INVALID', 'newText must be a string', edit.blockId);
    if (cpLength(edit.newText) > MAX_NEW_CP) return refuse('PATCH_INVALID', 'newText too long', edit.blockId);
  }
  return null;
}

/** Resolve each edit against the chapter's current blocks; a refusal leaves nothing to undo. */
export function resolveEdits(
  blocks: ReadonlyArray<BlockRow>,
  edits: ReadonlyArray<PatchEdit>,
): ApplyPatchResult | ResolvedEdit[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const resolved: ResolvedEdit[] = [];
  for (const edit of edits) {
    const block = byId.get(edit.blockId);
    if (block === undefined) return refuse('BLOCK_NOT_FOUND', 'block is not in this chapter', edit.blockId);
    const indices = occurrenceIndices(block.text, edit.oldText);
    if (indices.length === 0) return refuse('OLD_TEXT_NOT_FOUND', 'oldText is not in the block', edit.blockId);
    if (indices.length > 1) return refuse('OLD_TEXT_AMBIGUOUS', 'oldText occurs more than once', edit.blockId);
    const start = indices[0] ?? 0;
    const newText = `${block.text.slice(0, start)}${edit.newText}${block.text.slice(start + edit.oldText.length)}`;
    if (newText.trim() === '') return refuse('EMPTY_BLOCK', 'a block may not be emptied', edit.blockId);
    resolved.push({ edit, block, start, from: cpOffsetOf(block.text, start), newText });
  }
  return resolved;
}

/**
 * F029: the canon sentence is not text the book may edit. Two refusals live here — the edit may
 * not touch an occurrence of the sentence, and after applying, ch01 must still open on it and
 * the finale must still close on it.
 */
export function frameRefusal(
  chapter: number,
  blocks: ReadonlyArray<BlockRow>,
  resolved: ReadonlyArray<ResolvedEdit>,
  newTextOf: ReadonlyMap<string, string>,
): ApplyPatchResult | null {
  const frame = frameSentenceOf(chapter);
  if (frame === null) return null;
  for (const edit of resolved) {
    const editEnd = edit.start + edit.edit.oldText.length;
    for (const occurrence of occurrenceIndices(edit.block.text, frame)) {
      const occurrenceEnd = occurrence + frame.length;
      if (!(editEnd <= occurrence || edit.start >= occurrenceEnd)) {
        return refuse('FRAME_CHANGED', 'the edit touches the frozen frame', edit.block.id);
      }
    }
  }
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const firstText = first === undefined ? '' : (newTextOf.get(first.id) ?? first.text);
  const lastText = last === undefined ? '' : (newTextOf.get(last.id) ?? last.text);
  if (chapter === 1 && !firstText.startsWith(frame)) {
    return refuse('FRAME_CHANGED', 'chapter 1 no longer opens on the frame');
  }
  if (chapter === TOTAL_CHAPTERS && !lastText.endsWith(frame)) {
    return refuse('FRAME_CHANGED', 'the finale no longer closes on the frame');
  }
  return null;
}
