#!/usr/bin/env node
/**
 * scripts/styles.mjs — the type floor and the adaptive regime (BOOK-DOC-35 §7, AC3/AC4/AC6).
 *
 * Rules over `web/src/styles/*.css`, checked without a build and without a browser:
 *
 *   1. the token ladder is closed and guarded where it is defined. Only the six `--fs-*` rungs
 *      exist, each must resolve to ≥12px, and a token that cannot be resolved (a `calc()` over
 *      an unknown variable, an `em` with no known parent) fails rather than passes silently.
 *      A removed rung may not come back under a new name: `--fs-nano` is a failure even when
 *      its value is 12px, because the ladder is the contract, not the number.
 *   2. no `font-size` literal below 12px, in px or rem (rem is resolved against the root size,
 *      which is measured from `html`/`:root`, default 16). `calc()` is evaluated when every
 *      operand is known; `clamp()` passes on its minimum; anything else must be listed as a
 *      documented exception (the design's own allowed list).
 *   3. the `font:` shorthand is read too: `font: 11px/1.4 …` sets the size without a
 *      `font-size` declaration and used to slip through.
 *   4. no `@media (min-width: …)`. The regime is adaptive: the base rules are the desktop
 *      layout and every query narrows. `min-width: 0` as a property is not a query.
 *
 * `styleProblems(dir)` is pure; `arch.mjs` prints it and the test seeds one violation of each
 * kind to prove the failure path.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The floor for every label, counter and meta line (BOOK-DOC-35 §4.1). */
export const MIN_FONT_PX = 12;

/** The ladder is the design's whole type scale: 12 / 13 / 14 / 15 → 18 / 19. */
export const LADDER = Object.freeze({
  '--fs-micro': 12,
  '--fs-label': 13,
  '--fs-meta': 14,
  '--fs-note': 15,
  '--fs-body': 18,
  '--fs-lead': 19,
});

/** Relative sizes that the design allows by name (BOOK-DOC-35 §4.3), not a general escape. */
const DOCUMENTED_RELATIVE = new Set(['0.86em']);

/** Absolute size keywords: a legal `font:` component that renders ≈9–11 px, never provable. */
const SIZE_KEYWORD = /\b(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller)\b/u;

/**
 * Every spelling of a `min-width` query: `(min-width: 600px)`, `screen and (min-width: …)`,
 * the range form `(width >= 600px)` and its mirror `(600px <= width)`. `max-width` queries and
 * the `min-width: 0` property are not queries and pass.
 */
const MIN_WIDTH_QUERY = /@media[^{]*?\(\s*(?:min-width\s*[:)]|width\s*>=\s*\d|\d[\d.]*\w*\s*<=\s*width)/u;
const TOKEN = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/gu;
const FS_TOKEN = /--fs-[a-z0-9-]+/u;
const FONT_SIZE = /font-size\s*:\s*([^;}]+)/gu;
const FONT_SHORTHAND = /(?:^|[\s;{])font\s*:\s*([^;}]+)/gu;
const ROOT_SIZE = /(?:^|[\s;{}])(?:html|:root)\s*\{[^}]*?font-size\s*:\s*([\d.]+)px/gu;

/** Comments blanked out with their length kept, so indices and line numbers do not move. */
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
}

/** The file a `--fs-*` rung may live in: the scale is defined once, in the tokens sheet. */
const TOKENS_FILE = 'tokens.css';

/** 1-based line of a byte index in `text`. */
function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === '\n') line += 1;
  return line;
}

/** `a px` arithmetic — `19px + 4px`, `2 * 12px`, `(12px)`. Returns null on any other unit. */
function evaluatePx(expression) {
  let cursor = 0;
  const source = expression.replace(/\s+/gu, '');

  function number() {
    const match = /^\d+(?:\.\d+)?(?:px)?/u.exec(source.slice(cursor));
    if (match === null) throw new Error('expected a px number');
    cursor += match[0].length;
    return Number.parseFloat(match[0]);
  }
  function atom() {
    if (source[cursor] === '(') {
      cursor += 1;
      const value = sum();
      if (source[cursor] !== ')') throw new Error('unbalanced');
      cursor += 1;
      return value;
    }
    return number();
  }
  function product() {
    let value = atom();
    while (source[cursor] === '*' || source[cursor] === '/') {
      const operator = source[cursor];
      cursor += 1;
      const right = atom();
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }
  function sum() {
    let value = product();
    while (source[cursor] === '+' || source[cursor] === '-') {
      const operator = source[cursor];
      cursor += 1;
      const right = product();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  try {
    const value = sum();
    return cursor === source.length ? value : null;
  } catch {
    return null;
  }
}

/** Resolve a CSS size to px, or null when it cannot be proven. */
function toPx(value, tokens, rootPx) {
  let text = value.trim().replace(/\s*!important$/u, '');
  const clamp = /^clamp\(\s*([^,]+),/u.exec(text);
  // `clamp()` can never go below its first argument: that is the number to prove.
  if (clamp !== null) text = clamp[1].trim();
  const calc = /^calc\((.*)\)$/su.exec(text);
  if (calc !== null) text = calc[1];

  for (let guard = 0; /var\(/u.test(text); guard += 1) {
    if (guard > 8) return null;
    let unresolved = false;
    text = text.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^()]*))?\)/gu, (_, name, fallback) => {
      const raw = tokens.get(name) ?? fallback;
      if (raw === undefined) unresolved = true;
      return raw ?? 'unknown';
    });
    if (unresolved) return null;
  }

  // `em`, `%` and `ch` depend on a parent the sheet does not prove; `rem` depends on the root.
  if (/(?:^|[^\d.])\d+(?:\.\d+)?(?:em|ch|%)/u.test(text)) return null;
  text = text.replace(/(\d+(?:\.\d+)?)rem/gu, (_, n) => `${Number(n) * rootPx}px`);
  return evaluatePx(text);
}

