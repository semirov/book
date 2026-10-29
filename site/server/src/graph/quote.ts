/**
 * The quote arithmetic (BOOK-185, BOOK-DOC-77 §3): where a quote sits, and which sentence holds it.
 *
 * Offsets are **code points**, the unit the ledger stores (`ledger/spans.ts`), and the witness is
 * recomputed from the block's own text with `sliceCp` — a mention whose offsets a UTF-16 search
 * produced is a quote that splits a surrogate pair, and a reader copying it from the book would
 * not find it.
 *
 * A quote is searched per block and in reading order: the first block that contains it verbatim
 * wins, so two runs of the same answer agree. A quote that only exists across a paragraph break is
 * not a quote — a fact is asserted by a paragraph, and the mention it produces must sit in one.
 *
 * The sentence is **form, not meaning**: the model's own sentence is kept when the block holds it
 * verbatim and it contains the quote (the model read the paragraph), and otherwise the sentence is
 * cut on `. ! ? …`. The row's `statement` is always the block's sentence: a paraphrase that
 * mentions the witness is not what the chapter says. Two runs of the same chapter cut the same
 * sentence, and nothing here decides what the sentence says.
 */

import { cpLength, cpOffsetOf, sliceCp } from '../ledger/spans.ts';
import { findLiterals } from '../ledger/mentions.ts';
import { dateKey } from './keys.ts';
import type { FactKind } from './schema.ts';

export type Block = { id: string; text: string };

/** Where an accepted item sits in the chapter: the mention the ledger will write. */
export type Evidence = {
  blockId: string;
  /** Code-point offsets in the block's text. */
  start: number;
  end: number;
  witness: string;
  /** The sentence the model quoted, kept only when the block holds it verbatim. */
  sentence: string;
  /**
   * The block's own sentence around the witness: the row's one-line reading aid. Never the
   * model's wording — a paraphrase that mentions the witness is not what the chapter says.
   */
  statement: string;
};

export type Located = { blockId: string; blockText: string; start: number; end: number; witness: string };

/** How long a derived sentence may be. A sentence is a reading aid, not a paragraph. */
export const SENTENCE_LIMIT = 280;

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['»', '”', '"', ')', ']', "'"]);

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char);
}

/** The index just past the terminators and closing quotes that end a sentence at `index`. */
function endAfter(cps: readonly string[], index: number): number {
  let at = index + 1;
  while (at < cps.length && CLOSERS.has(cps[at] ?? '')) at += 1;
  return at;
}

function closesSentence(cps: readonly string[], index: number): boolean {
  return TERMINATORS.has(cps[index] ?? '') && isSpace(cps[endAfter(cps, index)]);
}

/**
 * The sentence that holds `[start, end)` inside one block. A sentence longer than `SENTENCE_LIMIT`
 * is a window that keeps the quote: a sentence the quote cannot be found in is not the sentence
 * that holds it.
 */
export function sentenceAround(text: string, start: number, end: number): string {
  const cps = Array.from(text);
  let left = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (closesSentence(cps, index)) {
      left = endAfter(cps, index);
      break;
    }
  }
  let right = cps.length;
  for (let index = Math.max(end - 1, 0); index < cps.length; index += 1) {
    if (closesSentence(cps, index)) {
      right = endAfter(cps, index);
      break;
    }
  }
  while (left < right && isSpace(cps[left])) left += 1;
  while (right > left && isSpace(cps[right - 1])) right -= 1;
  let from = right - left > SENTENCE_LIMIT ? Math.max(left, Math.min(start, right - SENTENCE_LIMIT)) : left;
  let to = Math.min(right, from + SENTENCE_LIMIT);
  // A window narrower than the quote cannot hold it, and a reading aid that lost the witness is
  // not the sentence the witness is in: cut from the witness itself instead. A quote longer than
  // `SENTENCE_LIMIT` yields its own head, which is the most of it a sentence may carry.
  if (start < from || end > to) {
    from = start;
    to = Math.min(right, start + SENTENCE_LIMIT);
  }
  return cps
    .slice(from, to)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The first block (reading order) that contains the quote verbatim. `indexOf` finds it, the
 * offsets are converted once, and the witness is recomputed from `block.text`.
 */
