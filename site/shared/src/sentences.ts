/**
 * BOOK-DOC-74 (ADR-044) §3.2 — one segmenter, versioned, shared by the client and the server.
 *
 * The site had three splitters: the careful one in `web/src/lib/seam.ts`, the index's
 * `(?<=[.!?…])\s+` (`server/src/index/extract.ts`) and the injection gate's copy
 * (`shared/src/injection.ts`). On the paragraph that opens `ch12` they disagreed by four
 * sentences, because only the client's splitter knew that a full stop inside `«…»` is not the
 * end of a sentence — and every one of those fragments was an anchor a fact or a comment could
 * hang on. This module is the single answer: rules R1–R12 are one ordered pass, and a rule
 * change is a `SEGMENTER_VERSION` bump plus a re-segmentation, never a silent read-time
 * difference between two surfaces.
 *
 * Offsets are **Unicode code points**, `end` exclusive, and the spans plus the whitespace
 * between them reconstruct the input byte for byte: that losslessness is what lets the
 * migration store `start`/`end` and check them against `blocks.text`.
 */

/** The version of the rule set below. Bumped only together with a re-segmentation. */
export const SEGMENTER_VERSION = 1;

/** One sentence of a block: `text` is the sentence itself, `start`/`end` are code points. */
export type SentenceSpan = {
  text: string;
  start: number;
  end: number;
};

/** R1 — a boundary follows a run of these, plus any closers. */
const TERMINALS = new Set(['.', '!', '?', '…']);

/** R1/R3 — a closer after the terminator stays with the sentence it closes. */
const CLOSERS = new Set(['»', '"', '”', ')', ']', '’']);

/** R2 — the pairs whose inside is one sentence, however many full stops it holds. */
const QUOTES: Record<string, string> = { '«': '»', '“': '”', '„': '“', '"': '"' };

/** R4 — the dialogue dash. A hyphen is not one: it belongs to words and to list markers. */
const DASHES = new Set(['—', '–']);

/**
 * R5 — a full stop after these is not a sentence end. The set is the one `seam.ts` carried (it
 * passes the book's paperwork) with the ADR's `с`, `кв`, `обл`, `р` added. `№` is deliberately
 * absent: it has no dot, and R7 reads it as a marker in front of a number instead.
 */
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
  'кв',
  'коп',
  'корп',
  'млн',
  'млрд',
  'н',
  'напр',
  'обл',
  'п',
  'пп',
  'проф',
  'пр',
  'р',
  'рис',
  'руб',
  'с',
  'см',
  'стр',
  'табл',
  'т',
  'тыс',
  'ул',
  'э',
]);

/** A number with its separators: `65/11877`, `14-2065`, `44/17`. */
const NUMBER_RUN = /[\p{N}/-]/u;
const LETTER = /\p{L}/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const DIGIT = /\p{N}/u;

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);

/**
 * R2 — for every code point, the closer its innermost open quote waits for (absent outside a
 * quote), from a scan of the whole text: a local regex cannot see that a terminator is four
 * full stops deep inside a notice. A `"` toggles, so a lone `"` still opens and closes; an
 * unmatched opener keeps the rest of the block inside it.
 */
function quoteTops(cps: readonly string[]): Array<string | undefined> {
  const tops: Array<string | undefined> = new Array<string | undefined>(cps.length + 1).fill(undefined);
  const stack: string[] = [];
  for (let index = 0; index < cps.length; index += 1) {
    tops[index] = stack[stack.length - 1];
    const char = cps[index] as string;
    if (stack[stack.length - 1] === char) {
      stack.pop();
      continue;
    }
    const closer = QUOTES[char];
    if (closer !== undefined) stack.push(closer);
  }
  tops[cps.length] = stack[stack.length - 1];
  return tops;
}

/** The first character that is not whitespace at or after `from`; '' at the end of the text. */
function firstNonSpace(cps: readonly string[], from: number): string {
  let index = from;
  while (index < cps.length && isSpace(cps[index] as string)) index += 1;
  return cps[index] ?? '';
}

/**
 * The first character that can begin a sentence at or after `from`: whitespace, a dialogue dash
 * and an opener are skipped, because `…конец. — Слушаю` and `…кладка. «Пункт 4»` both start a
 * sentence with a capital behind a mark that is not a letter.
 */
function firstMeaningful(cps: readonly string[], from: number): string {
  let index = from;
  while (index < cps.length) {
    const char = cps[index] as string;
    if (!isSpace(char) && !DASHES.has(char) && QUOTES[char] === undefined) return char;
    index += 1;
  }
  return '';
}

/** The letters right before `at`, lowercased — the token an abbreviation is read on. */
function wordBefore(cps: readonly string[], at: number): string {
  let index = at;
  while (index > 0 && LETTER.test(cps[index - 1] as string)) index -= 1;
  return cps.slice(index, at).join('').toLowerCase();
}

/** R5 — is this the second full stop of a chain («т. д.»), not the first? */
function chainBefore(cps: readonly string[], from: number): boolean {
  let index = from - 1;
  while (index >= 0 && isSpace(cps[index] as string)) index -= 1;
  return index >= 0 && cps[index] === '.';
}

/**
 * R7 — a number keeps its full stop when the number is a document reference: `дело № 44/17.`,
 * `д. 14.` and `гл. 3.` are not sentence ends, `в 13. Кабинет` is.
 */
