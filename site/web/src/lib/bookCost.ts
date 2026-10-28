/**
 * The colophon's cost line (BOOK-114), pure: the copy a footer prints and nothing else.
 *
 * The line is a measurement, so it is written the way the book writes numbers (DESIGN §4.3):
 * thousands separated by a non-breaking space, the noun following the count through `plural`,
 * and the money in cents with a comma — the same convention the change card uses for «0,04 ₽».
 * `usd === null` is **not measured** and prints «цена не задана»: an unpriced book never shows
 * a partial total, and an unknown total is not a zero.
 */

import type { BookCostDto } from '@book/shared';

import { NBSP, formatNumber, plural } from './format.ts';

/** `цена не задана` — never a figure for an unpriced book. */
export const COST_UNPRICED = 'цена не задана';

/**
 * The count fragment, with the separator: `израсходовано 1 234 567 токенов ·`. The markup keeps
 * the money in its own span so the line can break between the two halves and nowhere else.
 */
export function costTokens(cost: BookCostDto): string {
  // The server sends a whole, non-negative count; a mangled payload prints zero rather than
  // `NaN` or a minus sign, because neither is a total.
  const tokens = Number.isFinite(cost.tokens) && cost.tokens > 0 ? Math.trunc(cost.tokens) : 0;
  return `израсходовано ${formatNumber(tokens)} ${plural(tokens, 'токен', 'токена', 'токенов')} ·`;
}

/** The money fragment: `12,34 $`, or `цена не задана` when no rate could price the book. */
export function usdText(usd: number | null): string {
  // Anything that is not a finite non-negative number is not a price either: printing `NaN $`
  // or `-12,34 $` would be a figure nobody measured.
  if (usd === null || !Number.isFinite(usd) || usd < 0) return COST_UNPRICED;
  return `${usd.toFixed(2).replace('.', ',')}${NBSP}$`;
}

/** The book's money as the colophon prints it. */
export function costMoney(cost: BookCostDto): string {
  return usdText(cost.usd);
}

/** The footer's one line: `израсходовано 1 234 567 токенов · 12,34 $`. */
export function costLine(cost: BookCostDto): string {
  return `${costTokens(cost)} ${costMoney(cost)}`;
}
