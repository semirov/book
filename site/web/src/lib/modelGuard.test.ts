import { describe, expect, it } from 'vitest';

/**
 * BOOK-166 — two words a reader's surface may not print.
 *
 * **The model id** (owner, 2026-10-28): the page never names the writer. The wire still carries
 * `cost.model` and `stage.actor.model` — the workshop's own vocabulary — and `costLine` used to
 * print it on the change card and in the focus view. This guard reads every string literal in
 * `web/src` (tests excluded: a fixture may state the wire's value) and fails on a model id or a
 * provider path. Scoping to literals, not to the whole file, keeps a comment or a doc example
 * from being a finding while a rendered string cannot slip through.
 *
 * **The internal noun for a pass**: a reader's surface says «писалась» / «пишется», never the
 * noun the store and the hash use. The hash itself is built from `PASS_RECORD_PREFIX` in
 * `shared`, so no `web/src` literal needs the word — and this guard proves none prints it.
 */

const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** One quoted literal — single, double or template — with its escapes. */
const MODEL_ID = /deepseek|openai\/|\/v\d+-pro/iu;
/** `проход`, `прохода`, `проходов`… — the noun, never the verb «проходит проверку». */
const PASS_NOUN = /проход(?:а|ы|ов|у|ом|е)?(?![а-яё])/iu;

/**
 * Comments blanked, their length kept: a `//` inside a quoted string is text and a quote
 * inside a comment is not a delimiter. The walk is the same one `scripts/chips.mjs` uses.
 */
function withoutComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (quote !== null) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      if (index < source.length) out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      out += '  ';
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Every quoted literal in comment-free code. */
function literalsOf(source: string): string[] {
  const out: string[] = [];
  const text = withoutComments(source);
  for (let index = 0; index < text.length; index += 1) {
    const quote = text[index];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    let literal = quote;
    for (index += 1; index < text.length; index += 1) {
      const char = text[index]!;
      literal += char;
      if (char === '\\') {
        literal += text[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (char === quote) break;
    }
    out.push(literal);
  }
  return out;
}

describe('the reader’s surface never names the writer', () => {
  it('carries no model id or provider path in any string literal of web/src', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const literal of literalsOf(source)) {
        if (MODEL_ID.test(literal)) hits.push(`${file}: ${literal.slice(0, 80)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('never prints the internal noun for a pass in a string literal of web/src', () => {
    const hits: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const literal of literalsOf(source)) {
        if (PASS_NOUN.test(literal)) hits.push(`${file}: ${literal.slice(0, 80)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('would fail the guard: a literal that names the model or the noun is a hit', () => {
    // The failure path, proved on strings and not on the tree: a guard that cannot fail is
    // no guard. The verb «проходит» is not the noun and stays legal.
    expect(MODEL_ID.test(`'deepseek-flash'`)).toBe(true);
    expect(MODEL_ID.test('`openai/gpt`')).toBe(true);
    expect(MODEL_ID.test(`'/v4-pro'`)).toBe(true);
    expect(PASS_NOUN.test(`'проход был'`)).toBe(true);
    expect(PASS_NOUN.test(`'проход'`)).toBe(true);
    expect(PASS_NOUN.test(`'Не проходит проверку'`)).toBe(false);
  });
});
