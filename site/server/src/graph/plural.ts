/**
 * Counted nouns, in the two languages the closure prints in (BOOK-174).
 *
 * Russian needs three forms (1 / 2–4 / 5+) and one exception that trips every naive
 * implementation: 11–14 take the many form although they end in 1–4, so `11 глав` and `21 глава`
 * are both right and a single `n === 1 ? one : few` rule is wrong for both.
 *
 * Russian also needs a second case: a noun that is the object of the sentence takes the
 * accusative (`задевает 1 главу`, not `1 глава`), and only its singular differs from the
 * nominative — 2–4 `главы` and 5+ `глав` are the same in both cases. Hence `pluralAcc`.
 *
 * English needs the opposite correction: only 1 is singular, so `21 runs` and `101 runs` are
 * plural — the Russian rule would print `21 run`. Hence two functions rather than one flag: the
 * rule belongs to the language, not to the noun.
 */

/** The Russian form, as an index: 0 = one, 1 = few (2–4), 2 = many (5+, and 11–14). */
function form(n: number): 0 | 1 | 2 {
  const value = Math.abs(Math.trunc(n));
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 2;
  const last = value % 10;
  if (last === 1) return 0;
  if (last >= 2 && last <= 4) return 1;
  return 2;
}

/** `1 узел`, `2 узла`, `5 узлов`, `11 узлов`, `21 узел`, `22 узла`. */
export function plural(n: number, one: string, few: string, many: string): string {
  const which = form(n);
  return which === 0 ? one : which === 1 ? few : many;
}

/**
 * The same rule in the accusative: `задевает 1 главу`, `задевает 2 главы`, `задевает 12 глав`.
 * Only the singular has its own form, so the two plural arguments are shared with `plural`.
 */
export function pluralAcc(n: number, oneAccusative: string, few: string, many: string): string {
  const which = form(n);
  return which === 0 ? oneAccusative : which === 1 ? few : many;
}

/** `1 run`, `2 runs`, `21 runs` — only one is singular. */
export function pluralEn(n: number, one: string, many: string): string {
  return Math.abs(Math.trunc(n)) === 1 ? one : many;
}
