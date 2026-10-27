/**
 * scripts/css.mjs — reading a stylesheet without a browser (BOOK-DOC-35, BOOK-70).
 *
 * The pure half of `styles.mjs`: every helper here takes text and returns data, so the type
 * floor, the adaptive regime and the chip registry can share one reading of a sheet instead of
 * each parsing CSS its own way. Nothing here knows about problems or files — the gates do.
 *
 * Split out of `styles.mjs` when the two guards met (BOOK-66's skeleton rules and BOOK-70's
 * chip registry) and the file passed the 500-line limit: the limit is the boundary between
 * *reading* a sheet and *judging* it.
 */

/** 1-based line of a byte index in `text`. */
export function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === '\n') line += 1;
  return line;
}

/** Comments blanked out with their length kept, so indices and line numbers do not move. */
export function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
}

/** Every rule body in a sheet, with the selector list it belongs to and its line. */
export function ruleBodies(css) {
  /** @type {Array<{ selectors: string[]; body: string; line: number }>} */
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = (match[1] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '' && !part.startsWith('@'));
    if (selectors.length === 0) continue;
    rules.push({ selectors, body: match[2] ?? '', line: lineAt(css, match.index ?? 0) });
  }
  return rules;
}

/**
 * The subject compound of a selector-list part: what the part actually styles. `.live.idle .dot`
 * styles the dot, so a declaration there is not the chip's own; `:is(.live, …)` styles the
 * element the pseudo carries. Combinators inside `:not(…)` / `[data-x="a b"]` are not cut.
 */
export function subjectOf(part) {
  let depth = 0;
  let cut = 0;
  for (let at = 0; at < part.length; at += 1) {
    const char = part[at];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~')) cut = at + 1;
  }
  return part.slice(cut).trim();
}

/**
 * Does this selector-list part style the element the registered selector names? True for the
 * exact selector, for a compound built on it (`.live.idle`, `.live:hover`, `.live[data-x]`,
 * `.live:not(.brand)`) and for a functional pseudo that carries it (`:is(.live, …)`); false for
 * a longer class name (`.livewire`) and for anything whose subject is another element
 * (`.live .dot`, `.live.idle .dot`) — a rule for a child is not a rule about the chip.
 */
export function reaches(part, registered) {
  const subject = subjectOf(part);
  let from = subject.indexOf(registered);
  while (from >= 0) {
    const after = from + registered.length;
    let at = after;
    const spaced = subject[at] === ' ';
    while (subject[at] === ' ') at += 1;
    const next = subject[at] ?? '';
    // `:where( .live )` — the space is inside the pseudo, not a combinator.
    if (next === ')') return true;
    if (!spaced) {
      if (next === '') return true;
      // `.livewire` is a different class; `.live > .x` styles another element.
      if (!/[A-Za-z0-9_-]/u.test(next) && next !== '>' && next !== '+' && next !== '~') return true;
    }
    from = subject.indexOf(registered, after);
  }
  return false;
}

/** `font-size: var(--fs-micro);` → `{ 'font-size': 'var(--fs-micro)' }` for one rule body. */
export function declarationsOf(body) {
  const out = new Map();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const property = part.slice(0, at).trim().toLowerCase();
    const value = part
      .slice(at + 1)
      .trim()
      .replace(/\s*!important$/u, '');
    if (property !== '' && value !== '') out.set(property, value);
  }
  return out;
}

/** `a px` arithmetic — `19px + 4px`, `2 * 12px`, `(12px)`. Returns null on any other unit. */
export function evaluatePx(expression) {
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
export function toPx(value, tokens, rootPx) {
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
