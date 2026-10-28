/**
 * The money, the bytes, and the spend meter (BOOK-DOC-65 §5–§6).
 *
 * Three decisions live here and nowhere else:
 *
 *  · **$ = (in − cached)·input + cached·cacheRead + out·output.** A cache hit is a discount on
 *    input and on nothing else (§5's corrected ledger). The peak basis doubles all three rates —
 *    the provider's own rule — so `$peak` is the same formula on doubled numbers, never a
 *    second price.
 *
 *  · **charsChanged** is measured at block level with the applier's own arithmetic
 *    (Σ max(|before|,|after|), an insertion counts its new text, a deletion its old text), so an
 *    A row and a B row in the same table are the same measurement on different mechanisms.
 *
 *  · **untouched** blocks are the ones the edit did not name (B) or the ones that came out at
 *    the same index with the same hash (A). Their ids and hashes are chained into one sha256
 *    each side; equality is the claim that nothing else moved.
 */

import type { ParsedBlock } from '../../server/src/ingest/parseChapter.ts';
import { sha256Hex } from '../../server/src/util/hash.ts';
import { estimateTokens, PEAK_MULTIPLIER } from './spec.ts';

export type Rates = { per: number; input: number; output: number; cacheRead: number };
export type Usage = { in: number; out: number; cachedIn: number };

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** One call's price on one basis. `multiplier` is 1 for the book's table, 2 for the peak. */
export function costOf(usage: Usage, rates: Rates, multiplier = 1): number {
  const billable = Math.max(0, usage.in - usage.cachedIn);
  const usd =
    (billable * rates.input * multiplier +
      usage.cachedIn * rates.cacheRead * multiplier +
      usage.out * rates.output * multiplier) /
    rates.per;
  return round6(usd);
}

/**
 * The worst case of one call on the peak basis: an over-stated input and the whole output cap.
 * The cap is checked against this before a call, so «it might cost more» is answered by refusing.
 */
export function estimateUsd(chars: number, maxTokens: number, rates: Rates): number {
  return costOf({ in: estimateTokens(chars), out: maxTokens, cachedIn: 0 }, rates, PEAK_MULTIPLIER);
}

export function peakRates(rates: Rates): Rates {
  return { ...rates, input: rates.input * 2, output: rates.output * 2, cacheRead: rates.cacheRead * 2 };
}

export type BlockDiff = {
  changedChars: number;
  pctOfChapter: number;
  /** Blocks the edit did not name (B) or that are byte-identical at the same index (A). */
  untouchedBlocks: number;
  /** Blocks the edit named (B) or that differ / appeared / vanished (A). */
  editedBlocks: number;
  untouchedHashEqual: boolean;
  preUntouchedSha256: string;
  postUntouchedSha256: string;
};

function chain(blocks: ReadonlyArray<{ id: string; hash: string }>): string {
  return blocks.map((block) => `${block.id}:${block.hash}`).join('\n');
}

function sha(blocks: ReadonlyArray<{ id: string; hash: string }>): string {
  return sha256Hex(chain(blocks));
}

/** Longest common subsequence of block hashes: the pairs that are literally the same paragraph. */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const rows = a.length;
  const cols = b.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * `editedIds` is B's named set (block ids the patch edits, plus insertion anchors); `null` means
 * "no named set" — A, where untouched is read off the identity of the text itself.
 */
export function diffBlocks(
  pre: readonly ParsedBlock[],
  post: readonly ParsedBlock[],
  preChars: number,
  editedIds: ReadonlySet<string> | null,
): BlockDiff {
  const pairs = lcsPairs(
    pre.map((block) => block.hash),
    post.map((block) => block.hash),
  );
  const matchedPre = new Set(pairs.map(([a]) => a));
  const matchedPost = new Set(pairs.map(([, b]) => b));
  const removed = pre.filter((_, index) => !matchedPre.has(index));
  const added = post.filter((_, index) => !matchedPost.has(index));

  let untouched: ParsedBlock[];
  let editedBlocks: number;
  if (editedIds === null) {
    // A: no block was named, so "untouched" is the prose that came out as the same paragraph.
    untouched = pairs.map(([a]) => pre[a]!);
    editedBlocks = removed.length + added.length;
  } else {
    // B: the named blocks are the edit; everything else must survive byte for byte, in order.
    untouched = pre.filter((block) => !editedIds.has(block.id));
    editedBlocks = pre.length - untouched.length;
  }

  const postUntouched = post.filter((block) => untouched.some((entry) => entry.id === block.id));
  const preSha = sha(untouched);
  const postSha = sha(postUntouched);

  let changedChars = 0;
  const paired = Math.min(removed.length, added.length);
  for (let index = 0; index < paired; index += 1) {
    changedChars += Math.max(removed[index]!.text.length, added[index]!.text.length);
  }
  for (const block of removed.slice(paired)) changedChars += block.text.length;
  for (const block of added.slice(paired)) changedChars += block.text.length;

  return {
    changedChars,
    pctOfChapter: preChars === 0 ? 0 : Math.round((changedChars / preChars) * 10_000) / 10_000,
    untouchedBlocks: untouched.length,
    editedBlocks,
    // A hash of nothing equals a hash of nothing: the count is printed beside the flag so an
    // empty untouched set can never read as a pass.
    untouchedHashEqual: untouched.length > 0 && preSha === postSha,
    preUntouchedSha256: preSha,
    postUntouchedSha256: postSha,
  };
}

/** The hard stop (§6): after every call the total is added, and the next call is checked first. */
export type Meter = {
  add(usage: Usage): { usdBook: number; usdPeak: number };
  canAfford(estimateUsd: number): boolean;
  totals(): { calls: number; usdBook: number; usdPeak: number; capHit: boolean };
};

export class SpendCapError extends Error {
  readonly spent: { calls: number; usdBook: number; usdPeak: number };

  constructor(spent: { calls: number; usdBook: number; usdPeak: number }, cap: number) {
    super(`$${spent.usdPeak.toFixed(4)} on the peak basis would cross the $${cap.toFixed(2)} cap`);
    this.name = 'SpendCapError';
    this.spent = spent;
  }
}

/** `seed` is the experiment's spend so far, read from disk: the cap spans commands, not processes. */
export function createMeter(rates: Rates, cap: number, seed: { calls: number; usdBook: number; usdPeak: number } = { calls: 0, usdBook: 0, usdPeak: 0 }): Meter {
  let calls = seed.calls;
  let usdBook = seed.usdBook;
  let usdPeak = seed.usdPeak;
  let capHit = usdPeak > cap;
  return {
    add(usage) {
      calls += 1;
      const book = costOf(usage, rates, 1);
      const peak = costOf(usage, rates, 2);
      usdBook = round6(usdBook + book);
      usdPeak = round6(usdPeak + peak);
      if (usdPeak > cap) capHit = true;
      return { usdBook: book, usdPeak: peak };
    },
    canAfford(estimateUsd) {
      if (usdPeak + estimateUsd > cap) {
        capHit = true;
        return false;
      }
      return true;
    },
    totals() {
      return { calls, usdBook, usdPeak, capHit };
    },
  };
}
