import type { HeadWord } from './stateWords.ts';

/**
 * BOOK-DOC-84 §10.9 — the words a live page prints: the ladder's counters, the head line's
 * parts and the widening. Split from `stateWords.ts` at the arch bound; `stateWords.ts`
 * re-exports every name, so no call site imports two modules for one vocabulary.
 */

/* ── BOOK-DOC-84 §10.9 — the book's own counters and the ladder's words ─────────────────────── */

/** §10.2's internal kinds, mapped to the head word they take (§10.9's table). */
export type NowKind =
  | 'тихо'
  | 'читается'
  | 'повтор'
  | 'ждёт'
  | 'пишется'
  | 'проверяется'
  | 'доработка'
  | 'расширение'
  | 'нет связи'
  | 'сбой';

/**
 * The 1:1 rows of §10.9's table. `расширение` is deliberately absent: it keeps the surface's
 * word («правку читают» / «главу пишут») and its note is the author's line, never the head's.
 */
export const HEAD_WORD_OF: Record<Exclude<NowKind, 'расширение'>, HeadWord> = {
  тихо: 'idle',
  читается: 'reading',
  повтор: 'waiting',
  ждёт: 'waiting',
  пишется: 'drafting',
  проверяется: 'gates',
  доработка: 'drafting',
  'нет связи': 'offline',
  // A defect is not a kind the head prints: the machine runs nothing, and `тихо` is true.
  сбой: 'idle',
};

/** Attempts 1..6: the forms of a filing's try and of a fix to written text. */
export type AttemptForm = 'attempt' | 'fix';

const ORDINAL_FEMININE = ['первая', 'вторая', 'третья', 'четвёртая', 'пятая', 'шестая'] as const;
const GENITIVE_COUNT: Record<number, string> = { 5: 'пяти', 6: 'шести' };

const UNIT_FEMININE = [
  'ноль',
  'одна',
  'две',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
] as const;

const UNIT_MASCULINE = [
  'ноль',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
] as const;

const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят'] as const;

/** A whole number in words, 0..59 — the only range a counter or a minute can take. */
function cardinal(value: number, unit: readonly string[]): string {
  const n = Math.max(0, Math.min(59, Math.trunc(value)));
  if (n < 20) return unit[n] ?? 'ноль';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const rest = n % 10;
  return rest === 0 ? tens : `${tens} ${unit[rest] ?? ''}`.trim();
}

/** Russian plural for a counted noun: 1 → one, 2..4 → few, else many. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * §10.9: attempts 1..6, as the author's line prints them.
 *
 * `attemptWord(2, 5)` → `вторая из пяти`; `attemptWord(3, 5, 'fix')` → `третья поправка из пяти`;
 * the sixth is always the last one and always says so: `последняя, шестая`.
 */
export function attemptWord(n: number, max: number, form: AttemptForm = 'attempt'): string {
  const count = Math.max(5, Math.min(6, Math.trunc(max)));
  const number = Math.max(1, Math.min(6, Math.trunc(n)));
  if (number === 6) return form === 'fix' ? 'последняя, шестая поправка' : 'последняя, шестая';
  const ordinal = ORDINAL_FEMININE[number - 1] ?? 'первая';
  const of = GENITIVE_COUNT[count] ?? 'пяти';
  return form === 'fix' ? `${ordinal} поправка из ${of}` : `${ordinal} из ${of}`;
}

/**
 * §10.9: an elapsed time or a wait, in whole words.
 *
 * under 60 s → `меньше минуты`; 60–119 s → `минута`; then whole minutes; from an hour, hours;
 * from a day, days. A negative span is the same as zero (clocks disagree; a deadline does not).
 */
