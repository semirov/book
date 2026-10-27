import { COMMENT_AFFIX_MAX_CHARS, COMMENT_QUOTE_MAX_CHARS } from '@book/shared';

/**
 * BOOK-DOC-34 §2.1 — the geometry of the seam.
 *
 * A tap lands on an offset inside one paragraph's text. Three answers come from it: the word
 * under the point (for provenance), the sentence that holds it (the anchor) and the boundary
 * after that sentence (where the paragraph parts). Everything here is a pure function of the
 * paragraph string, so the splitter, the clamp and the anchor can be tested without a browser
 * and the components carry no geometry of their own.
 *
 * The splitter is deliberately small: it knows the punctuation the book actually uses
 * («» quotes, an em dash, ellipses), the abbreviations whose full stop is not a sentence end,
 * initials, decimals and hyphens inside a word. It does not try to be a tokenizer — a wrong
 * sentence boundary would move an anchor, and the unit tests below name the shapes it must
 * keep whole.
 */

export type Sentence = {
  /** The sentence as it appears, without the whitespace around it. */
  text: string;
  /** Offsets into the paragraph string, `end` exclusive. */
  start: number;
  end: number;
};

export type Word = { text: string; start: number; end: number };

/** A full stop after one of these is not the end of a sentence («и т. д.», «см. выше»). */
const ABBREVIATIONS = new Set([
  'акад',
  'в',
  'вв',
  'г',
  'гг',
  'гр',
  'д',
  'др',
  'е',
  'им',
  'коп',
  'корп',
  'млн',
  'млрд',
  'н',
  'напр',
  'п',
  'пп',
  'проф',
  'пр',
  'рис',
  'руб',
  'см',
  'стр',
  'табл',
  'т',
  'тыс',
  'ул',
  'э',
]);

const TERMINALS = new Set(['.', '!', '?', '…']);
/** A sentence may end with a closing quote or bracket after its full stop. */
const CLOSERS = new Set(['»', '"', '”', ')', ']', '’', "'"]);
/** A soft hyphen is a break instruction, not a character of the word. */
export const SOFT_HYPHEN = '\u00ad';

