/**
 * The prose's facts, as the backfill reads them (BOOK-173, BOOK-DOC-75 §1.1, §1.3).
 *
 * This is the deterministic extractor the research measured (BOOK-173 #3867), turned into product
 * code with the one repair the measurement demanded: **a document is an instance, not a bucket.**
 * «протокол 14-УП» and «протокол 15-УП» are two papers with two identities, so a ripple can say
 * that one of them changed; the five noun buckets the ledger had could say nothing. What is read:
 *
 *   · document instances — a noun of the closed list plus the number or case id that follows it,
 *     with the status verb nearest to it in the sentence;
 *   · numbers and dates — six literal shapes (case number, code, `№`, date, clock, year);
 *   · promises — the index's own promise markers (`index/extract.ts`, one rule, two readers);
 *   · irreversible acts — a closed verb list after which the world cannot go back;
 *   · decisions — the paperwork saying «this is decided».
 *
 * Every fact carries the code-point span of the text that states it, so `backfill.ts` can write a
 * mention whose witness is that very text. Nothing here calls a model, reads a clock or writes a
 * row; the same block text always produces the same facts in the same order.
 */

import { DOCUMENT_NOUNS } from '../../index/extract.ts';
import type { ChapterIndex } from '../../index/types.ts';
import { cpOffsetOf } from '../spans.ts';
import { STATUS_VERBS } from './components.ts';

export type FactKind = 'document' | 'decision' | 'testimony' | 'erasure' | 'state';

/** One fact the prose states, with the span that states it. */
export type FactCandidate = {
  /** Deterministic, and it carries the identity the ledger was missing. */
  factId: string;
  /** The block whose text states it — the address a mention and a patch point at. */
  blockId: string;
  kind: FactKind;
  /** The claim, verbatim, ≤160 code points — the design's quote obligation. */
  statement: string;
  /** The canonical surface a later mention binds to. */
  term: string;
  /** Code-point offsets of the witness in the block text. */
  start: number;
  end: number;
  /** Sentence index inside the block, for the causally-near rules. */
  si: number;
  /** The paper's instance key (documents only). */
  docKey?: string;
  /** Literal numbers and dates the sentence asserts, normalised. */
  numbers: string[];
  /** Entity keys the sentence names. */
  entities: string[];
  /** The promise marker, when this fact is a promise. */
  marker?: string;
  /** The status verb nearest to the paper (documents only) — the evidence a chain is told with. */
  status?: string;
};

/** The quote bound of BOOK-DOC-75 §1.1: a fact's statement is ≤160 characters. */
export const STATEMENT_LIMIT = 160;

/** `65/11877/арх`, `14-УП`, `4-У`, `№ 1136` — the number that names a paper. */
const INSTANCE_NUMBER = /^\s*(?:№\s*)?(\d+(?:[-/]\s*[\p{L}\d]+)*)/u;
const DOCUMENT_PATTERN = new RegExp(`(?<![\\p{L}])(?:${DOCUMENT_NOUNS.join('|')})(?![\\p{L}])`, 'giu');
const STATUS_PATTERN = new RegExp(`(?<![\\p{L}])(?:${STATUS_VERBS.join('|')})\\p{L}*`, 'giu');

/** Six literal shapes, copied from the measured extractor (research `ledger.mjs`). */
const NUMBER_RES: Array<{ name: string; re: RegExp }> = [
  { name: 'case', re: /(?<![\p{L}\d])\d{1,4}(?:\s*[/-]\s*\d{2,6})+(?:\s*[/-]\s*[а-яёa-zА-ЯЁA-Z]{1,6})?(?![\p{L}\d])/gu },
  { name: 'code', re: /(?<![\p{L}\d])\d{1,4}-(?:\p{Lu}{1,3})(?![\p{L}])/gu },
  { name: 'numbered', re: /№\s*\d+/gu },
  { name: 'date', re: /(?<![\d.])\d{1,2}\.\d{2}\.\d{2,4}(?![\d])/gu },
  { name: 'clock', re: /(?<![\d:])\d{1,2}:\d{2}(?![\d])/gu },
  { name: 'year', re: /(?<![\d.])(?:1[89]\d{2}|20\d{2})(?![\d])/gu },
];

/**
 * Irreversible acts: the extractor's only hand-written semantic list. A verb in this list closes a
 * possibility — a person is gone, a paper is signed, a case is closed — so the propositions that
 * stood on it cannot silently keep standing.
 */
export const IRREVERSIBLE_VERBS = [
  'умер', 'умерла', 'умерли', 'умирал', 'погиб', 'убит', 'расстрел', 'подписан', 'выдан', 'отказ',
  'отказал', 'уничтожен', 'арестован', 'закрыт', 'внес', 'прекращ', 'отмен', 'аннулирован', 'изъят',
  'сдан', 'уволен', 'исключ', 'списан', 'снес', 'сожж', 'утрачен', 'пропал', 'исполнен', 'назначен',
] as const;
const IRREVERSIBLE_RE = new RegExp(`(?<![\\p{L}])(?:${IRREVERSIBLE_VERBS.join('|')})\\p{L}*`, 'giu');

