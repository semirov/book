/**
 * Revision patch for `chapter:revision` (§10.3): the diff of two block sequences as an
 * edit script, not the whole chapter. The client applies it only when `rev` is exactly
 * its loaded revision + 1; otherwise it refetches (§10.4), so an ambiguous script that
 * cannot be applied is a refetch, never a corrupted page.
 *
 * Semantics of `i`:
 *   - `insert` / `replace` — the new revision's index of the inserted/replacing block;
 *   - `remove` — the old revision's index of the block being removed.
 * Applying in ascending `i` while walking the old sequence works because removed blocks
 * do not advance the new index and inserted blocks do not consume an old one.
 */

import type { PatchOp } from '@book/shared';

import type { BlockRow } from '../db/repo/chapters.ts';

export type IncomingBlock = { id: string; text: string; hash: string };

type Step =
  | { kind: 'keep'; old: BlockRow; next: IncomingBlock }
  | { kind: 'remove'; old: BlockRow }
  | { kind: 'insert'; next: IncomingBlock };

function lcsTable(left: string[], right: string[]): number[][] {
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const row = table[i];
      const previous = table[i - 1];
      if (row === undefined || previous === undefined) continue;
      row[j] =
        left[i - 1] === right[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, row[j - 1] ?? 0);
    }
  }
  return table;
}

/** The LCS walk, in document order, with one step per old and per new block. */
function editScript(before: readonly BlockRow[], after: readonly IncomingBlock[]): Step[] {
  const table = lcsTable(
    before.map((block) => block.hash),
    after.map((block) => block.hash),
  );
  const reversed: Step[] = [];
  let i = before.length;
  let j = after.length;

  while (i > 0 || j > 0) {
    const oldBlock = before[i - 1];
    const newBlock = after[j - 1];
    if (i > 0 && j > 0 && oldBlock !== undefined && newBlock !== undefined && oldBlock.hash === newBlock.hash) {
      reversed.push({ kind: 'keep', old: oldBlock, next: newBlock });
      i -= 1;
      j -= 1;
      continue;
    }
    const up = i === 0 ? -1 : (table[i - 1]?.[j] ?? 0);
    const left = j === 0 ? -1 : (table[i]?.[j - 1] ?? 0);
    if (j > 0 && left >= up) {
      if (newBlock !== undefined) reversed.push({ kind: 'insert', next: newBlock });
      j -= 1;
    } else {
      if (oldBlock !== undefined) reversed.push({ kind: 'remove', old: oldBlock });
      i -= 1;
    }
  }

  return reversed.reverse();
}

/** Coalesce a changed region into `replace` pairs plus the leftover removes and inserts. */
export function patchBlocks(before: readonly BlockRow[], after: readonly IncomingBlock[]): PatchOp[] {
  const steps = editScript(before, after);
  const ops: PatchOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let cursor = 0;

  while (cursor < steps.length) {
    const step = steps[cursor];
    if (step === undefined) break;
    if (step.kind === 'keep') {
      oldIndex += 1;
      newIndex += 1;
      cursor += 1;
      continue;
    }

    const removed: BlockRow[] = [];
    const added: IncomingBlock[] = [];
    while (cursor < steps.length) {
      const inner = steps[cursor];
      if (inner === undefined || inner.kind === 'keep') break;
      if (inner.kind === 'remove') removed.push(inner.old);
      else added.push(inner.next);
      cursor += 1;
    }

    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k += 1) {
      const oldBlock = removed[k];
      const newBlock = added[k];
      if (oldBlock === undefined || newBlock === undefined) continue;
      ops.push({ op: 'replace', id: oldBlock.id, i: newIndex, newId: newBlock.id, text: newBlock.text });
      oldIndex += 1;
      newIndex += 1;
    }
    for (let k = paired; k < removed.length; k += 1) {
      const oldBlock = removed[k];
      if (oldBlock === undefined) continue;
      ops.push({ op: 'remove', id: oldBlock.id, i: newIndex });
      oldIndex += 1;
    }
    for (let k = paired; k < added.length; k += 1) {
      const newBlock = added[k];
      if (newBlock === undefined) continue;
      ops.push({ op: 'insert', id: newBlock.id, i: newIndex, text: newBlock.text });
      newIndex += 1;
    }
  }

  // The indices above are maintained for clarity; assert nothing was left behind.
  if (oldIndex > before.length || newIndex !== after.length) {
    // A malformed script is worse than a refetch: send no patch and let the client fetch.
    return [];
  }
  return ops;
}

/** §10.3: a patch larger than 96 KB is not framed; the client refetches instead. */
export const PATCH_MAX_BYTES = 96 * 1024;

export function patchSize(patch: PatchOp[]): number {
  return Buffer.byteLength(JSON.stringify(patch), 'utf8');
}
