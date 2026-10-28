/**
 * The answer's gate (BOOK-117): what came back from the model, checked before it may land.
 *
 * The chapter format is **not** decided here. The title line is `parseChapterTitle`'s decision
 * and the shape of the file is `parseChapter`'s (`chars`, blocks, the basis slot) — this module
 * reads those, because a second title rule is how ch01's frame once became a heading (BOOK-32)
 * and a second paragraph split is how `chars` and the reader's page start disagreeing.
 *
 * What is checked, in the order it is reported: the answer is not empty or a refusal; it was not
 * cut short (the provider's `length` or a tail that stops mid-sentence); it is in the length
 * band; it has a title, no markdown, the right relation to the frozen frame, no echo of the canon
 * or of an address to the machine, and a paragraph shape (at least three paragraphs, no wall,
 * nothing that is punctuation only). The returned `text` is the normalised one that would be
 * written, so the bytes that passed are the bytes that land.
 */

import {
  CHAPTER_CHARS,
  FRAME_FIRST_SENTENCE,
  FRAME_LAST_SENTENCE,
  TOTAL_CHAPTERS,
  classifyText,
  foldForMatch,
  hasMarkdown,
  isChapterNumber,
} from '@book/shared';

import { normalizeChapterText, parseChapter } from '../ingest/parseChapter.ts';

export type AnswerCode =
  | 'ANSWER_EMPTY'
  | 'ANSWER_REFUSAL'
  | 'ANSWER_TRUNCATED'
  | 'TEXT_TOO_SHORT'
  | 'TEXT_TOO_LONG'
  | 'TITLE_INVALID'
  | 'MARKDOWN'
  | 'FRAME_RETYPED'
  | 'CANON_ECHO'
  | 'INSTRUCTION'
  | 'PARAGRAPH_SHAPE';

export type ValidatedAnswer = { ok: true; text: string; chars: number; title: string | null };
export type AnswerRefusal = { ok: false; code: AnswerCode; reason: string };
/** `finishReason` is the provider's `choices[0].finish_reason`: `length` means the token cap hit. */
export type ValidateInput = { chapter: number; finishReason?: string | null };

/** How far into the answer a refusal/meta preamble is possible. Past it, the answer is prose. */
const PREAMBLE_WINDOW = 400;
/** A paragraph with no break beyond this is a wall, not a chapter (§6D.1 in practice). */
const WALL_CHARS = 1_500;
const MIN_PARAGRAPHS = 3;

/**
 * A model answering *about* the task rather than *as* the chapter. Curated, not generated.
 *
 * Two windows, because Russian prose legitimately contains «извините» and «я не могу» in
 * dialogue: those two are read on the **first line only** (a refusal answer opens with them),
 * while the meta phrases — which no chapter's title carries — are read in the first few lines.
 */
const OPENING_REFUSALS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'an apology', pattern: /(?<![а-яё])(?:извините|прошу прощения)(?![а-яё])/u },
  { label: 'a refusal', pattern: /(?<![а-яё])я не могу(?![а-яё])/u },
];

const PREAMBLE_REFUSALS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'a model self-reference', pattern: /как (?:ии|искусственный интеллект)/u },
  { label: 'an English preamble', pattern: /\b(?:here is|here's|i'm sorry|i am sorry|as an ai)\b/u },
  { label: 'a preamble', pattern: /вот (?:глава|текст)/u },
  { label: 'a preamble', pattern: /ниже\s*[—–-]\s*(?:глава|текст)/u },
  { label: 'a preamble', pattern: /^\s*конечно(?![а-яё])/u },
];