export function minutesWord(ms: number): string {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (value < 60_000) return 'меньше минуты';
  if (value < 120_000) return 'минута';
  const totalMinutes = Math.floor(value / 60_000);
  if (totalMinutes < 60) {
    return `${cardinal(totalMinutes, UNIT_FEMININE)} ${plural(totalMinutes, 'минута', 'минуты', 'минут')}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    if (hours === 1) return 'час';
    return `${cardinal(hours, UNIT_MASCULINE)} ${plural(hours, 'час', 'часа', 'часов')}`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return 'сутки';
  if (days === 2) return 'двое суток';
  if (days === 3) return 'трое суток';
  if (days === 4) return 'четверо суток';
  return `${cardinal(days, UNIT_FEMININE)} суток`;
}

/** §10.9: the queue's place. 0 → `следом`; the rest name the filings ahead, in words. */
export function aheadWord(n: number): string {
  const ahead = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  if (ahead === 0) return 'следом';
  const count = cardinal(ahead, UNIT_FEMININE);
  return `впереди ${count} ${plural(ahead, 'правка', 'правки', 'правок')}`;
}

/** §10.9: `0,05 $` measured, `≈ 0,05 $` estimated — two decimals, comma, space before the sign. */
export function moneyWord(usd: number, estimated = false): string {
  const value = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  const amount = `${value.toFixed(2).replace('.', ',')} $`;
  return estimated ? `≈ ${amount}` : amount;
}

/** The four widenings the engine may name; the sentence is the reader's, the code is the fact. */
export type WidenedCode = 'wider-edit' | 'whole-chapter' | 'as-document' | 'stricter-check';

const WIDENED_WORDS: Record<WidenedCode, string> = {
  'wider-edit': 'правим шире: не строку, а абзац',
  'whole-chapter': 'правим шире: всю главу',
  'as-document': 'просим читать как документ',
  'stricter-check': 'проверяем строже',
};

/** §10.9: the widening in human words — never «переписывание вместо патча». */
export function widenedWord(code: string): string {
  return WIDENED_WORDS[code as WidenedCode] ?? '';
}

/** The runtime list, for a validator that must reject an unknown code rather than caption it. */
export const WIDENED_CODES = Object.keys(WIDENED_WORDS) as WidenedCode[];

/** Is this string one the engine may store as a widening code? */
export function isWidenedCode(value: unknown): value is WidenedCode {
  return typeof value === 'string' && (WIDENED_CODES as readonly string[]).includes(value);
}

// ── §11.1 — the head's own line ────────────────────────────────────────────
//
// The head is one status line now (BOOK-DOC-84 §11.1), not seven words, and its grammar lives
// here with the rest of the reader-visible vocabulary: `машина` is the one machine noun the head
// may print, `правка`/`глава`/`редакция`/`раунд`/`попытка`/`поправка` are the book's own nouns,
// and a gate keeps its three names. Every rendered word of the line comes from this block; the
// line's own composition (the separators, the clock) is here too, so a module that prints a
// status never invents a string.

/** The one machine noun the head may print (§11.1). */
export const MACHINE = 'машина';

/** What the machine is doing, as the head's verb — never a stage name, never a model. */
export const NOW_VERBS = {
  /** `машина читает правку 012` — a filing's reading or a writer's own read. */
  reading: 'читает',
  /** `машина пишет главу 1` — a draft or a revision that writes text. */
  writing: 'пишет',
  /** `машина меняет подход к правке 012` — the widening, in the reader's words. */
  approach: 'меняет подход к правке',
  /** `машина проверяет главу 1` — a gate round. */
  checking: 'проверяет',
  /** `машина правит по замечанию` — an iteration after a gate's finding. */
  fixing: 'правит по замечанию',
  /** `правка 012 ждёт` — a queue place or a retry, a wait and never a claim of work. */
  waiting: 'ждёт',
  /** `внесено` — the one outcome the book announces. */
  landed: 'внесено',
  /** `не дошло: …` — a work that ended without its text. */
  notDelivered: 'не дошло',
  /** `не принято: …` — a filing the book answered with a no. */
  refused: 'не принято',
  /** `нет связи` — the page cannot see the machine; it is not a stage. */
  offline: 'нет связи',
} as const;

/** The book's nouns around the verbs, so no surface spells them itself. */
export const NOW_NOUNS = {
  filing: 'правка',
  chapter: 'глава',
  /** The same chapter as the object of a verb: `пишет главу 1`, `проверяет главу 1`. */
  chapterAccusative: 'главу',
  edition: 'редакция',
  attempt: 'попытка',
  fix: 'поправка',
  round: 'раунд',
  /** `впереди` — the queue's place, then its number. */
  ahead: 'впереди',
} as const;

/** The three gates, in the head's own register (`редактор`/`консультант`/`права`). */
export const GATE_WORD: Record<string, string> = {
  editor: 'редактор',
  consultant: 'консультант',
  rights: 'права',
};

/** The separator of the head's parts, and the space it carries in the rendered line. */
export const LINE_SEPARATOR = '·';

/**
 * `правка 012` — a filing's number is its change's own sequence, padded to three figures (the
 * record and the trail print the same numeral). No change named ⇒ `правка` alone: a number that
 * no row carries is not invented (§11.1's honesty rule).
 */
export function filingWord(seq: number | null | undefined): string {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return NOW_NOUNS.filing;
  return `${NOW_NOUNS.filing} ${String(Math.trunc(seq)).padStart(3, '0')}`;
}

/** `глава 1`, `глава 7` — the book's own name for a chapter. */
export function chapterWord(n: number): string {
  return `${NOW_NOUNS.chapter} ${String(Math.trunc(n))}`;
}

/** `главу 1` — the same chapter as the object of a verb (`пишет`, `проверяет`). */
export function chapterAccusativeWord(n: number): string {
  return `${NOW_NOUNS.chapterAccusative} ${String(Math.trunc(n))}`;
}

/** `глава 1, редакция 13` — the write's own receipt. */
export function editionWord(n: number, rev: number): string {
  return `${chapterWord(n)}, ${NOW_NOUNS.edition} ${String(Math.trunc(rev))}`;
}

/** `попытка 1 из 5` — the frame's own numbers, never a default (§11.1). */
export function headAttemptWord(n: number, max: number): string {
  return `${NOW_NOUNS.attempt} ${String(Math.trunc(n))} из ${String(Math.trunc(max))}`;
}

/** `поправка 2 из 5` — an iteration that fixes text a gate has read. */
export function headFixWord(n: number, max: number): string {
  return `${NOW_NOUNS.fix} ${String(Math.trunc(n))} из ${String(Math.trunc(max))}`;
}

/** `впереди 2` — the queue's place, in the head's digits (the author's line keeps words). */
export function aheadDigitsWord(n: number): string {
  const ahead = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  return `${NOW_NOUNS.ahead} ${String(ahead)}`;
}

/** `редактор, раунд 1` — the gate and its round; a gate with no round is its name alone. */
export function gateRoundWord(gate: string | null | undefined, round: number | null | undefined): string {
  const name = gate === null || gate === undefined ? '' : (GATE_WORD[gate] ?? '');
  if (name.length === 0) return typeof round === 'number' ? `${NOW_NOUNS.round} ${String(round)}` : '';
  return typeof round === 'number' ? `${name}, ${NOW_NOUNS.round} ${String(round)}` : name;
}

const clockFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Moscow',
});

/** `17:04` — the site's one timezone (Moscow, as every other moment of the book). */
export function clockWord(ms: number): string {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return '—';
  return clockFormatter.format(at);
}

/** The piece of a line the phone's step may drop, in this order (§11.1): id, clock, gate. */
export type LineDrop = 'filing' | 'time' | 'gate';

/**
 * One part of the head's line. A part is a clause (`правка 012`, `попытка 1 из 5`); a number the
 * grammar keeps inside a verb phrase (`машина читает правку 012`) travels as the part's `tail`,
 * so the phone hides the number and never a dangling separator.
 */
export type LinePart = {
  text: string;
  tail?: { text: string; drop: LineDrop };
  drop?: LineDrop;
};

/** The head's line: the parts and their separators — one function, one voice (§11.1). */
export function headLineWord(parts: readonly LinePart[]): string {
  return parts.map((part) => part.text + (part.tail?.text ?? '')).join(` ${LINE_SEPARATOR} `);
}

/** The line a reader sees at a width that has dropped `drops` — the phone's step, as text. */
export function visibleLineWord(parts: readonly LinePart[], drops: readonly LineDrop[] = []): string {
  const kept = parts
    .filter((part) => part.drop === undefined || !drops.includes(part.drop))
    .map((part) => ({
      text: part.text,
      ...(part.tail === undefined || drops.includes(part.tail.drop) ? {} : { tail: part.tail }),
    }));
  return headLineWord(kept);
}
