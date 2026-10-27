/**
 * The book's outlay (BOOK-114): what the writing has spent so far.
 *
 * The footer states it as one line, and the line is a measurement, not a badge: the tokens are
 * counted over every closed step row, and the money is arithmetic on the rate table
 * (`server/src/cost/rates.ts`) — never a figure the page invented. Three values are kept apart
 * on the wire because the footer must keep them apart on the page: `0` is a measured zero (an
 * empty book cost nothing), `null` is **not measured** (a model spent tokens and has no rate),
 * and a number is the arithmetic. A partial total is never sent: an unpriced book has
 * `usd: null` and names the models that blanked it.
 */
export type BookCostDto = {
  /** tokens_in + tokens_out over every step row. */
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  /** Step rows counted; 0 is an honest empty book (not a blank). */
  steps: number;
  /** Σ over priced models, rounded to cents. `null` when any model that spent tokens has no rate. */
  usd: number | null;
  /** Models that spent tokens but have no rate; `null` for a step row with no model. Sorted. */
  unpriced: Array<string | null>;
};
