/**
 * Where a quote sits among the sentences of a block (ADR-044 §2.1, §5 step 3).
 *
 * A filing stores the reader's `quote` (the sentence they pointed at, clamped to 280 chars) plus
 * up to 40 characters of `prefix`/`suffix`. v25 gives that filing an id: the sentence row the
 * quote sits in, and the quote's own offsets inside it (`sel_start`/`sel_end`, code points).
 *
 * **The rule is «never guess».** A quote that is not found, that appears more than once with no
 * affix to tell the occurrences apart, or that straddles a boundary between two sentences gets
 * `null` and keeps its block anchor — the legacy fallback the reader already had. A wrong sentence
 * id is worse than no id: it would carry the filing's history to words the reader never touched.
 *
 * Offsets are code points throughout, the unit the schema stores, so a consumer that needs a
 * UTF-16 index for `String.prototype.slice` converts it (`utf16Index` in the shared segmenter)
 * instead of re-deriving the sentence.
 */

import type { Db } from '../db/db.ts';
import { listLiveSentences, type SentenceRow } from './store.ts';

/** The sentence a quote belongs to, and the quote's offsets inside it. */
export type QuotePlacement = { sentenceId: string; selStart: number; selEnd: number };

type Candidate = { start: number; end: number };

/** Every occurrence of `needle` in `haystack`, as code-point spans (`end` exclusive). */
function findOccurrences(haystack: readonly string[], needle: readonly string[]): Candidate[] {
  if (needle.length === 0 || needle.length > haystack.length) return [];
  const out: Candidate[] = [];
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[at + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) out.push({ start: at, end: at + needle.length });
  }
  return out;
}

/** The live sentence that wholly contains the candidate, or null when it straddles a boundary. */
function sentenceAround(sentences: readonly SentenceRow[], candidate: Candidate): SentenceRow | null {
  const found = sentences.find(
    (sentence) => sentence.start <= candidate.start && sentence.end >= candidate.end,
  );
  return found ?? null;
}

/**
 * The sentence a stored quote sits in, with the quote's offsets inside that sentence.
 *
 * `prefix`/`suffix` are consulted only when the quote occurs more than once: the same sentence can
 * repeat in a chapter (dialogue, a refrain), and the affixes the composer stored are exactly the
 * evidence that tells the occurrences apart. When they match nothing, the answer is null — the
 * text moved, and a placement picked from the wrong occurrence would be a fabrication.
 */
export function resolveQuoteSentence(
  db: Db,
  input: { blockId: string; quote: string | null; prefix?: string | null; suffix?: string | null },
): QuotePlacement | null {
  const quote = input.quote;
  if (quote === null || quote.length === 0) return null;
  const block = db.prepare('SELECT text FROM blocks WHERE id = ?').get(input.blockId) as
    | { text: string }
    | undefined;
  if (block === undefined) return null;

  const characters = Array.from(block.text);
  let candidates = findOccurrences(characters, Array.from(quote));
  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    const prefix = input.prefix ?? null;
    const suffix = input.suffix ?? null;
    const narrowed = candidates.filter((candidate) => {
      if (prefix !== null && prefix.length > 0) {
        const before = characters.slice(Math.max(0, candidate.start - prefix.length), candidate.start).join('');
        if (!before.endsWith(prefix)) return false;
      }
      if (suffix !== null && suffix.length > 0) {
        const after = characters.slice(candidate.end, candidate.end + suffix.length).join('');
        if (!after.startsWith(suffix)) return false;
      }
      return true;
    });
    // No affix evidence, or evidence that no longer matches: the quote is ambiguous, not placed.
    if (narrowed.length === 0) return null;
    candidates = narrowed;
  }

  const sentences = listLiveSentences(db, input.blockId);
  const placed = new Map<string, QuotePlacement>();
  for (const candidate of candidates) {
    const sentence = sentenceAround(sentences, candidate);
    if (sentence === null) continue;
    placed.set(sentence.id, {
      sentenceId: sentence.id,
      selStart: candidate.start - sentence.start,
      selEnd: candidate.end - sentence.start,
    });
  }
  // Two occurrences inside two different sentences is a genuine ambiguity: no id, no guess.
  if (placed.size !== 1) return null;
  return [...placed.values()][0] ?? null;
}

/** What the v25 re-anchor did, published in `meta` so the operator sees the NULL count. */
export type ReanchorCounts = { total: number; anchored: number; null: number };

/**
 * Re-anchor every stored filing that has a block and a quote (ADR-044 §5 step 3).
 *
 * `total` counts exactly those rows; a comment with no quote or no block is not touched and not
 * counted, because nothing about it changed. `null` is published, never reduced by guessing: the
 * honest answer for a quote that straddles a boundary or is no longer in the block is a block
 * anchor with no sentence, which is what every filing had before v25.
 */
export function reanchorComments(db: Db): ReanchorCounts {
  const rows = db
    .prepare(
      `SELECT id, block_id, quote, prefix, suffix FROM comments
        WHERE block_id IS NOT NULL AND quote IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    block_id: string;
    quote: string;
    prefix: string | null;
    suffix: string | null;
  }>;
  const write = db.prepare('UPDATE comments SET sentence_id = ?, sel_start = ?, sel_end = ? WHERE id = ?');
  let anchored = 0;
  let unplaced = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      const placement = resolveQuoteSentence(db, {
        blockId: row.block_id,
        quote: row.quote,
        prefix: row.prefix,
        suffix: row.suffix,
      });
      if (placement === null) {
        write.run(null, null, null, row.id);
        unplaced += 1;
        continue;
      }
      write.run(placement.sentenceId, placement.selStart, placement.selEnd, row.id);
      anchored += 1;
    }
  });
  run();
  return { total: rows.length, anchored, null: unplaced };
}