export function locate(quote: string, blocks: readonly Block[]): Located | null {
  if (quote.trim().length === 0) return null;
  for (const block of blocks) {
    const at = block.text.indexOf(quote);
    if (at === -1) continue;
    const start = cpOffsetOf(block.text, at);
    const end = start + cpLength(quote);
    const witness = sliceCp(block.text, start, end);
    if (witness !== quote) continue;
    return { blockId: block.id, blockText: block.text, start, end, witness };
  }
  return null;
}

/** The model's sentence when the block holds it verbatim and it contains the quote; else the block's own sentence. */
export function evidenceOf(located: Located, model?: string): Evidence {
  const derived = sentenceAround(located.blockText, located.start, located.end);
  const claimed = (model ?? '').trim();
  const sentence =
    claimed.length > 0 && located.blockText.includes(claimed) && claimed.includes(located.witness)
      ? claimed
      : derived;
  return {
    blockId: located.blockId,
    start: located.start,
    end: located.end,
    witness: located.witness,
    sentence,
    statement: derived,
  };
}

// ---------------------------------------------------------------------------------------------
// Does the quote prove the value? (BOOK-185 defect 2: a found quote is not a proven value)
// ---------------------------------------------------------------------------------------------

/** The first n letters of the value's first word: `пенькова`/`пенькову` → `пень`. */
const STEM_LETTERS = 4;

/**
 * The stem of the value's first word: the first four letters, or one letter fewer in a word that
 * is only four letters long. `явка` and `явку` are one word, and taking all four letters of `явка`
 * would make the ending the test — the live ch15 answer `decision:подписать@явка` was refused for a
 * quote that says «свою явку», which is exactly the false negative a stem exists to prevent.
 */
export function stemOf(text: string): string {
  const word = supportNormalised(text).split(' ')[0] ?? '';
  return word.slice(0, Math.min(STEM_LETTERS, Math.max(2, word.length - 1)));
}

/**
 * The comparison form of a quote or a value: NFKC, lowercase, `ё` → `е`, every run of punctuation
 * and separators to one space. Two spellings of one phrase land on the same words.
 */
export function supportNormalised(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The same words with nothing between them: `65/11877/арх` → `6511877арх`. */
export function supportCore(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The words of a text, case- and `ё`-folded, hyphenated numbers kept whole:
 * `Третьего 1-го мая` → `['третьего', '1-го', 'мая']`.
 */
function wordsOf(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/ё/gu, 'е')
      .match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []
  );
}

/**
 * A Russian month and the forms a chapter writes it (`сентября`, `сентябре`, `мая`), anchored to
 * one word. The tail bound keeps `мартышка` out: a month stem takes at most three more letters.
 * A table, not one regex, because the day matcher must know **which** month a word names — a
 * month word by itself proves no date.
 */
const MONTH_FORMS: ReadonlyArray<readonly [number, RegExp]> = [
  [1, /^январ[а-я]{0,3}$/u],
  [2, /^феврал[а-я]{0,3}$/u],
  [3, /^март[а-я]{0,3}$/u],
  [4, /^апрел[а-я]{0,3}$/u],
  [5, /^ма[йя]$/u],
  [6, /^июн[а-я]{0,3}$/u],
  [7, /^июл[а-я]{0,3}$/u],
  [8, /^август[а-я]{0,3}$/u],
  [9, /^сентябр[а-я]{0,3}$/u],
  [10, /^октябр[а-я]{0,3}$/u],
  [11, /^ноябр[а-я]{0,3}$/u],
  [12, /^декабр[а-я]{0,3}$/u],
];

/** The month one folded word names (`сентября` → 9), or null when it is not a month word. */
export function monthOf(word: string): number | null {
  for (const [month, form] of MONTH_FORMS) if (form.test(word)) return month;
  return null;
}

