/**
 * Narrative integrity after a patch (BOOK-173 §3) — **no model**, and no judgement a test
 * cannot pin. Three checks, each with a closed rule:
 *
 *  · **neighbours** — patch mode writes one file, so neighbours cannot move; yet the prompt was
 *    built from them as they were, and a neighbour can land between build and `land`. Hashes,
 *    not a reading: re-read and compare (`PATCH_NEIGHBOUR_MOVED`, park, do not land). This is
 *    the one function here that touches the disk, and `applyPatch` never calls it.
 *  · **dangling references** — a block that opens on «Он …» after its antecedent was deleted is
 *    a chapter a gate would read as prose and a reader as a hole. The token sets are closed and
 *    exported, so the test pins them: a wider heuristic is a new decision, not a tweak.
 *  · **world facts** — every `facts[]` entry must occur verbatim in the post-apply chapter,
 *    and every fact-shaped token of a replaced range must survive. A changed number is
 *    therefore never a patch: the model answers `mode:"rewrite"` and says why.
 */

import { readFileSync } from 'node:fs';

import { TOTAL_CHAPTERS, isChapterNumber } from '@book/shared';

import { chapterPath } from '../../engine/text.ts';
import { sha256Hex } from '../../util/hash.ts';
import type { PatchAnswer, PatchEdit } from './protocol.ts';

/** §3: one block above the edited one, and no further. A measured run may raise it. */
export const DANGLING_WINDOW_BLOCKS = 1;

/**
 * Closed set (§3): the words that make a block's opening depend on a predecessor. Nothing is
 * added here without a measured false-positive rate — the check is a heuristic, and a heuristic
 * that grows by feel turns into a silent rewriting rule.
 */
export const REFERENCE: ReadonlySet<string> = new Set(
  (
    'он она оно они его её ему ей им их ими ею него неё нему ней ним ними них этот эта это эти этого этой этих ' +
    'этому этим этими тот та то те того той тех тому тем теми такой такая такое такие таков поэтому тогда оттуда отсюда'
  ).split(/\s+/u),
);

/** Closed set (§3): words that carry no antecedent of their own — never a `candidate`. */
export const FUNCTION: ReadonlySet<string> = new Set(
  (
    'в во на по с со к ко у о об за из от до при для без под над про через между и а но или либо не ни же ли бы что ' +
    'чтобы как так тоже также уже ещё вот только даже ведь да нет был была было были есть будет может можно надо очень всё все'
  ).split(/\s+/u),
);

export type BlockView = { id: string; text: string };

/** §3's fold: case is not identity, and `ё` is a spelling of `е`, not a different word. */
export function fold(value: string): string {
  return value.toLowerCase().replace(/ё/gu, 'е');
}

