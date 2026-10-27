import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The stylesheets the browser actually loads, in cascade order, derived from the module that
 * boots (`web/src/main.tsx`) and not from a hand-kept list: a guard over a list can pass while
 * a sheet that loads later re-grids the page (BOOK-73, BOOK-92).
 *
 * Shared by the build guards that must read the cascade rather than one sheet — a rule can
 * arrive from any sheet that loads after `chrome.css` without a line changing in it.
 *
 * `Object.keys(sheets)` is the boot order, and every parsed rule carries its `order`, so "the
 * last declaration wins" and "this selector is declared once" are both expressible.
 */

const WEB = join(import.meta.dirname, '..', '..', 'web');

const main = readFileSync(join(WEB, 'src', 'main.tsx'), 'utf8');

/** Every `import './styles/<name>.css';` of the boot module, in cascade order. */
export const sheetNames: string[] = [
  ...main.matchAll(/import\s+['"]\.\/styles\/([a-z0-9-]+)\.css['"];/gu),
].map((match) => match[1] ?? '');

// Loudly, not silently: an empty list would make every assertion of every guard vacuous.
if (sheetNames.length === 0) throw new Error('no stylesheet imports found in web/src/main.tsx');

/** The sheets' text, keyed in boot order. */
export const sheets: Record<string, string> = Object.fromEntries(
  sheetNames.map((name) => [name, readFileSync(join(WEB, 'src', 'styles', `${name}.css`), 'utf8')]),
);

/** One parsed rule: its sheet, its place in the cascade, its selectors and its declarations. */
export interface ParsedRule {
  sheet: string;
  /** Where the rule sits in boot order — the browser renders the highest one. */
  order: number;
  parts: string[];
  declarations: Record<string, string>;
  /** The body as written, for a scan that has to look at the text (an `!important` tag). */
  body: string;
}

/** `prop: value; prop: value` → `{ prop: value }`, whitespace squeezed; the last one wins. */
export function parse(body: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const chunk of body.split(';')) {
    const colon = chunk.indexOf(':');
    if (colon < 0) continue;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).replace(/\s+/gu, ' ').trim();
    if (property !== '' && value !== '') found[property] = value;
  }
  return found;
}

/**
 * Every rule of the cascade in boot order: comments blanked first (a commented rule is not a
 * rule), the selector list split so a grouped rule is judged by each subject, declarations
 * parsed into property → value.
 *
 * Media wrappers are **not** modelled: the reader skips the `@media …` prelude and reads the
 * rule inside as unconditional, its condition dropped. A guard over a rule that only applies in
 * a query has to record the condition first; no guarded rule lives in a query today.
 */
export function cascadeRules(source: Record<string, string> = sheets): ParsedRule[] {
  const found: ParsedRule[] = [];
  for (const [sheet, text] of Object.entries(source)) {
    const liveText = text.replace(/\/\*[\s\S]*?\*\//gu, ' ');
    for (const match of liveText.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const body = match[2] ?? '';
      const parts = (match[1] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      found.push({ sheet, order: found.length, parts, declarations: parse(body), body });
    }
  }
  return found;
}

/** Every rule that declares `selector` as one of its subjects, in boot order. */
export function definitions(
  selector: string,
  source: Record<string, string> = sheets,
): ParsedRule[] {
  return cascadeRules(source).filter((rule) => rule.parts.includes(selector));
}

/** The declaration the browser renders: the last rule of that selector in boot order. */
export function winning(selector: string, source: Record<string, string> = sheets): ParsedRule {
  const found = definitions(selector, source);
  if (found.length === 0) throw new Error(`no rule declares ${selector}`);
  return found.reduce((last, rule) => (rule.order > last.order ? rule : last));
}

/**
 * A margin as four sides, so `0 0 8px`, `0 0 8px 0` and a longhand block are one geometry.
 * A longhand, when written, is taken as the value; the order inside a block is not modelled.
 */
export function sides(rule: ParsedRule, property = 'margin'): string[] {
  const [top = '', right = top, bottom = top, left = right] = (rule.declarations[property] ?? '')
    .split(' ')
    .filter(Boolean);
  const longhand = (side: string): string | undefined => rule.declarations[`${property}-${side}`];
  return [
    longhand('top') ?? top,
    longhand('right') ?? right,
    longhand('bottom') ?? bottom,
    longhand('left') ?? left,
  ];
}
