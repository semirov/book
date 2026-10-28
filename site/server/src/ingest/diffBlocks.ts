/**
 * Block-sequence diff for a revision row (§6.3 step 5): `insert | remove | replace`,
 * coalesced into three counters. The sequences are block hashes, so an untouched
 * paragraph is the same element even when its index moves.
 */

export type BlockDiff = {
  added: number;
  changed: number;
  removed: number;
};

/** Longest common subsequence of two hash arrays; one chapter × ~150 blocks is tiny. */
function lcsMatrix(left: string[], right: string[]): number[][] {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
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

export function diffBlocks(before: string[], after: string[]): BlockDiff {
  const table = lcsMatrix(before, after);
  const result: BlockDiff = { added: 0, changed: 0, removed: 0 };

  let i = before.length;
  let j = after.length;
  let removed = 0;
  let added = 0;

  const flush = (): void => {
    const replaced = Math.min(removed, added);
    result.changed += replaced;
    result.removed += removed - replaced;
    result.added += added - replaced;
    removed = 0;
    added = 0;
  };

  while (i > 0 || j > 0) {
    const value = table[i]?.[j] ?? 0;
    if (i > 0 && j > 0 && before[i - 1] === after[j - 1] && value === (table[i - 1]?.[j - 1] ?? 0) + 1) {
      flush();
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || (table[i]?.[j - 1] ?? 0) >= (table[i - 1]?.[j] ?? 0))) {
      added += 1;
      j -= 1;
    } else {
      removed += 1;
      i -= 1;
    }
  }
  flush();
  return result;
}
