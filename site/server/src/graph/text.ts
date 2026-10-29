/**
 * The arithmetic the graph extraction is built on (BOOK-185).
 *
 * Three things, and only three: where a sentence begins and ends inside a block, how a surface
 * becomes a key, and how long a quote may be. Offsets are **code points** — the same unit the
 * ledger stores (`spans.ts`) and the mentions table promises — so a recogniser that matched on a
 * UTF-16 index and a mention that stores a code-point offset cannot drift apart silently.
 *
 * Sentences are split inside one block, never across two: a fact is asserted by a paragraph, and
 * a sentence that ran across a paragraph boundary would produce a quote no block contains.
 */

import { cpLength, cpOffsetOf } from '../ledger/spans.ts';
import { sha1Hex } from '../util/hash.ts';

export type Sentence = {
  text: string;
  /** Code-point offsets of `text` in the block it was cut from. */
  start: number;
  end: number;
};

/** A full stop, `?`, `!` or `…` and the whitespace after it. `splitSentences` in the index reads
 * the same rule, and a second one here would make two modules disagree about «one sentence». */
const BREAK = /[.!?…]+\s+/gu;

function cut(text: string, from: number, to: number): Sentence {
  let start = from;
  let end = to;
  while (start < end && /\s/u.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
  return { text: text.slice(start, end), start: cpOffsetOf(text, start), end: cpOffsetOf(text, end) };
}

/**
 * The sentences of one block, in order, with their offsets.
 *
 * A break after a single capital letter is **not** a break: this book names people as «Сорокин
 * А. В.», and a splitter that reads the initial's full stop as the end of a sentence would cut
 * every person in half — the initials carrier would never be seen, and a fact about a person
 * would never exist. A one-letter word ending a sentence is rarer than an initial, and the cost
 * of merging two sentences is one longer quote, not a lost carrier.
 */
export function sentencesOf(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  if (text.trim() === '') return sentences;
  let from = 0;
  for (const match of text.matchAll(BREAK)) {
    if (isInitialStop(text, match.index)) continue;
    const end = match.index + match[0].length;
    sentences.push(cut(text, from, end));
    from = end;
  }
  sentences.push(cut(text, from, text.length));
  return sentences.filter((sentence) => sentence.text !== '');
}

/** `…С.` — one capital letter then a full stop, standing as its own word. */
function isInitialStop(text: string, index: number): boolean {
  const stop = text[index];
  if (stop !== '.') return false;
  const before = text[index - 1];
  if (before === undefined || !/\p{Lu}/u.test(before)) return false;
  const boundary = text[index - 2];
  return boundary === undefined || /[\s(«"]/u.test(boundary);
}

/** Lowercase, `ё` folded to `е`, inner whitespace collapsed: the one normal form keys are built
 * from, so «Ковалёв» and «ковалев» cannot become two facts. */
export function normalise(value: string): string {
  return value.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

/** Code-point clipping with a visible tail, so a stored quote never ends mid-word silently. */
export function clip(value: string, max: number): string {
  if (cpLength(value) <= max) return value;
  return `${Array.from(value).slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** `thr_<sha1(key)[0..20]>` and `dep_<sha1(signature)[0..20]>`: an identity that survives a re-run
 * of the same extraction, because it is derived from the evidence and not from a clock. */
export function idOf(prefix: string, signature: string): string {
  return `${prefix}_${sha1Hex(signature).slice(0, 20)}`;
}

/** A recogniser hit: the matched surface and its code-point offsets in the text searched. */
export type Hit = { raw: string; start: number; end: number };

/** Earliest first, longest at one position; a hit that overlaps an accepted one loses. */
export function dedupeHits<T extends Hit>(hits: T[]): T[] {
  const sorted = [...hits].sort((left, right) => left.start - right.start || right.end - left.end);
  const accepted: T[] = [];
  for (const hit of sorted) {
    if (accepted.some((other) => hit.start < other.end && hit.end > other.start)) continue;
    accepted.push(hit);
  }
  return accepted;
}

/**
 * Run a global pattern over `text` and report every hit in code points. The conversion happens
 * here once, so no recogniser has to remember that `match.index` is a UTF-16 unit.
 */
export function hitsOf(text: string, pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const start = cpOffsetOf(text, match.index);
    hits.push({ raw, start, end: start + cpLength(raw) });
  }
  return hits;
}