/** Ordinal day words, folded, in reading order: `['первое', 'первого']` is the first of the month. */
const DAY_ORDINALS: ReadonlyArray<readonly [string, string]> = [
  ['первое', 'первого'],
  ['второе', 'второго'],
  ['третье', 'третьего'],
  ['четвертое', 'четвертого'],
  ['пятое', 'пятого'],
  ['шестое', 'шестого'],
  ['седьмое', 'седьмого'],
  ['восьмое', 'восьмого'],
  ['девятое', 'девятого'],
  ['десятое', 'десятого'],
  ['одиннадцатое', 'одиннадцатого'],
  ['двенадцатое', 'двенадцатого'],
  ['тринадцатое', 'тринадцатого'],
  ['четырнадцатое', 'четырнадцатого'],
  ['пятнадцатое', 'пятнадцатого'],
  ['шестнадцатое', 'шестнадцатого'],
  ['семнадцатое', 'семнадцатого'],
  ['восемнадцатое', 'восемнадцатого'],
  ['девятнадцатое', 'девятнадцатого'],
];

/** `двадцатое`/`тридцатое` on their own, and the first word of `двадцать первое`. */
const DAY_TENS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [20, ['двадцатое', 'двадцатого']],
  [30, ['тридцатое', 'тридцатого']],
];
const DAY_TENS_PREFIX: Readonly<Record<string, number>> = { двадцать: 20, тридцать: 30 };

const DAY_WORD = new Map<string, number>();
for (const [index, forms] of DAY_ORDINALS.entries()) {
  for (const form of forms) DAY_WORD.set(form, index + 1);
}
for (const [day, forms] of DAY_TENS) {
  for (const form of forms) DAY_WORD.set(form, day);
}

/** The day one token states: `14`, `14-го`, `четырнадцатое`; null for anything else. */
function dayOfWord(word: string): number | null {
  const numeric = /^(\d{1,2})(?:-(?:го|е|ое))?$/u.exec(word);
  if (numeric !== null) {
    const day = Number(numeric[1]);
    return day >= 1 && day <= 31 ? day : null;
  }
  return DAY_WORD.get(word) ?? null;
}

/**
 * The day written beside the month at `index` — before it (`14 сентября`) or after it
 * (`сентября 14-го`). `двадцать первое` is one day written as two words.
 */
function dayNextToMonth(words: readonly string[], index: number): number | null {
  for (const step of [-1, 1] as const) {
    const word = words[index + step];
    if (word === undefined) continue;
    const day = dayOfWord(word);
    if (day === null) continue;
    const base = DAY_TENS_PREFIX[words[index + step * 2] ?? ''];
    if (base !== undefined && day <= 9) return base + day;
    return day;
  }
  return null;
}

/** The parts of a key's date (`2065-09-14`, `--02-19`); null for anything not keyed as a date. */
type DateParts = { year: number | null; month: number; day: number };

function dateParts(value: string): DateParts | null {
  const full = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (full !== null) return { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) };
  const yearless = /^--(\d{2})-(\d{2})$/u.exec(value);
  if (yearless === null) return null;
  return { year: null, month: Number(yearless[1]), day: Number(yearless[2]) };
}

/** One day and one month; the year is compared only when both sides state one. */
function sameDate(left: DateParts, right: DateParts): boolean {
  if (left.month !== right.month || left.day !== right.day) return false;
  return left.year === null || right.year === null || left.year === right.year;
}

/**
 * Does the quote state **this** date — the same day and the same month? A literal (`14.09.2065`,
 * `14.09`) is the numeric form; a word date (`четырнадцатое сентября`, `14-го сентября`) counts
 * only when both halves are there, in any case. The year may be missing from the quote. A month
 * word on its own proves nothing: `date:2065-09-14` was «supported» by `Третьего мая` before this
 * check, and a fabricated value passed the guard the redesign exists for.
 */
export function dateProven(key: string, quote: string): boolean {
  const wanted = dateParts(key);
  if (wanted === null) return false;
  for (const found of findLiterals(quote)) {
    const literal = found.kind === 'date' ? dateParts(found.literal) : null;
    if (literal !== null && sameDate(wanted, literal)) return true;
  }
  const words = wordsOf(quote);
  for (const [index, word] of words.entries()) {
    if (monthOf(word) !== wanted.month) continue;
    if (dayNextToMonth(words, index) === wanted.day) return true;
  }
  return false;
}

