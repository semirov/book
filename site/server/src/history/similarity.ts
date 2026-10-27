/**
 * How much two paragraphs are "the same paragraph" (ARCHITECTURE.md §6F.3).
 *
 * A rewrite replaces the text of a block, so its content-derived id changes. To keep the
 * paragraph's *identity* the log compares the old and new text: at or above the SPEC's
 * threshold a reader is told «переписано» (one paragraph rewritten), below it the old block
 * is «убрана» and the new one is born. The measure is the Dice coefficient over character
 * bigrams of the normalized text — cheap, deterministic and order-sensitive, which is what
 * a rewritten sentence is.
 */

/** §6F.3: at this share the paragraph is treated as the same paragraph, rewritten. */
export const REPLACE_SIMILARITY = 0.6;

/** Lowercase, collapse whitespace, drop punctuation that carries no identity. */
export function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Dice coefficient in 0..1; identical text is 1, no shared bigram is 0. */
export function textSimilarity(left: string, right: string): number {
  const a = normalizeForSimilarity(left);
  const b = normalizeForSimilarity(right);
  if (a.length === 0 || b.length === 0) return a === b ? 1 : 0;
  if (a === b) return 1;
  // A single character has no bigram; compare it directly.
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const first = bigrams(a);
  const second = bigrams(b);
  let shared = 0;
  for (const [gram, count] of first) {
    const other = second.get(gram);
    if (other !== undefined) shared += Math.min(count, other);
  }
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/**
 * Pair old and new paragraphs greedily by similarity, strongest pair first. Deterministic:
 * equal scores fall back to the earlier position on both sides, so replaying the same
 * revision always produces the same chain.
 */
export type BlockPair = { oldIndex: number; newIndex: number; score: number };

export function pairBySimilarity(
  before: ReadonlyArray<{ text: string; hash: string }>,
  after: ReadonlyArray<{ text: string; hash: string }>,
  threshold: number = REPLACE_SIMILARITY,
): BlockPair[] {
  const takenOld = new Set<number>();
  const takenNew = new Set<number>();
  const pairs: BlockPair[] = [];

  // An untouched paragraph is the same element at any position: exact identity first.
  for (let newIndex = 0; newIndex < after.length; newIndex += 1) {
    const hash = after[newIndex]?.hash;
    if (hash === undefined) continue;
    const oldIndex = before.findIndex((block, index) => !takenOld.has(index) && block.hash === hash);
    if (oldIndex === -1) continue;
    takenOld.add(oldIndex);
    takenNew.add(newIndex);
    pairs.push({ oldIndex, newIndex, score: 1 });
  }

  const candidates: BlockPair[] = [];
  for (let oldIndex = 0; oldIndex < before.length; oldIndex += 1) {
    if (takenOld.has(oldIndex)) continue;
    const oldBlock = before[oldIndex];
    if (oldBlock === undefined) continue;
    for (let newIndex = 0; newIndex < after.length; newIndex += 1) {
      if (takenNew.has(newIndex)) continue;
      const newBlock = after[newIndex];
      if (newBlock === undefined) continue;
      const score = textSimilarity(oldBlock.text, newBlock.text);
      if (score >= threshold) candidates.push({ oldIndex, newIndex, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.oldIndex - right.oldIndex || left.newIndex - right.newIndex);
  for (const candidate of candidates) {
    if (takenOld.has(candidate.oldIndex) || takenNew.has(candidate.newIndex)) continue;
    takenOld.add(candidate.oldIndex);
    takenNew.add(candidate.newIndex);
    pairs.push(candidate);
  }
  return pairs;
}
