/**
 * Apply a `chapter:revision` patch to the blocks this client has loaded (§10.4).
 *
 * The client applies a patch **only** when `rev === loadedRev + 1`; a patch that cannot
 * be applied returns `null` and the caller refetches, because a half-applied chapter is
 * worse than a request. Rewrites never re-type old text: replaced/inserted blocks
 * cross-fade, they do not print (ARCHITECTURE §11.4–11.5).
 */

import type { BlockDto, PatchOp } from '@book/shared';

function pristineId(id: string): string {
  const hash = id.slice(id.indexOf('#') + 1);
  return hash.replace(/-\d+$/u, '');
}

export function applyPatch(blocks: readonly BlockDto[], ops: readonly PatchOp[]): BlockDto[] | null {
  const out: BlockDto[] = [];
  let oldIndex = 0;
  let inserted = 0;
  let removed = 0;

  for (const op of ops) {
    if (!Number.isInteger(op.i) || op.i < 0) return null;
    // `i` is an index in the new revision: it can never pass its current length.
    if (op.i > blocks.length - removed + inserted) return null;
    while (oldIndex < op.i && oldIndex < blocks.length) {
      const block = blocks[oldIndex];
      if (block === undefined) return null;
      out.push(block);
      oldIndex += 1;
    }

    if (op.op === 'remove') {
      const old = blocks[oldIndex];
      if (old === undefined || old.id !== op.id) return null;
      oldIndex += 1;
      removed += 1;
      continue;
    }

    if (typeof op.text !== 'string') return null;
    if (op.op === 'insert') {
      out.push({ id: op.id, i: out.length, text: op.text, hash: pristineId(op.id) });
      inserted += 1;
      continue;
    }

    const old = blocks[oldIndex];
    if (old === undefined || old.id !== op.id || op.newId === undefined) return null;
    out.push({ id: op.newId, i: out.length, text: op.text, hash: pristineId(op.newId) });
    oldIndex += 1;
  }

  while (oldIndex < blocks.length) {
    const block = blocks[oldIndex];
    if (block === undefined) return null;
    out.push(block);
    oldIndex += 1;
  }

  return out.map((block, index) => ({ ...block, i: index }));
}

/** Block ids changed by a patch: what the chapter marks as «правлено» and cross-fades. */
export function revisedBlockIds(ops: readonly PatchOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.op === 'insert' || op.op === 'replace') ids.add(op.newId ?? op.id);
  }
  return [...ids];
}
