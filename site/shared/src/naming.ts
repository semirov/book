/**
 * The book's words for numbers and for a change's name (BOOK-218).
 *
 * Split out of `stateWords.ts` when the reason vocabulary grew past the file bound; the words
 * are still the reader's, and `stateWords.ts` owns every **sentence about an outcome**. No
 * module may spell its own counter: `правка 014` is a change, `замечание 12` is a filing.
 */

/* ── words for numbers ─────────────────────────────────────────────────────── */

const CARDINALS = [
  '', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять',
  'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать',
  'семнадцать', 'восемнадцать', 'девятнадцать', 'двадцать',
] as const;

const CARDINAL_TENS = ['', 'десять', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'] as const;

const BOUND_TENS = ['', 'одной', 'двух', 'трёх', 'четырёх', 'пяти', 'шести', 'семи', 'восьми', 'девяти'] as const;

const ORDINALS = [
  '', 'первая', 'вторая', 'третья', 'четвёртая', 'пятая', 'шестая', 'седьмая', 'восьмая',
  'девятая', 'десятая', 'одиннадцатая', 'двенадцатая', 'тринадцатая', 'четырнадцатая',
  'пятнадцатая', 'шестнадцатая', 'семнадцатая', 'восемнадцатая', 'девятнадцатая',
] as const;

const ORDINAL_TENS = ['', '', 'двадцатая', 'тридцатая', 'сороковая', 'пятидесятая', 'шестидесятая', 'семидесятая', 'восьмидесятая', 'девяностая'] as const;

/** `2` → `две`: filings still standing before this one. 1–20; past that the tail is dropped. */
export function countWord(value: number): string | null {
  return value >= 1 && value <= 20 ? (CARDINALS[value] ?? null) : null;
}

/** `5` → `пяти`: the genitive a bound is said in (`из пяти`). 1–10, then nothing. */
export function boundWord(value: number): string | null {
  if (value >= 1 && value <= 9) return BOUND_TENS[value] ?? null;
  if (value === 10) return 'десяти';
  return null;
}

/** `3` → `третья`: an ordinal, feminine, as the book counts editions. 1–99, else `null`. */
export function ordinalWord(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > 99) return null;
  if (value < 20) return ORDINALS[value] ?? null;
  const rest = value % 10;
  const tens = CARDINAL_TENS[Math.trunc(value / 10)] ?? null;
  if (tens === null) return null;
  return rest === 0 ? (ORDINAL_TENS[Math.trunc(value / 10)] ?? null) : `${tens} ${ORDINALS[rest] ?? ''}`;
}

/** Russian plural, local to `shared`: the words here count filings, never chapters. */
function plural(value: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(value));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * The thread's line above the list: how much work stands for the chapters, in the reader's own
 * words — never «в очереди», never a lane, never a pass. The owner's latest wording
 * (BOOK-218 §5): `правок в работе нет`, `в работе 3 правки` / `1 правка` / `11 правок`.
 */
export function queueLine(depth: number): string {
  const count = Number.isFinite(depth) ? Math.max(0, Math.trunc(depth)) : 0;
  if (count === 0) return 'правок в работе нет';
  return `в работе ${String(count)} ${plural(count, 'правка', 'правки', 'правок')}`;
}

/**
 * The line that says a filing waits for its chapter — used where no state word stands above.
 */
export const WAITING_FOR_CHAPTER_LINE = 'ждёт своей главы';

/**
 * `14` → `014` — a **change's** public number. BOOK-218: one noun carries one counter, so a
 * change is «правка 014» and the reader's filing is «замечание 12» — never the same word over
 * two objects on one screen.
 */
export function changeNumber(seq: number): string {
  return String(Math.trunc(seq)).padStart(3, '0');
}

/** A change, named: `правка 014`; `правка` alone when the log carries no number for it. */
export function changeName(seq: number | null): string {
  return seq === null ? 'правка' : `правка ${changeNumber(seq)}`;
}

/** The same name where the sentence needs the genitive: `волна правки 014`. */
export function changeGenitive(seq: number | null): string {
  return seq === null ? 'правки' : `правки ${changeNumber(seq)}`;
}

/**
 * The chronicle's line for a change that was filed and nobody has taken yet: `правка 014 ждёт
 * своей главы`. Not a queue and not a lane — the chapter's turn has not come, and that is the
 * fact the reader's own vocabulary already has.
 */
export function chronicleWaiting(seq: number | null): string {
  return `${changeName(seq)} ${WAITING_FOR_CHAPTER_LINE}`;
}

/** The chronicle's line for the change the writer has in hand: `правка 014 в работе`. */
export function chronicleWorking(seq: number | null): string {
  return `${changeName(seq)} в работе`;
}

