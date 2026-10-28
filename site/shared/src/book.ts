/**
 * The book model (ARCHITECTURE.md §6C, §6D, §23.5): numbering, part ranges, the fixed
 * numbers two components must agree on, and the two text shapes the book has — a chapter
 * title line and the front matter (title + annotation).
 *
 * One implementation, two callers: ingestion (`server/src/ingest`) and the validator
 * (`shared/src/validate`). A second parser would drift, and a drifted title line is a
 * chapter whose prose is silently counted as its title.
 */

export const TOTAL_CHAPTERS = 42;

/**
 * The chapter that opens the book. Like the finale it stands outside the parts, and it is the
 * one that carries the first frozen sentence — named here so `scripts/lib/frame.mjs` reads the
 * number instead of restating it.
 */
export const OPENING_CHAPTER = 1;

/** Last chapter of the forward drafting lane. */
export const FORWARD_LAST = 21;
/** First chapter of the backward drafting lane. */
export const BACKWARD_FIRST = 22;

export type Direction = 'forward' | 'backward';
export type Part = 1 | 2 | 3 | 4;

/**
 * Four numbered parts of ten chapters each, no content meaning (§6C.1). The split is a
 * numbering convention: three components (TOC, catalog, lane boundaries) must agree on it and
 * only one is a UI. Chapter 1 (the opening) and chapter `TOTAL_CHAPTERS` (the finale) stand
 * outside the parts, so the ranges start at 2 and end at `TOTAL_CHAPTERS - 1`.
 */
export const PART_RANGES: ReadonlyArray<{ part: Part; from: number; to: number }> = [
  { part: 1, from: 2, to: 11 },
  { part: 2, from: 12, to: 21 },
  { part: 3, from: 22, to: 31 },
  { part: 4, from: 32, to: 41 },
];

/** The only length numbers in the system (§6D.1, ADR-025 amended by ADR-031). */
export const CHAPTER_CHARS = {
  /** Shorter than a page is a slot, not a chapter. */
  floor: 1_600,
  /**
   * A chapter below this is `thin` — a warning while the book is being written (BOOK-160,
   * owner 2026-10-28: «полоса 10–30к»). A permission, not a target: 10 000 is short for a
   * novel chapter, and a short one is acceptable only where the chapter is a document, a
   * report or a hard cut — never as the normal shape of prose.
   */
  min: 10_000,
  target: 25_000,
  /** Above this is an error: three roles cannot read it inside one step's budget. */
  max: 30_000,
} as const;

/**
 * One page of prose (BOOK-89): PAGE_CHARS characters per line × 27 lines at PT Serif 18/30.24 in
 * the 600px measure ≈ 1800 — a normal A5 page. The page is a projection of the text, never a
 * stored field: `shared/src/pages.ts` turns it into chapter start pages, the TOC and the
 * reader's folio read those numbers, and no other module owns a second count.
 */
export const PAGE_CHARS = 1800;

/** Floor and ceiling of the whole book (§6D.1); F026 binds it at closure (M7). */
export const BOOK_CHARS = {
  min: TOTAL_CHAPTERS * CHAPTER_CHARS.floor,
  max: TOTAL_CHAPTERS * CHAPTER_CHARS.max,
} as const;

export const TITLE_MAX_CHARS = 80;
export const ABOUT_MIN_CHARS = 300;
/** The annotation is prose the owner writes whole: seven paragraphs and ~1 600 characters today. */
export const ABOUT_MAX_CHARS = 4_000;
export const ABOUT_MAX_BLOCKS = 12;

/**
 * The named refusal of a pass that would rewrite page 2 (BOOK-DOC-6): the title is a slot, the
 * annotation is basis. One copy, so the gate, the ingest and the tests say the same word.
 */
export const FRONT_ANNOTATION_FROZEN = 'FRONT_ANNOTATION_FROZEN';

/** The front-matter file; it sorts before `ch01.md` and can never collide with a chapter. */
export const FRONT_FILE = '00-front.md';

/** The SPEC's copyright line and author, exact strings (§6C.6, F020). */
export const IMPRINT_AUTHOR = 'Филипп Семиров';
export const IMPRINT_COPYRIGHT = '© Филипп Семиров';

/**
 * The frozen frame (F029) — the one piece of text the owner fixed himself: chapter 1 opens
 * with it and chapter 42 closes with it. Nobody edits these sentences: not the writer, not
 * a ripple, not a reader's change. One copy, so the validator and the engine cannot disagree
 * about what "the frame" is.
 */
export const FRAME_FIRST_SENTENCE = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
export const FRAME_LAST_SENTENCE = 'Свет погас, потому что не осталось глаз, которым он был бы нужен.';

/** The basis sentence a chapter carries, or null when the chapter has none. */
export function frameSentenceOf(n: number): string | null {
  if (n === 1) return FRAME_FIRST_SENTENCE;
  if (n === TOTAL_CHAPTERS) return FRAME_LAST_SENTENCE;
  return null;
}

