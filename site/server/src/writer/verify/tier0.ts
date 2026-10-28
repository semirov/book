/**
 * Tier 0 — the countable half of verification (BOOK-173, BOOK-DOC-80 §"Tier 0 style invariants").
 *
 * This module answers only questions a rule can settle, and answers them over bytes:
 *
 *   · a 6-token n-gram repeated inside the changed span or its two neighbouring sentences;
 *   · a digit/date class the patch introduced or removed while the kinds stayed the same;
 *   · a banned-lexicon hit (the closed list, read from `style/VOICE.md` when that section exists);
 *   · a new sentence longer than 320 characters or shorter than 3 words;
 *   · a sentence that kept its words and changed its place — a **move**, which is a note, never
 *     a finding (the patch moved it; it did not write it).
 *
 * Nothing here calls a model, and nothing here is a judgement of prose: a finding is a code and a
 * number, and the pass parks on the code. The prose question is Tier 1's (`tier1.ts`).
 *
 * Pure by contract — the lexicon is given, not read, so a test drives every branch without a book
 * on disk. `loadLexicon` is the one function that reads a file, and it exists so there is exactly
 * **one** list: the section of `style/VOICE.md` if it exists, the module's fallback otherwise.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { splitSentences } from '@book/shared';

import { normaliseSentence } from '../../sentences/hash.ts';
import { changedRegion, type Region } from './region.ts';

/** What a 6-gram is: the design's number, not a tuning knob. */
export const NGRAM_TOKENS = 6;
/** The design's sentence bounds (§Tier 0). */
export const SENTENCE_MAX_CHARS = 320;
export const SENTENCE_MIN_WORDS = 3;
/** Findings are a park detail: bounded, so one bad paragraph cannot fill a log line. */
const MAX_FINDINGS = 8;

export type Tier0Code =
  | 'TIER0_REPEAT'
  | 'TIER0_NUMBER'
  | 'TIER0_LEXICON'
  | 'TIER0_SENTENCE_LONG'
  | 'TIER0_SENTENCE_SHORT';

export type Tier0Finding = { code: Tier0Code; detail: string; quote: string | null };
/** A move: the sentence ids were re-attached and the text hash did not move. Never a finding. */
export type Tier0Note = { code: 'TIER0_SENTENCE_MOVED'; detail: string };

export type Tier0Result = { ok: boolean; findings: Tier0Finding[]; notes: Tier0Note[] };

/** A sentence row whose id came back through the patch by hash: did its words move too? */
export type ReattachedSentence = { sentenceId: string; textHashMoved: boolean };

export type Tier0Input = {
  /** The chapter file before the landing. */
  before: string;
  /** The post-image the applier produced; the region is measured between the two. */
  after: string;
  chapter: number;
  /** The bytes the book will hold — the checks read these (the caller finalises before it writes). */
  text: string;
  /** The closed list; `loadLexicon(bookRoot)` is where a caller gets it. */
  lexicon: readonly string[];
  /** Re-attached sentence ids, when the caller has them (the ingest side does). */
  reattached?: readonly ReattachedSentence[];
};

/**
 * `style/VOICE.md` §«не говорим так» does not exist yet (2026-10-28), so the list lives here,
 * quoted from the sections the voice file does have («Запрещено:» in «Тоска» and «Страх»).
 * When the section appears, `lexiconSection` reads it and this constant stops being used — the
 * module keeps one list, never two live at once.
 */
export const BANNED_LEXICON: readonly string[] = [
  'русская душа',
  'славянская меланхолия',
  'восставшие машины',
  'роботы-антагонисты',
  'техно-хоррор',
  'ии уничтожит человечество',
];

/** The heading the voice file is expected to grow: `## Не говорим так`. */
const LEXICON_HEADING = /^#{1,6}\s+не\s+говорим\s+так\b/iu;

/**
 * The bullet list under the section, one entry per line, quotes and dashes stripped. An empty
 * result means «the section is there but carries no entries», and the fallback list stands.
 */
function lexiconSection(source: string): string[] {
  const lines = source.split('\n');
  const heading = lines.findIndex((line) => LEXICON_HEADING.test(line.trim()));
  if (heading === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed)) break;
    const bullet = /^[-*+]\s+(.*)$/u.exec(trimmed);
    if (bullet === null) continue;
    const entry = (bullet[1] ?? '').replace(/^[«"„]+|[»"“]+$/gu, '').trim().toLowerCase();
    if (entry.length > 0) out.push(entry);
  }
  return out;
}