/** Markdown the shared parser does not cover but a chapter may not carry. */
const MARKDOWN_LINES = [
  { label: 'a fence', pattern: /^\s*(?:```|~~~)/u },
  { label: 'a list item', pattern: /^\s*(?:[-*+•]|\d{1,2}[.)])\s+\S/u },
  { label: 'a heading', pattern: /^\s{0,3}#{1,6}\s+\S/u },
  { label: 'emphasis', pattern: /\*\*[^*\n]+\*\*|__[^_\n]+__|(?<![*\w])\*[^*\n]+\*(?![*\w])/u },
  { label: 'a link', pattern: /\[[^\]\n]+\]\([^)\n]+\)/u },
] as const;

/**
 * The characters a finished chapter cannot stop on. A dash belongs inside a line (dialogue), not
 * at the end of the file; a chapter may end on `.`, `!`, `?`, `…`, `»` or `"`.
 */
const TRUNCATED_TAILS: ReadonlySet<string> = new Set([',', '—', ':', '«', '(']);

/**
 * An address **to the machine** — what this gate refuses. Not the book's vocabulary: the shared
 * `classifyText` is tuned for a reader's request, where «инструкция», «промпт», «в стиле»,
 * «появится», «пусть» are the asks. In this book's bureaucratic register «инструкция» is the
 * object a chapter is about, so that classifier parks a good chapter as an injection and the
 * pass is lost. What is refused here is an order given to the model, a chat turn written to it.
 *
 * Cyrillic patterns are read on the lowercased body and Latin ones on the folded body: the fold
 * maps Cyrillic look-alikes to Latin (`ѕystem:`), so it cannot be used to match Cyrillic. `\b`
 * after a Cyrillic letter is dead (BOOK-42) — the boundary is `(?<![а-яё])`.
 */
const MACHINE_ADDRESS: ReadonlyArray<{ label: string; script: 'cyrillic' | 'latin'; pattern: RegExp }> = [
  // The imperative to ignore what came before: the verb alone is not enough, it must be told
  // what to drop. «Игнорируй предыдущие инструкции», «проигнорируй все указания выше».
  {
    label: 'an order to ignore the earlier instructions',
    script: 'cyrillic',
    pattern: /(?<![а-яё])(?:про)?игнор(?:ируй|ируйте)(?:\s+[а-яё-]+){0,3}\s+(?:предыдущ|выше|инструкц|указани|правил)/u,
  },
  { label: 'a role assignment', script: 'cyrillic', pattern: /(?<![а-яё])(?:ты|вы)\s+теперь(?![а-яё])/u },
  {
    label: 'an obligation addressed to the model',
    script: 'cyrillic',
    pattern: /(?<![а-яё])(?:ты|вы)\s+(?:должен|должна|обязан|обязана|будешь)(?![а-яё])/u,
  },
  { label: 'a system turn', script: 'cyrillic', pattern: /(?<![а-яё])система\s*:/u },
  { label: 'an appeal to ignore', script: 'cyrillic', pattern: /(?<![а-яё])не\s+обраща(?:й|йте)\s+внимани[яе]/u },
  {
    label: 'an address to the model',
    script: 'cyrillic',
    pattern: /(?<![а-яё])обраща(?:йся|йтесь)\s+к\s+(?:модел|систем)/u,
  },
  { label: 'a system turn', script: 'latin', pattern: /\bsystem\s*:/u },
  { label: 'an output order', script: 'latin', pattern: /\boutput\s+only\b/u },
  { label: 'a role assignment', script: 'latin', pattern: /\bact\s+as\b/u },
  { label: 'a role assignment', script: 'latin', pattern: /\byou\s+are\s+(?:now\s+)?(?:an?\s+\w|the\s+\w)/u },
  { label: 'a role assignment', script: 'latin', pattern: /\byou\s+are\s+now(?![a-z])/u },
  { label: 'a model self-reference', script: 'latin', pattern: /\bas\s+an\s+ai\b/u },
  { label: 'a chat turn', script: 'latin', pattern: /\bassistant\s*:/u },
  { label: 'a model name', script: 'latin', pattern: /\bchatgpt\b|\bgpt-?[34]\b/u },
];

function fail(code: AnswerCode, reason: string): AnswerRefusal {
  return { ok: false, code, reason };
}

/** Whitespace is not identity: a re-wrapped frame sentence is the same sentence. */
function flat(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Was the answer cut short? The provider's `length` is the token cap (`max_tokens` ran out, and a
 * reasoning model spends completion tokens before it writes a line); independently of it, a tail
 * that stops on a comma, a dash, a colon, an opening quote or bracket, or inside a « that never
 * closed, is a sentence the model never finished. Cheap, and honest about what it is: a heuristic.
 */
function truncationProblem(text: string, finishReason: string | null | undefined): string | null {
  if (finishReason === 'length') {
    return 'the answer was cut at the token cap (finish_reason: length), so the chapter is unfinished';
  }
  const tail = text.trimEnd();
  const last = tail.slice(-1);
  if (TRUNCATED_TAILS.has(last)) {
    return `the answer ends on «${last}»: the last sentence was cut mid-way`;
  }
  if (/\p{L}$/u.test(tail) && countOf(tail, '«') > countOf(tail, '»')) {
    return 'the answer ends inside a « that never closes: the last sentence was cut mid-way';
  }
  return null;
}

/** The label of the first machine address the prose carries, or null when it is narration. */
function machineAddress(lower: string, folded: string): string | null {
  for (const check of MACHINE_ADDRESS) {
    if (check.pattern.test(check.script === 'cyrillic' ? lower : folded)) return check.label;
  }
  return null;
}

function markdownProblem(body: string): string | null {
  if (hasMarkdown(body)) return 'the body contains a heading, link or footnote';
  for (const line of body.split('\n')) {
    for (const check of MARKDOWN_LINES) {
      if (check.pattern.test(line)) return `the body contains ${check.label}: ${line.trim().slice(0, 40)}`;
    }
  }
  return null;
}

function frameProblem(chapter: number, blocks: readonly string[], body: string): string | null {
  const first = flat(FRAME_FIRST_SENTENCE);
  const last = flat(FRAME_LAST_SENTENCE);
  const flatBody = flat(body);
  const opensWithFirst = flat(blocks[0] ?? '').startsWith(first);
  const endsWithLast = flat(blocks.at(-1) ?? '').endsWith(last);

  if (chapter === 1) {
    if (!opensWithFirst) return 'chapter 01 must open on the frozen first sentence';
    if (countOf(flatBody, first) !== 1) return 'the frozen first sentence appears more than once in chapter 01';
    if (countOf(flatBody, last) > 0) return 'chapter 01 must not carry the frozen last sentence';
    return null;
  }
  if (chapter === TOTAL_CHAPTERS) {
    if (!endsWithLast) return `chapter ${String(chapter)} must end on the frozen last sentence`;
    if (countOf(flatBody, last) !== 1) return 'the frozen last sentence appears more than once in chapter 67';
    if (countOf(flatBody, first) > 0) return 'chapter 67 must not carry the frozen first sentence';
    return null;
  }
  if (countOf(flatBody, first) > 0 || countOf(flatBody, last) > 0) {
    return 'the answer retypes a frozen frame sentence: those belong to chapters 01 and 67';
  }
  return null;
}

function paragraphProblem(blocks: readonly string[]): string | null {
  if (blocks.length < MIN_PARAGRAPHS) {
    return `the answer has ${String(blocks.length)} paragraph(s); at least ${String(MIN_PARAGRAPHS)} are expected`;
  }
  const wall = blocks.find((block) => block.length > WALL_CHARS);
  if (wall !== undefined) {
    return `a paragraph of ${String(wall.length)} characters has no break; the bound is ${String(WALL_CHARS)}`;
  }
  if (blocks.some((block) => /^[\p{P}\p{S}\s]+$/u.test(block))) {
    return 'a paragraph is punctuation only';
  }
  return null;
}

export function validateAnswer(raw: string, input: ValidateInput): ValidatedAnswer | AnswerRefusal {
  if (!isChapterNumber(input.chapter)) {
    throw new Error(`validateAnswer: chapter ${String(input.chapter)} is not 1..${String(TOTAL_CHAPTERS)}`);
  }
  const text = normalizeChapterText(raw);
  if (text.trim().length === 0) return fail('ANSWER_EMPTY', 'the answer is empty');

  const head = text.slice(0, PREAMBLE_WINDOW).toLowerCase();
  const firstLine = (text.split('\n')[0] ?? '').toLowerCase();
  for (const refusal of OPENING_REFUSALS) {
    if (refusal.pattern.test(firstLine)) {
      return fail('ANSWER_REFUSAL', `the answer reads as ${refusal.label}, not as a chapter`);
    }
  }
  for (const refusal of PREAMBLE_REFUSALS) {
    if (refusal.pattern.test(head)) {
      return fail('ANSWER_REFUSAL', `the answer reads as ${refusal.label}, not as a chapter`);
    }
  }

  const parsed = parseChapter(input.chapter, text);

  // A cut answer is refused before anything about its shape: a chapter that is short because the
  // cap ran out is unfinished, not a chapter that happens to be short.
  const truncation = truncationProblem(text, input.finishReason);
  if (truncation !== null) return fail('ANSWER_TRUNCATED', truncation);

  // Length is read from the parser: the title line is not prose (§6D.1).
  if (parsed.chars < CHAPTER_CHARS.floor) {
    return fail(
      'TEXT_TOO_SHORT',
      `the chapter is ${String(parsed.chars)} characters; the floor is ${String(CHAPTER_CHARS.floor)}`,
    );
  }
  if (parsed.chars > CHAPTER_CHARS.max) {
    return fail(
      'TEXT_TOO_LONG',
      `the chapter is ${String(parsed.chars)} characters; the ceiling is ${String(CHAPTER_CHARS.max)}`,
    );
  }

  // An untitled chapter is only the form ch01 takes when it opens on its frame (BOOK-32).
  const opensOnFrame =
    input.chapter === 1 && flat(parsed.blocks[0]?.text ?? '').startsWith(flat(FRAME_FIRST_SENTENCE));
  if (parsed.titleProblems.length > 0) {
    return fail('TITLE_INVALID', `the title line is invalid: ${parsed.titleProblems.join('; ')}`);
  }
  if (parsed.title === null && !opensOnFrame) {
    return fail('TITLE_INVALID', 'line 1 is not a title line');
  }

  const markdown = markdownProblem(parsed.body);
  if (markdown !== null) return fail('MARKDOWN', markdown);

  const frame = frameProblem(
    input.chapter,
    parsed.blocks.map((block) => block.text),
    parsed.body,
  );
  if (frame !== null) return fail('FRAME_RETYPED', frame);

  // The canon echo is still the shared classifier's call — exactly the same refusal as before.
  // Its `instruction` category is not: it is tuned for a reader's request and refuses this
  // book's register («инструкция», «в стиле», «появится»), so the answer is read for an address
  // to the machine instead (`MACHINE_ADDRESS`).
  const canon = classifyText(parsed.body);
  if (canon?.category === 'canon') {
    return fail('CANON_ECHO', 'the prose talks about the canon instead of being prose');
  }

  const bodyLower = parsed.body.normalize('NFKC').toLowerCase();
  const address = machineAddress(bodyLower, foldForMatch(parsed.body));
  if (address !== null) return fail('INSTRUCTION', `the prose reads as ${address}, not as narration`);

  const shape = paragraphProblem(parsed.blocks.map((block) => block.text));
  if (shape !== null) return fail('PARAGRAPH_SHAPE', shape);

  return { ok: true, text, chars: parsed.chars, title: parsed.title };
}
