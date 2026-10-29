import { describe, expect, it } from 'vitest';

import { blankComments, exactly, rulesOf, squash } from './measure.css.ts';

/**
 * The chapter head is three deliberate steps — numeral, data, state — and they stand on the
 * design's 4 px grid, not glued one under the other. Measured on prod before this change, the
 * numeral's 26 px box (line-height 1) met `.ch-meta` at 0.00 px on every width, so «01» and
 * «9 003 знака · 14:20» read as one block.
 *
 * The claims are the sheet's, read as text through the same reader `measure.test.ts` uses: a
 * layout test would need a browser font metric, and the numbers here are the design's, not the
 * font's. The second case runs the same reading on a replica of the old sheet (the four values
 * `origin/main` states) — a guard nobody has seen fire is a comment.
 */

const BOOK = '../styles/book.css';
const SHEETS = import.meta.glob<string>('../styles/book.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const book: string = SHEETS[BOOK] ?? '';

/**
 * Every value a sheet states for `property` on a rule whose selector is exactly `selector` —
 * *every* such rule, the ones inside `@media` included (`rulesOf` carries their `at`), so a
 * step re-stated at a narrower width cannot hide behind the first match.
 */
function statedValues(css: string, selector: string, property: string): string[] {
  return rulesOf(BOOK, blankComments(css))
    .filter((rule) => exactly(rule, selector))
    .map((rule) => rule.declarations.get(property))
    .filter((value): value is string => value !== undefined);
}

/** A claim the head makes: `selector { property: value }`. */
type Claim = readonly [selector: string, property: string, value: string];

/**
 * The three steps, plus the numeral's size — the denominator of the 26/32 leading the head is
 * built on. `.ch-status` is a `margin` shorthand, and the whole of it is pinned (`4px 0 0`):
 * the third step is sheet text only — no shot carries it, because the captured slot is written
 * and `.ch-status` is not in that DOM.
 */
const CLAIMS: ReadonlyArray<Claim> = [
  ['.ch-h', 'padding-top', '12px'],
  ['.ch-n', 'font-size', '26px'],
  ['.ch-n', 'line-height', '32px'],
  ['.ch-meta', 'margin-top', '8px'],
  ['.ch-status', 'margin', '4px 0 0'],
];

/** One claim against a sheet: every stated value has to be the expected one, and one has to exist. */
function claimProblems(css: string, [selector, property, value]: Claim): string[] {
  const stated = statedValues(css, selector, property);
  if (stated.length > 0 && stated.every((entry) => squash(entry) === squash(value))) return [];
  const found = stated.length === 0 ? 'nothing stated' : stated.join('; ');
  return [`${BOOK}: ${selector} { ${property}: ${found} } — expected ${value}`];
}

/** Every claim the sheet breaks, as `file: selector { property: value }` — empty when it holds. */
function headProblems(css: string): string[] {
  return CLAIMS.flatMap((claim) => claimProblems(css, claim));
}

describe('the chapter head reads as three steps (BOOK-128)', () => {
  it('sets the numeral, the data and the state on the 4 px grid', () => {
    expect(headProblems(book)).toEqual([]);
  });

  it('goes red on a replica of the old head — one glued block', () => {
    // The four declarations this change replaces: 10 px of air, the numeral's 26 px box with
    // no leading, no `.ch-meta` margin, `.ch-status` on 2 px.
    const before = `
      .ch-h { padding-top: 10px; }
      .ch-n { font-size: 26px; line-height: 1; }
      .ch-meta { display: block; }
      .ch-status { margin: 2px 0 0; }
    `;
    expect(headProblems(before)).toEqual([
      `${BOOK}: .ch-h { padding-top: 10px } — expected 12px`,
      `${BOOK}: .ch-n { line-height: 1 } — expected 32px`,
      `${BOOK}: .ch-meta { margin-top: nothing stated } — expected 8px`,
      `${BOOK}: .ch-status { margin: 2px 0 0 } — expected 4px 0 0`,
    ]);
  });

  it('reads every rule, not the first: a step re-stated in a media block is caught', () => {
    // First-match blindness would keep this sheet green: the base rule says 8 px, the phone
    // block says 0. Both values are named, so the failure says which widths disagree.
    const narrow = `
      .ch-meta { margin-top: 8px; }
      @media (max-width: 599px) { .ch-meta { margin-top: 0; } }
    `;
    expect(headProblems(narrow)).toContain(`${BOOK}: .ch-meta { margin-top: 8px; 0 } — expected 8px`);
  });
});
