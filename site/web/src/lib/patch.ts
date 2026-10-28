/**
 * Apply a `chapter:revision` patch to the blocks this client has loaded (§10.4).
 *
 * The client applies a patch **only** when `rev === loadedRev + 1`; a patch that cannot
 * be applied returns `null` and the caller refetches, because a half-applied chapter is
 * worse than a request. A machine rewrite never re-types old text: replaced/inserted blocks
 * cross-fade (ARCHITECTURE §11.4–11.5). A revision a reader caused is the exception — its
 * blocks print through the reveal, and the caller decides which with `printsChange`
 * (BOOK-117 §1).
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

/**
 * The blocks a refetched chapter holds that the loaded one did not: a block is new when its
 * id is (a replaced paragraph arrives under a new id), and changed when the same id carries
 * other text. A block that vanished contributes nothing to the queue — there is no text left
 * to print — and the arrived order is the order they print in.
 *
 * This is how a pass in flight reaches the page: the refetch carries the written text, but no
 * frame says which blocks it touched (see `lib/passes.ts`).
 */
export function changedBlockIds(before: readonly BlockDto[], after: readonly BlockDto[]): string[] {
  const held = new Map(before.map((block) => [block.id, block.text]));
  return after.filter((block) => held.get(block.id) !== block.text).map((block) => block.id);
}

/**
 * What a refetched chapter prints.
 *
 * `change` — the change behind the request is known, so its blocks print (BOOK-117 §1). Else,
 * with a pass in flight on a chapter the reader already held, the difference the refetch
 * revealed prints: `landed` is written by the engine, so no `chapter:revision` frame ever
 * reaches the page (`lib/passes.ts`). Else `null`: the chapter lands by its own rule.
 *
 * A first load has nothing to compare with, so a pass in flight on an empty slot keeps the
 * arrival path — a chapter that got written is a chapter arriving, not a change inside one.
 */
export function refetchPrints(input: {
  change: ReadonlySet<string> | null;
  passInFlight: boolean;
  before: readonly BlockDto[] | null;
  after: readonly BlockDto[];
}): ReadonlySet<string> | null {
  if (input.change !== null) return input.change;
  if (!input.passInFlight || input.before === null) return null;
  return new Set(changedBlockIds(input.before, input.after));
}

/** Block ids changed by a patch: what a machine revision cross-fades, and what a change prints. */
export function revisedBlockIds(ops: readonly PatchOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.op === 'insert' || op.op === 'replace') ids.add(op.newId ?? op.id);
  }
  return [...ids];
}