/** A verb of removal: the act is not only irreversible, the thing itself is gone. */
const REMOVAL_VERBS = ['уничтожен', 'изъят', 'сдан', 'утрачен', 'пропал', 'списан', 'снес', 'сожж', 'исключ'] as const;
const REMOVAL_RE = new RegExp(`(?<![\\p{L}])(?:${REMOVAL_VERBS.join('|')})\\p{L}*`, 'giu');

const DECISION_RE = new RegExp(
  '(?<![\\p{L}])(?:решено|решени\\p{L}*|постановил\\p{L}*|распорядил\\p{L}*|приказ\\p{L}*|утвержд\\p{L}*|определил\\p{L}*)',
  'giu',
);

export type Sentence = { text: string; start: number; end: number };

/** The block's sentences with their code-point spans — the offsets a mention is written with. */
export function sentenceSpans(text: string): Sentence[] {
  const out: Sentence[] = [];
  let from = 0;
  const push = (start: number, end: number): void => {
    let left = start;
    let right = end;
    while (left < right && /\s/u.test(text[left] ?? '')) left += 1;
    while (right > left && /\s/u.test(text[right - 1] ?? '')) right -= 1;
    if (right <= left) return;
    out.push({ text: text.slice(left, right), start: cpOffsetOf(text, left), end: cpOffsetOf(text, right) });
  };
  for (const match of text.matchAll(/(?<=[.!?…])\s+/gu)) {
    push(from, match.index);
    from = match.index + match[0].length;
  }
  push(from, text.length);
  return out;
}

function normaliseNumber(raw: string): string {
  return raw.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, '');
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\d/_-]/gu, '');
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= STATEMENT_LIMIT ? flat : `${flat.slice(0, STATEMENT_LIMIT - 1)}…`;
}

/** The code-point span of a UTF-16 slice of the block, as a mention needs it. */
function spanOf(block: string, index: number, length: number): { start: number; end: number } {
  return { start: cpOffsetOf(block, index), end: cpOffsetOf(block, index + length) };
}

/** The status verb nearest to a position in a sentence, as the index reads it. */
function statusNear(sentence: string, at: number): string | null {
  let best: { status: string; distance: number } | null = null;
  for (const match of sentence.matchAll(STATUS_PATTERN)) {
    const distance = Math.abs((match.index ?? 0) - at);
    if (best === null || distance < best.distance) best = { status: match[0].toLowerCase(), distance };
  }
  return best?.status ?? null;
}

/** Noun + the number that names it, with the code-point span of both. */
function documentMentions(sentence: string): Array<{ surface: string; key: string; start: number; end: number; statusAt: number }> {
  const found: Array<{ surface: string; key: string; start: number; end: number; statusAt: number }> = [];
  for (const match of sentence.matchAll(DOCUMENT_PATTERN)) {
    const start = match.index ?? 0;
    const tail = sentence.slice(start + match[0].length);
    const number = INSTANCE_NUMBER.exec(tail);
    const surface = number === null ? match[0] : `${match[0]} ${(number[1] ?? '').replace(/\s+/gu, '')}`.trim();
    found.push({
      surface,
      key: slug(surface),
      start,
      // `INSTANCE_NUMBER` is anchored, so its whole match is the run from the noun to the number.
      end: start + match[0].length + (number === null ? 0 : number[0].length),
      statusAt: start + match[0].length,
    });
  }
  return found;
}

function numbersIn(sentence: string): Array<{ raw: string; norm: string; start: number; end: number }> {
  const found: Array<{ raw: string; norm: string; start: number; end: number }> = [];
  const taken: Array<{ start: number; end: number }> = [];
  for (const { re } of NUMBER_RES) {
    for (const match of sentence.matchAll(re)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (taken.some((span) => start < span.end && end > span.start)) continue;
      taken.push({ start, end });
      found.push({ raw: match[0], norm: normaliseNumber(match[0]), start, end });
    }
  }
  return found;
}

function firstWordAt(text: string, needle: string): number {
  // Russian lowercasing is 1:1 in code units, so an index survives it; the marker came from the
  // index, which matched the same word in the same text.
  return text.toLowerCase().indexOf(needle.toLowerCase());
}

export type ChapterSentenceSource = { id: string; text: string };

export type ChapterFactsInput = {
  blocks: ReadonlyArray<ChapterSentenceSource>;
  /** `extractChapter` of the same paragraphs: one reader of names and promises, two consumers. */
  index: ChapterIndex;
};

/**
 * Every fact one chapter states, in reading order. A document instance is one fact **per chapter**,
 * with the last status the chapter gives it (the index's own rule) — so «issued in ch05, quoted in
 * ch12» is two facts and one edge, which is what a walk can cross.
 */
