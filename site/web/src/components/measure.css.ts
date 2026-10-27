/**
 * BOOK-88 — the text side of the guard behind `measure.test.ts`.
 *
 * Every stylesheet is read as text (`?raw`) and walked here into declaration blocks: the
 * selector list, the at-rules that enclose it, and the declarations themselves. This file
 * knows CSS shape and the two token paths; the policy — which width, margin or padding is
 * legal — lives in `measure.rules.ts` / `measure.tokens.ts`, and the globbed files in
 * `measure.guard.ts`.
 */

export type SheetSet = Record<string, string>;

/** The root size a `rem` resolves against (`html` declares no `font-size`). */
export const GAUGE = 16;

export const squash = (value: string): string => value.replace(/\s+/gu, '');

/** Comments blanked with their length kept: a commented-out rule is not a rule. */
export const blankComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));

export type Rule = {
  file: string;
  selector: string;
  parts: string[];
  /** The enclosing at-rules, as written (`['@media (max-width: 1023px)']`). */
  at: string[];
  declarations: Map<string, string>;
};

export const TOKENS = '../styles/tokens.css';
export const BASE = '../styles/base.css';

/** A listing for a message: `file: selector { property: value }`. */
export const where = (rule: Rule, property: string, value: string): string =>
  `${rule.file}: ${rule.selector} { ${property}: ${value} }`;

/** A rule whose selector is exactly one selector — no list, no compound, no descendant. */
export const exactly = (rule: Rule, selector: string): boolean =>
  rule.parts.length === 1 && squash(rule.parts[0] ?? '') === squash(selector);

/** Every value a rule states for one property or token, with the rule it came from. */
export function stating(rules: Rule[], name: string): Array<{ rule: Rule; value: string }> {
  return rules.flatMap((rule) => {
    const value = rule.declarations.get(name);
    return value === undefined ? [] : [{ rule, value }];
  });
}

/** `--x: y` pairs of one rule body, last declaration of a property winning. */
function declarationsOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const property = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim().replace(/\s*!important$/u, '');
    if (property !== '' && value !== '') out.set(property, value);
  }
  return out;
}

/**
 * Every declaration block of a sheet, with the selector list it belongs to and the at-rules that
 * enclose it. Braces are walked rather than matched, so a rule inside `@media { … }` is read as
 * a rule instead of being lost to the nesting.
 */
export function rulesOf(file: string, css: string): Rule[] {
  const rules: Rule[] = [];
  const open: Array<{ selector: string; from: number }> = [];
  let cursor = 0;
  for (let at = 0; at < css.length; at += 1) {
    const char = css[at];
    if (char !== '{' && char !== '}') continue;
    if (char === '{') {
      open.push({ selector: css.slice(cursor, at).trim(), from: at + 1 });
    } else {
      const block = open.pop();
      if (block !== undefined) {
        const body = css.slice(block.from, at);
        // A body that still holds a brace is an at-rule's wrapper, not a declaration block.
        if (!/[{}]/u.test(body)) {
          rules.push({
            file,
            selector: block.selector,
            parts: block.selector
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part !== ''),
            at: open.filter((entry) => entry.selector.startsWith('@')).map((entry) => entry.selector),
            declarations: declarationsOf(body),
          });
        }
      }
    }
    cursor = at + 1;
  }
  return rules;
}

/** Where a selector part's subject compound starts (the last combinator). */
export function subjectStart(part: string): number {
  let depth = 0;
  let cut = 0;
  for (let at = 0; at < part.length; at += 1) {
    const char = part[at];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~')) cut = at + 1;
  }
  return cut;
}

/** The class names of a selector part's subject compound — what the part actually styles. */
export function subjectClasses(part: string): string[] {
  return [...part.slice(subjectStart(part)).matchAll(/\.([a-z0-9-]+)/giu)].map((match) => match[1] ?? '');
}

/** The class names of everything a selector part descends from. */
export function ancestorClasses(part: string): string[] {
  return [...part.slice(0, subjectStart(part)).matchAll(/\.([a-z0-9-]+)/giu)].map((match) => match[1] ?? '');
}

/**
 * The class tokens of every string `className` in a component, one token list per attribute:
 * a register must carry `page` in the same class string as its own register class.
 */
export function classTokensPerAttribute(source: string): string[][] {
  const out: string[][] = [];
  const attribute = /className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\})/gu;
  for (const match of source.matchAll(attribute)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    out.push(value.split(/[^\w-]+/u).filter((token) => token !== ''));
  }
  return out;
}

/** A declaration value split on the whitespace that is not inside parentheses. */
export function topLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (depth === 0 && /\s/u.test(char)) {
      if (current !== '') out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') out.push(current);
  return out;
}
