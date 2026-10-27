import { describe, expect, it } from 'vitest';

import { measuredRub } from '../src/publicChange.ts';

/**
 * «Honesty about cost» (BOOK-DOC-4, BOOK-23): a stored amount is a measurement only when the
 * row carries the `cost_priced` marker. Without it, every zero is the column's placeholder
 * and must travel as `null`; with it, a zero is a real «0,00 ₽».
 */
describe('measuredRub', () => {
  it('keeps a priced amount, including a priced zero', () => {
    expect(measuredRub(0.42, true)).toBe(0.42);
    expect(measuredRub(0, true)).toBe(0);
  });

  it('turns an unpriced amount — even a positive one — into absence', () => {
    expect(measuredRub(0, false)).toBeNull();
    expect(measuredRub(12.5, false)).toBeNull();
  });

  it('refuses a number that cannot be a price', () => {
    expect(measuredRub(Number.NaN, true)).toBeNull();
    expect(measuredRub(Number.POSITIVE_INFINITY, true)).toBeNull();
    expect(measuredRub(-3, true)).toBeNull();
    expect(measuredRub(null, true)).toBeNull();
  });
});