/** The one list: the voice file's section when it exists, the module's fallback when it does not. */
export function loadLexicon(bookRoot: string): readonly string[] {
  try {
    const source = readFileSync(join(bookRoot, 'style', 'VOICE.md'), 'utf8');
    const listed = lexiconSection(source);
    if (listed.length > 0) return listed;
  } catch {
    // A book without the voice file is a caller's problem, not a licence to skip the list.
  }
  return BANNED_LEXICON;
}

function words(value: string): number {
  return (value.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}\u2026`;
}

type WindowToken = { word: string; at: number };

/** The window's sentences, tokenised with code-point offsets into the chapter. */
function windowTokens(text: string, region: Region, neighbours: number): WindowToken[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const touched = sentences
    .map((sentence, index) => ({ sentence, index }))
    .filter((entry) => entry.sentence.end > region.start && entry.sentence.start < region.end);
  const first = touched.length === 0 ? 0 : Math.max(0, (touched[0]?.index ?? 0) - neighbours);
  const last =
    touched.length === 0
      ? sentences.length - 1
      : Math.min(sentences.length - 1, (touched.at(-1)?.index ?? 0) + neighbours);
  const out: WindowToken[] = [];
  for (const sentence of sentences.slice(first, last + 1)) {
    for (const match of sentence.text.matchAll(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)) {
      // `match.index` is a UTF-16 index; a sentence's own offsets are code points.
      const offset = Array.from(sentence.text.slice(0, match.index)).length;
      out.push({ word: match[0].toLowerCase(), at: sentence.start + offset });
    }
  }
  return out;
}

/**
 * A run of six words that says itself twice in the window, with **at least one of the two
 * occurrences inside the changed span**: a repeat that only lives in the untouched neighbours was
 * there before the patch and is the chapter's business, not this change's finding.
 */
function repeatFinding(before: string, text: string): Tier0Finding | null {
  const region = changedRegion(before, text);
  const window = windowTokens(text, region, 2);
  if (window.length < NGRAM_TOKENS * 2) return null;
  const seen = new Map<string, number>();
  const gramAt = (index: number): string =>
    window
      .slice(index, index + NGRAM_TOKENS)
      .map((token) => token.word)
      .join(' ');
  const inside = (index: number): boolean => {
    const from = window[index];
    const to = window[index + NGRAM_TOKENS - 1];
    if (from === undefined || to === undefined) return false;
    return from.at < region.end && to.at >= region.start;
  };
  for (let index = 0; index + NGRAM_TOKENS <= window.length; index += 1) {
    const gram = gramAt(index);
    const first = seen.get(gram);
    if (first === undefined) {
      seen.set(gram, index);
      continue;
    }
    if (!inside(index) && !inside(first)) continue;
    return {
      code: 'TIER0_REPEAT',
      detail: `\u0448\u0435\u0441\u0442\u044c \u0441\u043b\u043e\u0432 \u043f\u043e\u0432\u0442\u043e\u0440\u044f\u044e\u0442\u0441\u044f \u0432 \u043f\u0440\u0430\u0432\u043a\u0435 \u0438 \u0435\u0451 \u0441\u043e\u0441\u0435\u0434\u044f\u0445: \u00ab${clip(gram, 80)}\u00bb`,
      quote: clip(gram, 80),
    };
  }
  return null;
}

type NumberKind = 'date' | 'document' | 'number';

const NUMBER_TOKEN = /\d[\d./-]*\d|\d/gu;
const DATE_DAY_MONTH = /^\d{1,2}[.]\d{1,2}(?:[.]\d{2,4})?$/u;
const DATE_ISO = /^\d{4}-\d{1,2}-\d{1,2}$/u;
const YEAR = /^(?:19|20)\d{2}$/u;

function kindOf(raw: string): NumberKind {
  const token = raw.replace(/[.]+$/u, '');
  if (DATE_DAY_MONTH.test(token) || DATE_ISO.test(token) || YEAR.test(token)) return 'date';
  if (/\d[/-]\d/u.test(token)) return 'document';
  return 'number';
}

function countKinds(text: string): Map<NumberKind, number> {
  const out = new Map<NumberKind, number>();
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const kind = kindOf(match[0]);
    out.set(kind, (out.get(kind) ?? 0) + 1);
  }
  return out;
}

/**
 * A digit/date class introduced or removed **without changing its kind**: the same kinds are in
 * the chapter on both sides and one of them counts differently. A swapped kind (a date became a
 * plain number) is a different question and is not this rule's.
 */
function numberFinding(before: string, text: string): Tier0Finding | null {
  const from = countKinds(before);
  const to = countKinds(text);
  const kinds = new Set([...from.keys(), ...to.keys()]);
  const beforeKinds = [...from.keys()].sort().join(',');
  const afterKinds = [...to.keys()].sort().join(',');
  if (beforeKinds !== afterKinds) return null;
  for (const kind of kinds) {
    const was = from.get(kind) ?? 0;
    const is = to.get(kind) ?? 0;
    if (was !== is) {
      const word = kind === 'date' ? 'дат' : kind === 'document' ? 'номеров документов' : 'чисел';
      return {
        code: 'TIER0_NUMBER',
        detail: `класс «${word}» изменился без смены вида: ${String(was)} → ${String(is)}`,
        quote: null,
      };
    }
  }
  return null;
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/** A banned word the patch brought into the chapter: an old hit is not this change's finding. */
function lexiconFinding(before: string, text: string, lexicon: readonly string[]): Tier0Finding | null {
  const was = before.toLowerCase();
  const is = text.toLowerCase();
  for (const entry of lexicon) {
    const now = occurrences(is, entry);
    if (now > occurrences(was, entry)) {
      return { code: 'TIER0_LEXICON', detail: `запрещённая лексика: «${entry}»`, quote: entry };
    }
  }
  return null;
}

function sentencesOf(text: string): string[] {
  return splitSentences(text).map((sentence) => normaliseSentence(sentence.text));
}

function sentenceFindings(before: string, text: string): Tier0Finding[] {
  const known = new Set(sentencesOf(before));
  const out: Tier0Finding[] = [];
  for (const sentence of splitSentences(text)) {
    const flat = normaliseSentence(sentence.text);
    if (known.has(flat)) continue;
    if (Array.from(sentence.text).length > SENTENCE_MAX_CHARS) {
      out.push({
        code: 'TIER0_SENTENCE_LONG',
        detail: `новое предложение длиной ${String(Array.from(sentence.text).length)} знаков (предел ${String(SENTENCE_MAX_CHARS)})`,
        quote: clip(sentence.text, 80),
      });
      continue;
    }
    if (words(sentence.text) < SENTENCE_MIN_WORDS) {
      out.push({
        code: 'TIER0_SENTENCE_SHORT',
        detail: `новое предложение короче ${String(SENTENCE_MIN_WORDS)} слов: «${clip(sentence.text, 60)}»`,
        quote: clip(sentence.text, 60),
      });
    }
  }
  return out;
}

/**
 * Sentences that survived the patch with their words and lost their place. The surviving
 * sentences are read in the *after* order and their before-indices must be increasing; the first
 * one out of order is a move. A changed word takes a sentence out of the set, so a word fix is
 * never mistaken for a move.
 */
function moveNotes(before: string, text: string, reattached: readonly ReattachedSentence[]): Tier0Note[] {
  const notes: Tier0Note[] = [];
  const from = sentencesOf(before);
  const position = new Map<string, number>();
  for (const [index, sentence] of from.entries()) if (!position.has(sentence)) position.set(sentence, index);
  let highest = -1;
  for (const sentence of sentencesOf(text)) {
    const index = position.get(sentence);
    if (index === undefined) continue;
    if (index < highest) {
      notes.push({ code: 'TIER0_SENTENCE_MOVED', detail: `предложение переставлено, а не переписано: «${clip(sentence, 80)}»` });
      break;
    }
    highest = index;
  }
  if (notes.length === 0) {
    // The ids the ingest re-attached: an id whose `text_hash` did not move is a move by definition.
    const unmoved = reattached.filter((entry) => !entry.textHashMoved);
    if (unmoved.length > 0) {
      notes.push({
        code: 'TIER0_SENTENCE_MOVED',
        detail: `id привязан заново без смены текста: ${unmoved.map((entry) => entry.sentenceId).join(', ')}`.slice(0, 200),
      });
    }
  }
  return notes;
}

/**
 * Every countable invariant at once. `ok` is `findings.length === 0`: a note never fails a patch
 * (a move is a move), and a finding always does.
 */
export function checkTier0(input: Tier0Input): Tier0Result {
  const before = input.before ?? '';
  const text = input.text ?? input.after ?? '';
  const findings: Tier0Finding[] = [];
  const push = (finding: Tier0Finding | null): void => {
    if (finding !== null && findings.length < MAX_FINDINGS) findings.push(finding);
  };
  push(repeatFinding(before, text));
  push(numberFinding(before, text));
  push(lexiconFinding(before, text, input.lexicon));
  for (const finding of sentenceFindings(before, text)) push(finding);
  return { ok: findings.length === 0, findings, notes: moveNotes(before, text, input.reattached ?? []) };
}

/** The park detail: codes and numbers, never a paragraph of prose. */
export function tier0Detail(result: Tier0Result): string {
  return result.findings.map((finding) => `${finding.code}: ${finding.detail}`).join(' · ').slice(0, 300);
}