function keepsNumber(cps: readonly string[], at: number): boolean {
  let index = at - 1;
  while (index >= 0 && NUMBER_RUN.test(cps[index] as string)) index -= 1;
  while (index >= 0 && isSpace(cps[index] as string)) index -= 1;
  // «д. 14» and «гл. 3»: the marker itself carries the full stop that precedes the number.
  if (cps[index] === '.') index -= 1;
  if (cps[index] === '№') return true;
  let letters = index;
  while (letters >= 0 && LETTER.test(cps[letters] as string)) letters -= 1;
  const marker = cps.slice(letters + 1, index + 1).join('').toLowerCase();
  return marker === 'д' || marker === 'гл' || marker === 'п';
}

/**
 * R5, R6, R7 — the full stops that belong to a token rather than to a sentence: an abbreviation
 * of the set, a chain of them that closes into a new sentence, an initial, a decimal, a
 * document number. Only `.` is asked: `?`, `!` and `…` always terminate.
 */
function insideToken(cps: readonly string[], at: number): boolean {
  if (cps[at] !== '.') return false;
  const before = cps[at - 1];
  if (before === undefined) return false;
  if (DIGIT.test(before)) return keepsNumber(cps, at);
  if (UPPER.test(before)) {
    // R6 — «Подпись П. На обороте»: a lone capital is an initial, not a full stop, wherever a
    // capitalised token follows it; the chain «А. И.» is the same rule applied twice.
    const prior = cps[at - 2];
    if (prior !== undefined && LETTER.test(prior)) return false;
    return UPPER.test(firstMeaningful(cps, at + 1));
  }
  const word = wordBefore(cps, at);
  if (word.length === 0 || !ABBREVIATIONS.has(word)) return false;
  // R5 — «и т. д. Потом все ушли» ends a sentence at the last full stop of the chain and not
  // inside it; «1965 г. Он» stays whole, because one abbreviation is not a chain.
  return !(chainBefore(cps, at - word.length) && UPPER.test(firstMeaningful(cps, at + 1)));
}

/**
 * R1–R12 — is the run of terminals at `at`, plus the closers that follow it, the end of a
 * sentence? `end` is the index after the run and its closers, `tops` the closer each open quote
 * waits for.
 */
function endsSentence(
  cps: readonly string[],
  tops: ReadonlyArray<string | undefined>,
  at: number,
  end: number,
): boolean {
  // R1 — a terminator is only a candidate when whitespace or the end of the block follows it.
  if (end < cps.length && !isSpace(cps[end])) return false;
  // R2/R3 — inside a quotation, only the terminator the quotation closes at is a boundary: the
  // closer may stand right after the terminator or one space later («Уходи. »). An internal
  // full stop with prose after it stays inside the sentence («…дела № 44/17. При себе…»).
  const expected = tops[end];
  if (expected !== undefined && firstNonSpace(cps, end) !== expected) return false;
  // R4/R10 — lower-case prose continues the sentence, also when a dialogue dash stands between
  // them: «он спросил: „кто здесь?“ — и сел» is one sentence, «…конец. — Слушаю» is two.
  if (LOWER.test(firstMeaningful(cps, end))) return false;
  return !insideToken(cps, at);
}

/** R1/R11 — append `from..to` trimmed of the whitespace around it; nothing but whitespace goes. */
function pushSpan(out: SentenceSpan[], cps: readonly string[], from: number, to: number): void {
  let start = from;
  while (start < to && isSpace(cps[start])) start += 1;
  let end = to;
  while (end > start && isSpace(cps[end - 1])) end -= 1;
  if (end > start) out.push({ text: cps.slice(start, end).join(''), start, end });
}

/**
 * One block's text → its sentences, in order, with code-point offsets.
 *
 * Lossless by construction: `start` skips leading whitespace, `end` excludes trailing
 * whitespace, spans never overlap, and every character of the input is either inside a span or
 * a whitespace gap between two of them.
 */
export function splitSentences(text: string): SentenceSpan[] {
  if (text.trim().length === 0) return [];
  const cps = Array.from(text);
  const tops = quoteTops(cps);
  const out: SentenceSpan[] = [];
  let start = 0;
  let index = 0;
  while (index < cps.length) {
    if (!TERMINALS.has(cps[index] as string)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    // «?!», «...» and «…» are one terminator, however many marks were typed.
    while (end < cps.length && TERMINALS.has(cps[end] as string)) end += 1;
    while (end < cps.length && CLOSERS.has(cps[end] as string)) end += 1;
    if (endsSentence(cps, tops, index, end)) {
      pushSpan(out, cps, start, end);
      start = end;
    }
    index = end;
  }
  pushSpan(out, cps, start, cps.length);
  return out;
}

/**
 * Code-point offset → UTF-16 index. The splitter speaks code points (they are what the schema
 * stores); `String.prototype.slice`, `match.index` and the DOM speak UTF-16, so a consumer that
 * hands an offset to one of them converts it here instead of carrying a second splitter.
 */
export function utf16Index(text: string, codePoint: number): number {
  if (codePoint <= 0) return 0;
  let index = 0;
  let seen = 0;
  for (const char of text) {
    if (seen >= codePoint) break;
    index += char.length;
    seen += 1;
  }
  return index;
}