/**
 * @param {string} stylesDir the directory holding `tokens.css`, `base.css`, …
 * @returns {Array<{ file: string; line: number; message: string }>}
 */
export function styleProblems(stylesDir) {
  /** @type {Array<{ file: string; line: number; message: string }>} */
  const problems = [];
  const names = readdirSync(stylesDir)
    .filter((name) => name.endsWith('.css'))
    .sort();
  // Comments are blanked before anything is scanned: a commented-out rule is not a rule, and
  // its length is kept so the reported line still points at the sheet.
  const files = names.map((name) => ({ name, path: join(stylesDir, name), css: withoutComments(readFileSync(join(stylesDir, name), 'utf8')) }));

  /** The root size every `rem` resolves against. */
  let rootPx = 16;
  for (const { css } of files) {
    for (const match of css.matchAll(ROOT_SIZE)) {
      const size = Number(match[1]);
      if (Number.isFinite(size) && size > 0) rootPx = size;
    }
  }

  /**
   * Every custom property in the sheet set, not only `--fs-*`: `--type-micro: 9px` used as
   * `font-size: var(--type-micro, 12px)` renders 9 px, and the fallback never applies.
   */
  const tokens = new Map();
  for (const { css } of files) {
    for (const match of css.matchAll(TOKEN)) tokens.set(match[1], match[2]);
  }

  const report = (file, css, index, message) => problems.push({ file, line: lineAt(css, index), message });

  for (const { name, path, css } of files) {
    for (const match of css.matchAll(TOKEN)) {
      const index = match.index ?? 0;
      const [raw, token, value] = match;
      if (!FS_TOKEN.test(token)) continue;
      if (name !== TOKENS_FILE) {
        report(path, css, index, `${token} is declared outside ${TOKENS_FILE} — the ladder has one home`);
        continue;
      }
      if (!(token in LADDER)) {
        report(path, css, index, `${token} is not on the type ladder — a removed rung may not return`);
        continue;
      }
      const px = toPx(value, tokens, rootPx);
      if (px === null) report(path, css, index, `${token}: ${value.trim()} cannot be proven ≥${MIN_FONT_PX}px`);
      else if (px < MIN_FONT_PX) report(path, css, index, `${token} resolves to ${px}px, below the ${MIN_FONT_PX}px floor`);
    }

    for (const [pattern, kind] of [
      [FONT_SIZE, 'font-size'],
      [FONT_SHORTHAND, 'font'],
    ]) {
      for (const match of css.matchAll(pattern)) {
        const index = match.index ?? 0;
        const raw = match[1].trim();
        // The shorthand carries its size as the component with a unit; `font: inherit` has none.
        const numeric = /(\d*\.?\d+(?:px|rem|em|%))(?:\s*\/\s*[\d.]+\w*)?/u.exec(raw)?.[1];
        const keyword = SIZE_KEYWORD.exec(raw)?.[0];
        // A `font-size` value is the whole declaration; a shorthand's size is one component.
        const size = kind === 'font-size' ? raw : (numeric ?? keyword);
        if (size === undefined) continue;
        if (DOCUMENTED_RELATIVE.has(size)) continue;
        const px = toPx(size, tokens, rootPx);
        if (px === null) report(path, css, index, `${kind}: ${size} cannot be proven ≥${MIN_FONT_PX}px`);
        else if (px < MIN_FONT_PX) report(path, css, index, `${kind}: ${size} is ${px}px, below the ${MIN_FONT_PX}px floor`);
      }
    }

    const query = MIN_WIDTH_QUERY.exec(css);
    if (query !== null) {
      report(path, css, query.index, '@media min-width query — the base is the desktop; narrow with max-width (BOOK-DOC-35 §3)');
    }
  }

  // Files are already sorted; within a file, read the sheet top to bottom.
  return problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
