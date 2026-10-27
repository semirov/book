/**
 * The book model (ARCHITECTURE.md §6C, §6D, §23.5): numbering, part ranges, the fixed
 * numbers two components must agree on, and the two text shapes the book has — a chapter
 * title line and the front matter (title + annotation).
 *
 * One implementation, two callers: ingestion (`server/src/ingest`) and the validator
 * (`shared/src/validate`). A second parser would drift, and a drifted title line is a
 * chapter whose prose is silently counted as its title.
 */

export const TOTAL_CHAPTERS = 67;

/** Last chapter of the forward drafting lane. */
export const FORWARD_LAST = 34;
/** First chapter of the backward drafting lane. */
export const BACKWARD_FIRST = 35;

export type Direction = 'forward' | 'backward';
export type Part = 1 | 2 | 3 | 4;

/**
 * Four numbered parts, no content meaning (§6C.1). The split is a numbering convention:
 * three components (TOC, catalog, lane boundaries) must agree on it and only one is a UI.
 */
export const PART_RANGES: ReadonlyArray<{ part: Part; from: number; to: number }> = [
  { part: 1, from: 1, to: 22 },
  { part: 2, from: 23, to: 44 },
  { part: 3, from: 45, to: 66 },
  { part: 4, from: 67, to: 67 },
];

/** The only length numbers in the system (§6D.1, ADR-025 amended by ADR-031). */
export const CHAPTER_CHARS = {
  /** Shorter than a page is a slot, not a chapter. */
  floor: 1_600,
  /** A chapter below this is `thin` — a warning while the book is being written. */
  min: 20_000,
  target: 25_000,
  /** Above this is an error: three roles cannot read it inside one step's budget. */
  max: 30_000,
} as const;

/** «67 pages» to «1000 pages» (§6D.1); F026 binds it at closure (M7). */
export const BOOK_CHARS = { min: 107_200, max: 1_675_000 } as const;

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
 * with it and chapter 67 closes with it. Nobody edits these sentences: not the writer, not
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
 * A slot with no prose at all: the file is absent/empty, or it holds only its basis sentence
 * (ch01/ch67 — issue BOOK-6). Such a slot is a **valid state**, not a finding: it has no
 * title line, no `chars` and no length band. A chapter with any other text is written.
 */
export function isEmptySlot(n: number, raw: string): boolean {
  const text = normalizeBookText(raw).trim();
  if (text.length === 0) return true;
  return text === frameSentenceOf(n);
}

/**
 * The file is exactly its basis sentence — an emptied slot, not an empty write between two
 * saves. The ingest may blank such a chapter instead of keeping the old revision (§6.2).
 */
export function isBasisOnly(n: number, raw: string): boolean {
  const frame = frameSentenceOf(n);
  return frame !== null && normalizeBookText(raw).trim() === frame;
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

/** The TOC volume of a chapter: 1–22 → 1, 23–44 → 2, 45–66 → 3, 67 → 4. */
export function partOf(n: number): Part {
  for (const range of PART_RANGES) {
    if (n >= range.from && n <= range.to) return range.part;
  }
  return 1;
}

/** All 67 chapter numbers, ascending. */
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
 * a ch67 that opens with it is malformed (the frame ends that chapter), and F029 is the rule
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
 * an empty blurb and an unbounded dump, not a page budget: the owner's annotation is seven
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
