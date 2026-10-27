import type { BookCostDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { COST_UNPRICED, costLine, costMoney, costTokens } from './bookCost.ts';

/**
 * The footer's cost line (BOOK-114), asserted character for character.
 *
 * The strings below carry the non-breaking space explicitly: the site's separator is `\u00a0`
 * (DESIGN §4.3, `format.ts`), never a breakable space and never the thin U+202F — PT Mono has
 * no glyph for it. A test that compared against a plain space would pass for a line the design
 * does not print.
 */

const NBSP = '\u00a0';

function cost(overrides: Partial<BookCostDto> = {}): BookCostDto {
  return { tokens: 1_234_567, tokensIn: 1_000_000, tokensOut: 234_567, steps: 9, usd: 12.34, unpriced: [], ...overrides };
}

describe('the cost line', () => {
  it('writes the count in the book’s numbers, the money in cents, and one middot between', () => {
    expect(costLine(cost())).toBe(`израсходовано 1${NBSP}234${NBSP}567 токенов · 12,34${NBSP}$`);
    // The space inside the number and before the currency never breaks the line.
    expect(costLine(cost())).not.toContain('1 234');
    expect(costLine(cost())).not.toContain('12,34 $');
    expect(costLine(cost())).not.toContain('\u202f');
  });

  it('carries the noun the count asks for', () => {
    expect(costLine(cost({ tokens: 1, usd: 0 }))).toBe(`израсходовано 1 токен · 0,00${NBSP}$`);
    expect(costLine(cost({ tokens: 22, usd: 0 }))).toBe(`израсходовано 22 токена · 0,00${NBSP}$`);
    expect(costLine(cost({ tokens: 25, usd: 0 }))).toBe(`израсходовано 25 токенов · 0,00${NBSP}$`);
  });

  it('prints a measured zero for an empty book', () => {
    expect(costLine(cost({ tokens: 0, tokensIn: 0, tokensOut: 0, steps: 0, usd: 0 }))).toBe(
      `израсходовано 0 токенов · 0,00${NBSP}$`,
    );
  });

  it('prints «цена не задана» for an unpriced book, and never a partial figure', () => {
    const unpriced = cost({ usd: null, unpriced: ['mystery-llm'] });
    expect(costLine(unpriced)).toBe(`израсходовано 1${NBSP}234${NBSP}567 токенов · ${COST_UNPRICED}`);
    expect(costLine(unpriced)).not.toContain('$');
    expect(costLine(unpriced)).not.toContain(NBSP + '$');
  });

  it('never prints NaN or a minus sign for a payload that is not a measurement', () => {
    for (const tokens of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(costTokens(cost({ tokens }))).toBe('израсходовано 0 токенов ·');
      expect(costLine(cost({ tokens }))).not.toContain('NaN');
      expect(costLine(cost({ tokens }))).not.toContain('-');
    }
    // A money part that is not a finite non-negative number is not a price: it names the state.
    for (const usd of [Number.NaN, -12.34, Number.POSITIVE_INFINITY]) {
      expect(costMoney(cost({ usd }))).toBe(COST_UNPRICED);
      expect(costLine(cost({ usd }))).not.toContain('NaN');
      expect(costLine(cost({ usd }))).not.toMatch(/-12/u);
    }
  });

  it('splits into the two fragments the markup renders, and the fragments are the sentence', () => {
    const priced = cost();
    expect(costTokens(priced)).toBe(`израсходовано 1${NBSP}234${NBSP}567 токенов ·`);
    expect(costMoney(priced)).toBe(`12,34${NBSP}$`);
    expect(`${costTokens(priced)} ${costMoney(priced)}`).toBe(costLine(priced));
  });
});
