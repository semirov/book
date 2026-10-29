/**
 * The seven normal forms a value becomes (BOOK-185, BOOK-DOC-77 §2, section 8).
 *
 * A fact's identity is its key: `document:65-11877-арх` is the same paper in chapter 3 and
 * chapter 19 only because both values pass through this file. So normalisation is form, not
 * meaning — a key never judges whether the fact is true, and a value that cannot become its key
 * is dropped (`VALUE_UNPARSEABLE`) rather than coerced, because two chapters cannot share a guess.
 *
 * The prompt asks the model for the same forms; this file does not trust it. `14.09.2065`,
 * `2065-09-14` and `65 / 11877 / арх` are accepted because they are the same fact written the way
 * a chapter writes it, and every other spelling is refused.
 */

export type FactKindForKeys = 'date' | 'document' | 'name' | 'term' | 'promise' | 'decision' | 'absence';

export type KeyResult = { ok: true; key: string } | { ok: false };

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u;
const DOTTED_DATE = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/u;
const YEARLESS_DASH = /^--(\d{1,2})-(\d{1,2})$/u;
const YEARLESS_DOT = /^(\d{1,2})[./](\d{1,2})$/u;
/** Punctuation a value picks up from its sentence and that a key never keeps. */
const EDGE_PUNCTUATION = /^[\s,;:]+|[\s,;:.!?]+$/gu;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function fullDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A day and a month with no year (`--02-19`). February's 29th is allowed: any year may hold it. */
function monthDay(month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(2000, month)) return null;
  return `--${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `14.09.2065`, `2065-09-14` or `--02-19`/`19.02` (a day and a month, no year). */
export function dateKey(raw: string): string | null {
  const value = raw.trim();
  const iso = ISO_DATE.exec(value);
  if (iso !== null) return fullDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dotted = DOTTED_DATE.exec(value);
  if (dotted !== null) return fullDate(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));
  const yearlessDash = YEARLESS_DASH.exec(value);
  if (yearlessDash !== null) return monthDay(Number(yearlessDash[1]), Number(yearlessDash[2]));
  const yearlessDot = YEARLESS_DOT.exec(value);
  if (yearlessDot !== null) return monthDay(Number(yearlessDot[2]), Number(yearlessDot[1]));
  return null;
}

/** A phrase key: lowercase, `ё` folded to `е`, inner spaces collapsed, wrapping punctuation gone. */
function phrase(raw: string): string {
  return normalisePhrase(raw.replace(/[«»"„“”]/gu, ' '));
}

function normalisePhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(EDGE_PUNCTUATION, '')
    .trim();
}

/** A part short enough to be a code (`арх`, `п`, `отк`), never a word (`заявление`, `форма`). */
const CODE_PART_CHARS = 3;

/** A part of a code: it carries a digit, or it is a short abbreviation of one. */
function isCodePart(part: string): boolean {
  return /\p{N}/u.test(part) || Array.from(part).length <= CODE_PART_CHARS;
}

/**
 * `65/11877/арх` → `65-11877-арх`, `4-У/арх` → `4-у-арх`, `4-У арх` → `4-у-арх`,
 * `65 11877 арх` → `65-11877-арх`, `заявление о прекращении` → `заявление о прекращении`,
 * `заявление 4-К` → `заявление 4-к`, `А-039` → `а-039`.
 *
 * A separator becomes a hyphen only where it **joins** two parts of one code, and a code is a value
 * that holds a digit: `65/11877/арх` is one number, `заявление о прекращении` is words. Inside such
 * a value a `/` always joins (`4-У/арх` has no digit on the right of its slash), and a space joins
 * when both neighbours are code parts — a digit or a short abbreviation — so `4-У арх` and
 * `65 11877 арх` are the number they are, while `заявление 4-К` keeps its space because
 * `заявление` is a word. The v1 rule deleted every space, so «заявление о прекращении» became
 * `заявлениеопрекращении` and a re-telling with spaces became a second document (BOOK-185 defect
 * 3); the v2 rule kept every space, so `4-У/арх` and `4-У арх` were two documents (defect 4).
 * `№` is a label, not part of the number, and it leaves a space behind for the same reason.
 */
export function documentKey(raw: string): string | null {
  const stripped = raw.replace(/№/gu, ' ');
  const hasDigit = /\p{N}/u.test(stripped);
  const joined = hasDigit
    ? stripped.replace(/\s*\/\s*/gu, '-')
    : stripped.replace(/\s*\/\s*/gu, ' ');
  const parts = joined.split(/\s+/u).filter((part) => part.length > 0);
  let value = parts[0] ?? '';
  for (let index = 1; index < parts.length; index += 1) {
    const left = parts[index - 1] ?? '';
    const right = parts[index] ?? '';
    value += `${hasDigit && isCodePart(left) && isCodePart(right) ? '-' : ' '}${right}`;
  }
  const normalised = normalisePhrase(value);
  return /[\p{L}\p{N}]/u.test(normalised) ? normalised : null;
}

/**
 * The two halves of an `@` value: `predicate@deadline`, `verb@object`, `subject@what-ended`.
 *
 * The right half is a date often enough to matter: `вернуться@19.02` and `вернуться@--02-19` are
 * one promise, and a key that told them apart would split a fact the book states once. A right
 * half that is not a date (`отказ`, `закрыто`) is left as the phrase it is.
 */
function halves(raw: string): { left: string; right: string } | null {
  const at = raw.indexOf('@');
  if (at === -1) return null;
  const left = normalisePhrase(raw.slice(0, at));
  const right = normalisePhrase(raw.slice(at + 1));
  if (left.length === 0 || right.length === 0) return null;
  return { left, right: dateKey(right) ?? right };
}

/**
 * The key a value becomes. `{ ok: false }` is not a soft failure: an unparseable value is dropped
 * with `VALUE_UNPARSEABLE`, because a fact whose key is a guess is a fact two chapters cannot share.
 */
export function keyOf(kind: FactKindForKeys, raw: string): KeyResult {
  switch (kind) {
    case 'date': {
      const date = dateKey(raw);
      return date === null ? { ok: false } : { ok: true, key: `date:${date}` };
    }
    case 'document': {
      const document = documentKey(raw);
      return document === null ? { ok: false } : { ok: true, key: `document:${document}` };
    }
    case 'name':
    case 'term': {
      // A name is a person's name: a digit in it is a room, a street number or a document, never a
      // person, and the validator can catch exactly this much of that mistake (BOOK-185 defect 1).
      if (kind === 'name' && /\p{N}/u.test(raw)) return { ok: false };
      const value = phrase(raw);
      return value.length === 0 ? { ok: false } : { ok: true, key: `${kind}:${value}` };
    }
    default: {
      const parts = halves(raw);
      return parts === null ? { ok: false } : { ok: true, key: `${kind}:${parts.left}@${parts.right}` };
    }
  }
}