export function tokens(value: string): string[] {
  return fold(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** The visible first word of a block: a leading dash, quote or bracket is punctuation, not a word. */
function firstToken(value: string): string | null {
  const stripped = value.trimStart().replace(/^[—–«»"(]+/u, '').trimStart();
  return tokens(stripped)[0] ?? null;
}

/** `oldText` minus `newText`: what the edit actually takes out. */
function removedText(edit: PatchEdit): string {
  if (edit.newText.length === 0) return edit.oldText;
  return edit.oldText.split(edit.newText).join(' ');
}

/**
 * The post-image blocks, in order, with the source block each one came from. A patch only
 * replaces text inside a named block (the ledger's `PatchEdit` has no insert and no delete), so
 * the list has the same length as the chapter's.
 */
function postImage(blocks: readonly BlockView[], edits: readonly PatchEdit[]): Array<{ source: number; text: string; edited: boolean }> {
  const byId = new Map(blocks.map((block, index) => [block.id, index]));
  const touched = new Map<number, PatchEdit>();
  for (const edit of edits) {
    const index = byId.get(edit.blockId);
    if (index !== undefined) touched.set(index, edit);
  }
  return blocks.map((block, index) => {
    const edit = touched.get(index);
    if (edit === undefined || edit.newText === edit.oldText) return { source: index, text: block.text, edited: edit !== undefined };
    const at = block.text.indexOf(edit.oldText);
    const text =
      at === -1 ? block.text : `${block.text.slice(0, at)}${edit.newText}${block.text.slice(at + edit.oldText.length)}`;
    return { source: index, text, edited: true };
  });
}

export type DanglingResult =
  | { ok: true; skipped: 'no-predecessor' | null }
  | { ok: false; code: 'PATCH_DANGLING_REFERENCE'; detail: string };

/**
 * §3's four conditions, all of them, per edited block:
 *  1. the post-edit block's first token is in `REFERENCE`;
 *  2. the block did not open with that word before the edit (the model is not asked to fix a
 *     sentence that already read that way);
 *  3. the removed text still has `candidates` (length ≥ 4, in neither closed set);
 *  4. no candidate occurs in the post-edit block nor in the block immediately above it.
 * The first block of the chapter is skipped — it has no predecessor to dangle from.
 */
export function danglingReference(input: { blocks: readonly BlockView[]; edits: readonly PatchEdit[] }): DanglingResult {
  const after = postImage(input.blocks, input.edits);
  const byId = new Map(input.blocks.map((block, index) => [block.id, index]));
  let skipped: 'no-predecessor' | null = null;

  for (const [editIndex, edit] of input.edits.entries()) {
    if (edit.newText === edit.oldText) continue;
    const before = byId.get(edit.blockId);
    if (before === undefined) continue;
    const at = after.findIndex((block) => block.source === before && block.edited);
    if (at === -1) continue;
    const block = after[at];
    if (block === undefined) continue;
    if (at === 0) {
      skipped = 'no-predecessor';
      continue;
    }
    const opening = firstToken(block.text);
    if (opening === null || !REFERENCE.has(opening)) continue;
    if (firstToken(input.blocks[before]?.text ?? '') === opening) continue;
    const candidates = tokens(removedText(edit)).filter(
      (token) => token.length >= 4 && !REFERENCE.has(token) && !FUNCTION.has(token),
    );
    if (candidates.length === 0) continue;
    const window = after.slice(Math.max(0, at - DANGLING_WINDOW_BLOCKS), at + 1);
    const visible = new Set(window.flatMap((entry) => tokens(entry.text)));
    const orphaned = candidates.filter((candidate) => !visible.has(candidate));
    if (orphaned.length !== candidates.length) continue;
    return {
      ok: false,
      code: 'PATCH_DANGLING_REFERENCE',
      detail: `edit ${String(editIndex + 1)}: the block opens on «${opening}» but its antecedent left with ${orphaned.join(', ')}`,
    };
  }
  return { ok: true, skipped };
}

export type FactsResult = { ok: true } | { ok: false; code: 'PATCH_FACT_LOST'; detail: string };

/** Tokens a patch may not lose: a number, or an all-caps abbreviation of two letters or more. */
function factShaped(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0) continue;
    const numeric = /\p{Nd}/u.test(raw);
    const caps = /^\p{Lu}{2,}$/u.test(raw);
    if (numeric || caps) seen.add(raw);
  }
  return [...seen];
}

/**
 * §3, "world facts, strings only": the model's own `facts[]` are proof obligations (a guess
 * costs a park), and the replaced ranges are read for tokens that must survive. Both are
 * substring/token facts — nothing here judges whether a fact is true.
 */
export function factsIntact(input: { text: string; patch: PatchAnswer }): FactsResult {
  for (const [index, fact] of input.patch.facts.entries()) {
    if (!input.text.includes(fact)) {
      return { ok: false, code: 'PATCH_FACT_LOST', detail: `fact ${String(index + 1)} («${fact.slice(0, 80)}») is not in the patched chapter` };
    }
  }
  const present = new Set(input.text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0));
  for (const [index, edit] of input.patch.edits.entries()) {
    for (const token of factShaped(edit.oldText)) {
      if (!present.has(token)) {
        return { ok: false, code: 'PATCH_FACT_LOST', detail: `edit ${String(index + 1)}: «${token}» left the chapter` };
      }
    }
  }
  return { ok: true };
}

export type NeighbourDigests = { before: string | null; after: string | null };

function digestOf(bookRoot: string, chapter: number): string | null {
  if (!isChapterNumber(chapter) || chapter < 1 || chapter > TOTAL_CHAPTERS) return null;
  try {
    return sha256Hex(readFileSync(chapterPath(bookRoot, chapter), 'utf8'));
  } catch {
    return null;
  }
}

/** The neighbours as they were when the prompt was built: two hashes, no second copy of prose. */
export function neighbourDigests(bookRoot: string, chapter: number): NeighbourDigests {
  return { before: digestOf(bookRoot, chapter - 1), after: digestOf(bookRoot, chapter + 1) };
}

/** Re-read before landing: a moved neighbour means the patch was written against another book. */
export function neighbourMoved(bookRoot: string, chapter: number, recorded: NeighbourDigests): boolean {
  const now = neighbourDigests(bookRoot, chapter);
  return now.before !== recorded.before || now.after !== recorded.after;
}