const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\u00ad]*(?:['’‑-][\p{L}\p{N}]+[\p{L}\p{N}\u00ad]*)*/gu;

/** The letters of the token that ends right before `at`, lowercased; '' when none. */
function tokenBefore(text: string, at: number): string {
  let index = at;
  while (index > 0 && !/\s/u.test(text[index - 1] ?? '')) index -= 1;
  return text.slice(index, at).replace(/[^\p{L}]/gu, '').toLowerCase();
}

/** The first non-space character at or after `from`; '' at the end of the text. */
function firstNonSpace(text: string, from: number): string {
  for (let index = from; index < text.length; index += 1) {
    if (!/\s/u.test(text[index] ?? '')) return text[index] ?? '';
  }
  return '';
}

/** `1.5`, `21.10.2026` and `т. д.` keep their full stops; `конец. Дальше` does not. */
function isBoundary(text: string, terminal: number): boolean {
  const next = text[terminal + 1] ?? '';
  if (next !== '' && !/\s/u.test(next) && !CLOSERS.has(next)) return false;
  // Look past the closing quote or bracket: prose that continues in lower case or with a dash
  // («он спросил: «кто здесь?» — и сел») is one sentence, and the quote is inside it.
  let from = terminal + 1;
  while (from < text.length && CLOSERS.has(text[from] ?? '')) from += 1;
  const after = firstNonSpace(text, from);
  if (after !== '' && (/\p{Ll}/u.test(after) || after === '—' || after === '–' || after === '-')) return false;
  const token = tokenBefore(text, terminal);
  if (token.length === 0) return true;
  // A single capital letter is an initial («А. С. Пушкин»), not the end of a sentence.
  if (token.length === 1 && /^\p{Lu}$/u.test(text[terminal - 1] ?? '')) return false;
  if (!ABBREVIATIONS.has(token)) return true;
  // An abbreviation never ends a sentence by itself — unless it closes a chain of them and the
  // next word starts a sentence: «…и т. д. Потом все ушли.» is two sentences.
  const beforeToken = text.slice(Math.max(0, terminal - token.length - 3), terminal - token.length).trimEnd();
  return beforeToken.endsWith('.') && after !== '' && /^\p{Lu}/u.test(after);
}

function pushSentence(out: Sentence[], text: string, from: number, to: number): void {
  let start = from;
  while (start < to && /\s/u.test(text[start] ?? '')) start += 1;
  let end = to;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
  if (end > start) out.push({ text: text.slice(start, end), start, end });
}

/** One paragraph's text → its sentences, in order, with offsets into that text. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (!TERMINALS.has(text[index] ?? '')) {
      index += 1;
      continue;
    }
    let end = index + 1;
    // «?!» and an ellipsis typed as several dots are one terminator.
    while (end < text.length && TERMINALS.has(text[end] ?? '')) end += 1;
    while (end < text.length && CLOSERS.has(text[end] ?? '')) end += 1;
    if (isBoundary(text, index)) {
      pushSentence(out, text, start, end);
      start = end;
    }
    index = end;
  }
  pushSentence(out, text, start, text.length);
  return out;
}

function wordsOf(text: string): Word[] {
  const words: Word[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const at = match.index ?? 0;
    words.push({ text: match[0].replaceAll(SOFT_HYPHEN, ''), start: at, end: at + match[0].length });
  }
  return words;
}

/**
 * The word under the offset, or the nearest one — a tap in the gap between words still has to
 * name a word, otherwise the strip would open without provenance (§2.1).
 */
export function wordAt(text: string, offset: number): Word | null {
  let best: Word | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const word of wordsOf(text)) {
    if (offset >= word.start && offset <= word.end) return word;
    const distance = offset < word.start ? word.start - offset : offset - word.end;
    if (distance < bestDistance) {
      best = word;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The first word of a stored quote — the one word a surface may name when all it holds is the
 * sentence a filing cites (BOOK-111: the card's way into that phrase's provenance). An empty
 * quote has no word, and the door which would lead to it is not offered.
 */
export function firstWord(text: string | null): string | null {
  if (text === null || text.trim().length === 0) return null;
  return wordAt(text, 0)?.text ?? null;
}

/** The sentence holding the offset, or the nearest one. */
export function sentenceAt(text: string, offset: number): Sentence | null {  const sentences = splitSentences(text);
  if (sentences.length === 0) return null;
  let best: Sentence = sentences[0] as Sentence;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const sentence of sentences) {
    if (offset >= sentence.start && offset <= sentence.end) return sentence;
    const distance = offset < sentence.start ? sentence.start - offset : offset - sentence.end;
    if (distance < bestDistance) {
      best = sentence;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The sentence as the anchor quote, within the server's bound.
 *
 * BOOK-33: the quote must stay a **substring** of the paragraph — the server resolves an
 * anchor with `block.text.includes(quote)`, so an ellipsis or a whitespace rewrite would make
 * every long sentence permanently stale (no mark, no rule). The cut is a word boundary and
 * nothing is appended; the strip adds its own «…» when it prints the quote.
 */
export function clampQuote(text: string, max = COMMENT_QUOTE_MAX_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).replace(/\s+$/u, '');
}

export type SeamAnchor = {
  blockId: string;
  baseRev: number;
  /** The sentence, clamped to the server's bound (`COMMENT_QUOTE_MAX_CHARS`). */
  quote: string;
  prefix: string;
  suffix: string;
  sentence: Sentence;
  word: string | null;
};

export type AnchorInput = {
  text: string;
  blockId: string;
  baseRev: number;
  offset: number;
};

/**
 * A tap offset → the anchored filing (§6 data): `blockId + quote + baseRev` are always sent,
 * plus the affixes the server tries before it declares the anchor stale.
 */
export function anchorFor({ text, blockId, baseRev, offset }: AnchorInput): SeamAnchor | null {
  const sentence = sentenceAt(text, offset);
  if (sentence === null) return null;
  const word = wordAt(text, offset);
  return {
    blockId,
    baseRev,
    quote: clampQuote(sentence.text),
    prefix: text.slice(Math.max(0, sentence.start - COMMENT_AFFIX_MAX_CHARS), sentence.start),
    suffix: text.slice(sentence.end, sentence.end + COMMENT_AFFIX_MAX_CHARS),
    sentence,
    word: word === null ? null : word.text,
  };
}

/**
 * BOOK-33 — the anchor a stale draft is re-keyed onto, in the text that exists now.
 *
 * The sentence itself is preferred (same words, possibly moved); otherwise the paragraph's
 * sentence at the old start, so the reader lands near where they were. `null` when there is
 * no text at all: the strip then says the paragraph is gone instead of inventing a place.
 */
export function reanchorAnchor(input: {
  text: string;
  blockId: string;
  baseRev: number;
  previous: SeamAnchor | null;
}): SeamAnchor | null {
  const { text, blockId, baseRev, previous } = input;
  if (text.trim().length === 0) return null;
  const found = previous === null ? -1 : text.indexOf(previous.quote);
  const offset = found >= 0 ? found : Math.min(previous?.sentence.start ?? 0, text.length - 1);
  return anchorFor({ text, blockId, baseRev, offset });
}

/**
 * The identity of one seam inside a chapter: a draft and an open strip key off it.
 *
 * BOOK-33: the revision is part of the key. A re-keyed draft lives under a new key, so the
 * strip remounts and reads the re-anchored draft instead of keeping the stale one it opened
 * with — the whole point of the re-anchor.
 */
export function seamKey(chapter: number, blockId: string, sentence: Sentence, baseRev: number | null = null): string {
  return `ch${chapter}:${blockId}:${sentence.start}-${sentence.end}@${baseRev ?? '-'}`;
}