/**
 * The prose of a slot that holds nothing but its frozen sentence, or null.
 *
 * **The one definition of a basis slot** (ingest and validator both call it): an optional
 * valid title line — the heading a slot may carry, like any chapter — is stripped, and what
 * remains must be *exactly* the frame sentence. Not "starts with": a chapter that opens on
 * the frame and writes on is written prose, not a basis slot.
 *
 * The title line is not stripped when it *is* the chapter's own frame (a ch42 that opens on
 * it is malformed, F029, and its line is prose — BOOK-32), so that file keeps its old answer.
 */
function basisProse(n: number, raw: string): string | null {
  const frame = frameSentenceOf(n);
  if (frame === null) return null;
  const text = normalizeBookText(raw);
  // The slot as it has been written so far: the frozen sentence and nothing else.
  if (text.trim() === frame) return frame;
  const first = (text.split('\n')[0] ?? '').trim();
  // A chapter that opens on the frame is untitled prose (BOOK-32): the line is not a heading.
  if (isFrameLine(n, first)) return null;
  // An optional heading above the sentence — ch01 carries one and stays a basis slot.
  const body = parseTitleLine(text).body.trim();
  return body === frame ? frame : null;
}

/**
 * A slot with no prose at all: the file is absent/empty, or it holds only its basis sentence
 * — with or without a heading above it (ch01/ch42 — issue BOOK-6). Such a slot is a **valid
 * state**, not a finding: it has no `chars` and no length band. A chapter with any other text
 * is written.
 */
export function isEmptySlot(n: number, raw: string): boolean {
  if (normalizeBookText(raw).trim().length === 0) return true;
  return basisProse(n, raw) !== null;
}

/**
 * The file is exactly its basis sentence, optionally under its own heading — an emptied slot,
 * not an empty write between two saves. The ingest may blank such a chapter instead of
 * keeping the old revision (§6.2).
 */
export function isBasisOnly(n: number, raw: string): boolean {
  return basisProse(n, raw) !== null;
}

/**
 * A chapter's opening as a contents row may print it: its first five words, with `…` when the
 * prose goes on, and `null` for a slot that holds no text. Derived from the first block, never
 * stored — the contents show the book's own words when it has no title to show.
 */
export function openingOf(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const words = text.trim().split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  const head = words.slice(0, 5).join(' ');
  return words.length > 5 ? `${head}…` : head;
}

export type Imprint = {
  author: string;
  copyright: string;
  publisher: string | null;
  year: string;
};

/** What is wrong with an imprint, empty when it is exact (§6C.6, F020). */
export function imprintProblems(imprint: Imprint | null | undefined): string[] {
  if (imprint === null || imprint === undefined) return ['imprint is missing'];
  const problems: string[] = [];
  if (imprint.author !== IMPRINT_AUTHOR) problems.push(`author must be «${IMPRINT_AUTHOR}»`);
  if (imprint.copyright !== IMPRINT_COPYRIGHT) problems.push(`copyright must be «${IMPRINT_COPYRIGHT}»`);
  if (imprint.publisher !== null) problems.push('publisher must be null');
  return problems;
}

/** A legal denylist is curated by hand and never generated from the book (§13.4, F005). */
export type LegalDenylist = {
  version?: number;
  note?: string;
  persons: string[];
  characters: string[];
  organisations: string[];
  /** Regex sources, matched case-insensitively over prose. */
  patterns: string[];
};

export function isChapterNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_CHAPTERS;
}

/** Which lane drafted the chapter — says nothing about who may revise it (§9). */
export function directionOf(n: number): Direction {
  return n <= FORWARD_LAST ? 'forward' : 'backward';
}

/**
 * The part of a chapter: 2–11 → 1, 12–21 → 2, 22–31 → 3, 32–41 → 4. The opening (1) and the
 * finale (`TOTAL_CHAPTERS`) stand outside the parts, so they answer `null`.
 */
export function partOf(n: number): Part | null {
  for (const range of PART_RANGES) {
    if (n >= range.from && n <= range.to) return range.part;
  }
  return null;
}

/** All the book's chapter numbers, ascending. */
export function allChapterNumbers(): number[] {
  return Array.from({ length: TOTAL_CHAPTERS }, (_, i) => i + 1);
}

/** `7` → `07`; chapter numbers are field numbers everywhere in the UI. */
export function chapterLabel(n: number): string {
  return String(n).padStart(2, '0');
}

/** CRLF → LF; trailing whitespace on a line is not text. */
export function normalizeBookText(raw: string): string {
  return raw
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n');
}

/** Split into paragraphs the way ingestion does: on blank lines, trimmed, empties dropped. */
export function splitParagraphs(text: string): string[] {
  return normalizeBookText(text)
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/** `chars` counts spaces and excludes the title line and the blank separators. */
export function countParagraphChars(blocks: readonly string[]): number {
  return blocks.reduce((sum, block) => sum + block.length, 0);
}

/** Markdown is not the book's format: no headings, no links, no footnotes (§6C.3, F009). */
export function hasMarkdown(value: string): boolean {
  return (
    /^\s{0,3}#{1,6}\s/u.test(value) ||
    /\[[^\]\n]+\]\([^)\n]+\)/u.test(value) ||
    /\[\^[^\]\n]+\]/u.test(value)
  );
}

