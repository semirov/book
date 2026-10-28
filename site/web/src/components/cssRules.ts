/**
 * Reading the stylesheets as text, for the tests that claim a rule rather than pixels. The
 * sheets themselves are globbed per test file (`?raw`); the parsing lives here so the helper
 * stops meaning two things under one name.
 *
 * Two readings of a selector, and the difference is the point:
 *   - `firstDeclarations` answers the first rule of an exact selector — the way
 *     `bookMatter.test.tsx` reads the measure, where the second rule (if any) is not the claim;
 *   - `unionDeclarations` answers every rule that names the selector, alone or in a list
 *     (`.colophon .row, .colophon a`), because `chrome.css` dresses `.colophon a` in two
 *     consecutive blocks (the underline, then the 24 px target).
 *
 * The `@media` reader answers with *every* block of a query (`mediaBlocks`) or with all blocks
 * of a sheet (`mediaBlockList`): a sheet may write the same query twice — `book.css` writes
 * `(max-width: 599px)` twice — and a reader that returns the first block makes a scan of the
 * second one vacuous.
 */

const COMMENT = /\/\*[\s\S]*?\*\//gu;
const MEDIA_OPEN = /@media\s*\(([^)]*)\)\s*\{/gu;
const RULE = /([^{}]+)\{([^{}]*)\}/gu;

/** The sheet without its comments: a commented-out rule is not a rule. */
function strip(css: string): string {
  return css.replace(COMMENT, '');
}

function escapeSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Every rule of a sheet as `[selector, declarations]`, nested (`@media`) rules included. */
export function rules(css: string): Array<[string, string]> {
  return [...strip(css).matchAll(RULE)].map((match) => [
    (match[1] ?? '').replace(/\s+/gu, ' ').trim(),
    match[2] ?? '',
  ]);
}

/** Whether the sheet names the selector at all — alone or in a selector list, because
 *  `.a, .b { … }` does state `.b`. The loud check before a negative claim. */
export function hasRule(css: string, selector: string): boolean {
  const wanted = selector.replace(/\s+/gu, ' ').trim();
  return rules(css).some(([list]) => selectorTokens(list).includes(wanted));
}

/** The declarations of the first rule whose selector is exactly `selector`, or `''` when the
 *  sheet has none — the caller asserts on it, so an absent selector fails there, not here. */
export function firstDeclarations(css: string, selector: string): string {
  const escaped = escapeSelector(selector);
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(strip(css))?.[1] ?? '';
}

/** The selector list of a rule as its tokens: `.a, .b:hover` → [`.a`, `.b:hover`]. */
function selectorTokens(selector: string): string[] {
  return selector
    .split(',')
    .map((token) => token.replace(/\s+/gu, ' ').trim())
    .filter((token) => token.length > 0);
}

/**
 * The declarations of *every* rule whose selector list carries `selector` as one of its tokens,
 * joined with `;` — the selector alone, or in a list beside others (`.colophon .row, .colophon a`
 * is one rule and two selectors). `''` when no rule names it, which is a fact about the sheet,
 * not an error: a negative claim over a block is made of exactly that.
 */
export function unionDeclarations(css: string, selector: string): string {
  const wanted = selector.replace(/\s+/gu, ' ').trim();
  return rules(css)
    .filter(([list]) => selectorTokens(list).includes(wanted))
    .map(([, body]) => body)
    .join(';');
}

/** The body of the block that opens at `open`, with its braces balanced. */
function blockBody(css: string, open: number): string {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`the sheet has an unclosed @media block at ${open}`);
}

/** Every `@media (<query>)` block of a sheet, in the order written — all of them, not the first. */
export function mediaBlockList(css: string): Array<{ query: string; body: string }> {
  const text = strip(css);
  return [...text.matchAll(MEDIA_OPEN)].map((match) => ({
    query: (match[1] ?? '').replace(/\s+/gu, ' ').trim(),
    body: blockBody(text, (match.index ?? 0) + match[0].length - 1),
  }));
}

/**
 * The body of every `@media (<query>)` block of a sheet. Throws when the sheet carries no such
 * block: a reader that returned `''` there would let a scan of that query pass on nothing.
 */
export function mediaBlocks(css: string, query: string): string[] {
  const wanted = query.replace(/\s+/gu, ' ').trim();
  const bodies = mediaBlockList(css)
    .filter((block) => block.query === wanted)
    .map((block) => block.body);
  if (bodies.length === 0) throw new Error(`the sheet has no @media (${wanted}) block`);
  return bodies;
}