export function chapterFacts(input: ChapterFactsInput): FactCandidate[] {
  const facts: FactCandidate[] = [];
  input.blocks.forEach((block, index) => {
    const entities = input.index.entities.filter((entity) =>
      entity.mentions.some((mention) => mention.paragraph === index),
    );
    const promises = input.index.promises.filter((promise) => promise.paragraph === index);
    const sentences = sentenceSpans(block.text);
    const docLast = new Map<string, { fact: FactCandidate; si: number }>();

    sentences.forEach((sentence, si) => {
      const sentenceNumbers = numbersIn(sentence.text);
      const entityKeys = entities
        .filter((entity) => entity.surfaces.some((surface) => sentence.text.toLowerCase().includes(surface.toLowerCase())))
        .map((entity) => entity.key)
        .sort();
      const numbers = [...new Set(sentenceNumbers.map((item) => item.norm))].sort();
      const docMentions = documentMentions(sentence.text);

      for (const mention of docMentions) {
        const status = statusNear(sentence.text, mention.statusAt);
        const span = spanOf(block.text, sentence.start + mention.start, mention.end - mention.start);
        docLast.set(mention.key, {
          si,
          fact: {
            factId: `f:d:${mention.key}@${block.id}`,
            blockId: block.id,
            kind: 'document',
            statement: clip(sentence.text),
            term: mention.surface,
            start: span.start,
            end: span.end,
            si,
            docKey: mention.key,
            numbers,
            entities: entityKeys,
            ...(status === null ? {} : { status }),
          },
        });
      }

      for (const number of sentenceNumbers) {
        const span = spanOf(block.text, sentence.start + number.start, number.end - number.start);
        facts.push({
          factId: `f:n:${number.norm}@${block.id}#${String(si)}`,
          blockId: block.id,
          kind: 'state',
          statement: clip(sentence.text),
          term: number.raw,
          start: span.start,
          end: span.end,
          si,
          numbers,
          entities: entityKeys,
        });
      }

      IRREVERSIBLE_RE.lastIndex = 0;
      const irreversible = IRREVERSIBLE_RE.exec(sentence.text);
      IRREVERSIBLE_RE.lastIndex = 0;
      if (irreversible !== null) {
        const span = spanOf(block.text, sentence.start + irreversible.index, irreversible[0].length);
        REMOVAL_RE.lastIndex = 0;
        const removal = REMOVAL_RE.test(sentence.text);
        REMOVAL_RE.lastIndex = 0;
        facts.push({
          factId: `f:i:${block.id}#${String(si)}`,
          blockId: block.id,
          kind: removal ? 'erasure' : 'state',
          statement: clip(sentence.text),
          term: irreversible[0].toLowerCase(),
          start: span.start,
          end: span.end,
          si,
          numbers,
          entities: entityKeys,
        });
      }

      DECISION_RE.lastIndex = 0;
      const decision = DECISION_RE.exec(sentence.text);
      DECISION_RE.lastIndex = 0;
      if (decision !== null) {
        const span = spanOf(block.text, sentence.start + decision.index, decision[0].length);
        facts.push({
          factId: `f:dec:${block.id}#${String(si)}`,
          blockId: block.id,
          kind: 'decision',
          statement: clip(sentence.text),
          term: decision[0].toLowerCase(),
          start: span.start,
          end: span.end,
          si,
          numbers,
          entities: entityKeys,
        });
      }
    });

    for (const entry of [...docLast.values()].sort((left, right) =>
      left.fact.factId < right.fact.factId ? -1 : 1,
    )) {
      facts.push(entry.fact);
    }

    for (const promise of promises) {
      const at = firstWordAt(block.text, promise.marker);
      const span = at < 0 ? { start: 0, end: 0 } : spanOf(block.text, at, promise.marker.length);
      if (span.end <= span.start) continue;
      facts.push({
        factId: `f:p:${slug(promise.marker)}@${block.id}`,
        blockId: block.id,
        kind: 'testimony',
        statement: clip(promise.text),
        term: promise.marker,
        start: span.start,
        end: span.end,
        si: 0,
        marker: promise.marker,
        numbers: numbersIn(promise.text).map((item) => item.norm).sort(),
        entities: entities
          .filter((entity) => entity.surfaces.some((surface) => promise.text.toLowerCase().includes(surface.toLowerCase())))
          .map((entity) => entity.key)
          .sort(),
      });
    }
  });

  // Stable order inside a block: by span, then by id — the reading order a pos is assigned from.
  // One mention per fact, so two facts may not claim the same span: «приказ» is both a document
  // noun and a decision verb, and the same word is one statement. The document wins (it sorts
  // first by id), the number in front of it loses, and the count stays honest.
  const ordered = facts.sort((left, right) => left.start - right.start || (left.factId < right.factId ? -1 : 1));
  const seen = new Set<string>();
  return ordered.filter((fact) => {
    const key = `${fact.blockId}|${String(fact.start)}|${String(fact.end)}`;
    if (seen.has(key) || seen.has(`id:${fact.factId}`)) return false;
    seen.add(key);
    seen.add(`id:${fact.factId}`);
    return true;
  });
}