function titleProblems(title: string): string[] {
  if (title.length === 0) return ['title line is missing'];
  const problems: string[] = [];
  if (title.length > TITLE_MAX_CHARS) {
    problems.push(`title is ${title.length} characters, limit is ${TITLE_MAX_CHARS}`);
  }
  if (hasMarkdown(title)) problems.push('title contains markdown');
  if (title.endsWith(':')) problems.push('title ends with a colon');
  return problems;
}

export type TitleLineParse = {
  /** The title, or null when line 1 is absent or malformed (§6C.3). */
  title: string | null;
  /** Everything after line 1, title line excluded. */
  body: string;
  problems: string[];
};

/**
 * Line 1 is the chapter title: plain text, ≤80 chars, no markdown, no trailing colon;
 * line 2 is blank (§6C.3). A malformed line 1 gives `title = null` and a problem; the
 * chapter still publishes, because F022 blocks a commit, never a reader.
 *
 * A chapter has one more rule on top of this one — the frame line — so every chapter caller
 * (ingest, validator) reads `parseChapterTitle`, not this function directly (BOOK-32).
 */
export function parseTitleLine(raw: string): TitleLineParse {
  const text = normalizeBookText(raw);
  const lines = text.split('\n');
  const first = (lines[0] ?? '').trim();
  const problems = titleProblems(first);
  if (lines.length > 1 && (lines[1] ?? '').trim() !== '') problems.push('line 2 must be blank');
  const valid = problems.length === 0;
  return {
    title: valid ? first : null,
    // A malformed line 1 is prose, not a title: the chapter still publishes (§6C.3).
    body: valid ? lines.slice(1).join('\n') : text,
    problems,
  };
}

/** Whitespace is not text: a rewrapped line and the frozen sentence compare as one string. */
function flatLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Line 1 is the chapter's frame, not its title, when it equals the frozen sentence or extends
 * it with more prose on the same line (BOOK-32). ch01 may open with the frame and write on;
 * a ch42 that opens with it is malformed (the frame ends that chapter), and F029 is the rule
 * that says so — the line is prose in either case. The frame lives once, in this file.
 */
function isFrameLine(n: number, line: string): boolean {
  const frame = frameSentenceOf(n);
  if (frame === null) return false;
  const expected = flatLine(frame);
  const flat = flatLine(line);
  return flat === expected || flat.startsWith(`${expected} `);
}

/**
 * The title decision for a chapter: the shared title rule plus the one line the frame owns.
 * A chapter that opens on its frozen sentence is untitled — `title = null`, no title problem,
 * the whole file is prose — the way a basis-only slot is read (BOOK-6), so the reader, `chars`
 * and the validator cannot disagree about the same bytes (BOOK-32).
 */
export function parseChapterTitle(n: number, raw: string): TitleLineParse {
  const text = normalizeBookText(raw);
  const first = (text.split('\n')[0] ?? '').trim();
  // The writer has not invented a title above the frame, and F022 does not ask for one.
  if (isFrameLine(n, first)) return { title: null, body: text, problems: [] };
  return parseTitleLine(raw);
}

export type FrontMatterParse = {
  /** Line 1, or null when the title line itself is malformed. */
  title: string | null;
  /** The annotation «о чём эта книга», or null when it is malformed (§6C.2). */
  about: string | null;
  blocks: string[];
  chars: number;
  problems: string[];
};

/**
 * `manuscript/00-front.md`: line 1 the live title, line 2 blank, then the annotation as
 * 1–12 blocks of 300–4 000 characters, plain text (§6C.2, F021). The band is a guard against
 * an empty blurb and an unbounded dump, not a page budget: the owner's annotation is nine
 * paragraphs and is valid as written.
 */
export function parseFrontMatter(raw: string): FrontMatterParse {
  const text = normalizeBookText(raw);
  const lines = text.split('\n');
  const first = (lines[0] ?? '').trim();
  const titleProblemList = titleProblems(first);
  if (lines.length > 1 && (lines[1] ?? '').trim() !== '') titleProblemList.push('line 2 must be blank');

  const blocks = splitParagraphs(lines.slice(1).join('\n'));
  const chars = countParagraphChars(blocks);
  const aboutProblems: string[] = [];
  if (blocks.length < 1 || blocks.length > ABOUT_MAX_BLOCKS) {
    aboutProblems.push(`annotation has ${blocks.length} blocks, expected 1–${ABOUT_MAX_BLOCKS}`);
  }
  if (chars < ABOUT_MIN_CHARS || chars > ABOUT_MAX_CHARS) {
    aboutProblems.push(`annotation has ${chars} characters, expected ${ABOUT_MIN_CHARS}–${ABOUT_MAX_CHARS}`);
  }
  if (blocks.some((block) => hasMarkdown(block))) aboutProblems.push('annotation contains markdown');

  return {
    title: titleProblemList.length === 0 ? first : null,
    about: aboutProblems.length === 0 ? blocks.join('\n\n') : null,
    blocks,
    chars,
    problems: [...titleProblemList, ...aboutProblems],
  };
}