/**
 * The document's number or words, as a whole: the value's alphanumeric core occurs in the quote,
 * and a number is never matched inside a longer one. `document:12` is not proven by
 * «Приказ 121 подшит», because «12» there is part of 121.
 */
function hasCore(quote: string, value: string): boolean {
  const core = supportCore(value);
  if (core === '') return false;
  const hay = supportCore(quote);
  const startsDigit = /^\p{N}/u.test(core);
  const endsDigit = /\p{N}$/u.test(core);
  let from = hay.indexOf(core);
  while (from !== -1) {
    const gluedLeft = startsDigit && /\p{N}/u.test(hay[from - 1] ?? '');
    const gluedRight = endsDigit && /\p{N}/u.test(hay[from + core.length] ?? '');
    if (!gluedLeft && !gluedRight) return true;
    from = hay.indexOf(core, from + 1);
  }
  return false;
}

/** One value and its quote, as the restatement index keys them. */
export type Restatable = { kind: FactKind; key: string };

/**
 * An identity the key does not see (BOOK-185 defect 4): a value's alphanumeric core
 * (`document:один-четыре` vs `document:один четыре`) and a quote word for word. Two items of one
 * kind that share either are one fact told twice — the caller decides what that means (a mention,
 * a duplicate), this file only answers the question.
 */
export type Restatements<T> = {
  remember: (item: T & Restatable, quote: string) => void;
  find: (kind: FactKind, key: string, quote: string) => T | undefined;
};

export function restatementIndex<T extends Restatable>(): Restatements<T> {
  const byCore = new Map<string, T>();
  const byQuote = new Map<string, T>();
  const coreSlot = (kind: FactKind, key: string): string =>
    `${kind}|${supportCore(key.slice(key.indexOf(':') + 1))}`;
  return {
    remember(item: T, quote: string): void {
      const core = coreSlot(item.kind, item.key);
      if (!byCore.has(core)) byCore.set(core, item);
      const exact = `${item.kind}|${quote}`;
      if (!byQuote.has(exact)) byQuote.set(exact, item);
    },
    find(kind: FactKind, key: string, quote: string): T | undefined {
      return byCore.get(coreSlot(kind, key)) ?? byQuote.get(`${kind}|${quote}`);
    },
  };
}

/**
 * Why the quote does not prove the value, or `null` when it does. The value is the key's own part
 * (`document:заявление о прекращении` → `заявление о прекращении`), so this file and `keys.ts`
 * never disagree about which form is being proved.
 *
 * The four rules of BOOK-185 §3, defect 2: a document's number must occur in the quote as a whole
 * number, a date must be **the same day and month** there (a month word alone is not a date), a
 * name or a term must have its stem there, and a compound fact must have **both** halves there —
 * `@существование` is a half the text never says.
 */
export function supportProblem(kind: FactKind, key: string, quote: string): string | null {
  const value = key.slice(key.indexOf(':') + 1);
  const text = supportNormalised(quote);
  if (kind === 'document') {
    return hasCore(quote, value) ? null : 'the quote does not contain the document number or its words';
  }
  if (kind === 'date') {
    return dateProven(value, quote) ? null : 'the quote states no such date';
  }
  if (kind === 'name' || kind === 'term') {
    const stem = stemOf(value);
    return stem.length > 0 && text.includes(stem) ? null : `the quote does not contain the ${kind}`;
  }
  const at = value.indexOf('@');
  const left = at === -1 ? value : value.slice(0, at);
  const right = at === -1 ? '' : value.slice(at + 1);
  if (!text.includes(stemOf(left))) return `the quote does not contain the act of the ${kind}`;
  if (kind === 'promise') {
    const deadline = dateKey(right);
    if (deadline !== null) {
      return dateProven(deadline, quote) ? null : 'the quote states no deadline';
    }
    return text.includes(stemOf(right)) ? null : 'the quote does not contain the deadline of the promise';
  }
  return text.includes(stemOf(right)) ? null : `the quote does not contain the object of the ${kind}`;
}
