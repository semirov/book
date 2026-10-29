/**
 * The fact-shaped recogniser (ADR-043 D4, L8; BOOK-176).
 *
 * It answers one question and only one: **does this text contain a carrier a machine can be
 * certain about?** A full date, a day and a month with no year (`19.02`, ADR-043 §2.2), an `n/m`
 * document number, a `№` reference. Nothing softer — a name, a term, an implied decision —
 * because a recogniser that guesses is worse than a counted gap: the land refuses on what it can
 * prove, and the gap counts what it cannot.
 *
 * A recognised token is **not** a fact. It is the floor: the text of a chapter may not contain
 * one without a fact mention covering it (`FACT_SHAPED_UNBOUND`), which is how a chapter full of
 * dates stops looking like a chapter that has nothing worth recording.
 *
 * Pure and offsets-in-code-points, like the rest of the ledger: `find` returns positions a
 * mention can be compared with, and never a normalised value (that is `mentions.ts`'s job).
 */

import type { Db } from '../db/db.ts';

export type FactShapedToken = {
  raw: string;
  kind: 'date' | 'document' | 'reference';
  /** Code-point offsets of `raw` in the text that was searched. */
  start: number;
  end: number;
};

/** `14.09.2065`, `14/09/2065`, `2065-09-14`. */
const DOTTED_DATE_RE = /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/gu;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/gu;
/**
 * `19.02`, `20.02` — a day and a month as the office stamps them (ADR-043 §2.2 names `19.02` as a
 * date example). A full date that starts at the same place is longer and wins the overlap rule
 * below, so `14.09.2065` stays one token; this form is what is left when the year is not written.
 */
const MONTH_DAY_RE = /(?<!\d)(\d{1,2})\.(\d{1,2})(?!\d)/gu;

/**
 * Contexts where `n.m` is a clause, an article or a figure rather than a date: «пунктом 6.2»,
 * «ст. 4.2», «рис. 3.1», «форма 2.1». A decimal with a percent sign is not a date either.
 */
const NOT_A_DATE_BEFORE = /(?:пункт\p{L}*|пп?\.|ст\.|ч\.|раздел\p{L}*|форм\p{L}*|рис\.)\s*$/iu;
const PERCENT_AFTER = /^\s*%/u;

/** `65/11877/арх` — a document number as the book writes it. */
const DOCUMENT_RE = /(\d{1,4})\s*\/\s*(\d{1,6})\s*\/\s*([A-Za-zА-Яа-яЁё]+)/gu;
/** `№ 1136`, `№ 44/17-ДОП`. */
const REFERENCE_RE = /№\s*\d[0-9A-Za-zА-Яа-яЁё/-]*/gu;

type RawHit = { raw: string; kind: FactShapedToken['kind']; index: number };

/** Code-point offset of a UTF-16 index — the one conversion this module needs. */
function cpOffsetOf(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

function collect(text: string): RawHit[] {
  const hits: RawHit[] = [];
  for (const match of text.matchAll(ISO_DATE_RE)) hits.push({ raw: match[0], kind: 'date', index: match.index });
  for (const match of text.matchAll(DOTTED_DATE_RE)) hits.push({ raw: match[0], kind: 'date', index: match.index });
  for (const match of text.matchAll(DOCUMENT_RE)) hits.push({ raw: match[0], kind: 'document', index: match.index });
  for (const match of text.matchAll(REFERENCE_RE)) hits.push({ raw: match[0], kind: 'reference', index: match.index });
  for (const match of text.matchAll(MONTH_DAY_RE)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    const before = text.slice(Math.max(0, match.index - 16), match.index);
    if (NOT_A_DATE_BEFORE.test(before)) continue;
    if (PERCENT_AFTER.test(text.slice(match.index + match[0].length))) continue;
    hits.push({ raw: match[0], kind: 'date', index: match.index });
  }
  // Earliest first, longest at one position; whatever overlaps an accepted token loses, so
  // `№ 44/17-ДОП` is one reference and never a reference plus a fragment of itself.
  hits.sort((left, right) => left.index - right.index || right.raw.length - left.raw.length);
  const accepted: RawHit[] = [];
  for (const candidate of hits) {
    const end = candidate.index + candidate.raw.length;
    const clash = accepted.some((other) => candidate.index < other.index + other.raw.length && end > other.index);
    if (!clash) accepted.push(candidate);
  }
  return accepted;
}

/** Every fact-shaped carrier of a text, in order, in code-point offsets. */
export function findFactShaped(text: string): FactShapedToken[] {
  if (text === '') return [];
  return collect(text).map((hit) => ({
    raw: hit.raw,
    kind: hit.kind,
    start: cpOffsetOf(text, hit.index),
    end: cpOffsetOf(text, hit.index + hit.raw.length),
  }));
}

/** One unbound carrier, as the operator's queue shows it. */
export type FactShapedSample = { blockId: string; raw: string; start: number; end: number };

export type FactShapedGap = { count: number; samples: FactShapedSample[] };

/** How many samples a warning keeps: a count and a few places, never a chapter of quotes. */
export const FACT_SHAPED_SAMPLES = 5;

/**
 * The tokens of a chapter's live text that no fact mention covers — the **gap** of ADR-043 D9.
 *
 * `blocks` lets a caller measure the text it is about to publish (the applier passes the edited
 * blocks after the rename, before the chapter row is updated). Without it the live projection is
 * read, which is what the migration and a report want.
 *
 * A coverage test is an overlap, not an equality: a date covered by a wider fact span
 * (a clause asserting the whole sentence) is covered.
 */
export function unboundFactShaped(
  db: Db,
  chapter: number,
  blocks?: ReadonlyArray<{ id: string; text: string }>,
): FactShapedGap {
  const rows =
    blocks === undefined
      ? (db.prepare('SELECT id, text FROM blocks WHERE chapter = ? ORDER BY idx').all(chapter) as Array<{
          id: string;
          text: string;
        }>)
      : blocks;
  const covered = db
    .prepare(`SELECT block_id, start, end FROM mentions WHERE chapter = ? AND kind = 'fact'`)
    .all(chapter) as Array<{ block_id: string; start: number; end: number }>;
  const byBlock = new Map<string, Array<{ start: number; end: number }>>();
  for (const mention of covered) {
    const list = byBlock.get(mention.block_id) ?? [];
    list.push({ start: mention.start, end: mention.end });
    byBlock.set(mention.block_id, list);
  }
  const samples: FactShapedSample[] = [];
  let count = 0;
  for (const block of rows) {
    const spans = byBlock.get(block.id) ?? [];
    for (const token of findFactShaped(block.text)) {
      const bound = spans.some((span) => token.start < span.end && token.end > span.start);
      if (bound) continue;
      count += 1;
      if (samples.length < FACT_SHAPED_SAMPLES) {
        samples.push({ blockId: block.id, raw: token.raw, start: token.start, end: token.end });
      }
    }
  }
  return { count, samples };
}

/** The gap as one number — the value stored in `chapters.ledger_gap`. */
export function countUnboundFactShaped(
  db: Db,
  chapter: number,
  blocks?: ReadonlyArray<{ id: string; text: string }>,
): number {
  return unboundFactShaped(db, chapter, blocks).count;
}
