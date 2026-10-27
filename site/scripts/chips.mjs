#!/usr/bin/env node
/**
 * scripts/chips.mjs — the chip-copy guard (BOOK-70, the editor's truth table).
 *
 * A chip states one provable fact, in the present tense, with its noun — or it does not exist.
 * The words below are the ones the audit removed, and they are removed for a reason each:
 *
 *   - «книга начинается» — a mood about a book, not a count of chapters with text;
 *   - «записи нет»  — an answer about the whole book drawn from one missing timestamp;
 *   - «тишина с …»  — silence is not a fact the files can prove;
 *   - «0 замечаний» / «0 правок» — a chip never counts nothing (the zero states are sentences);
 *   - «дальше держится» — a claim the cascade data does not make (the state word says it once);
 *   - «состояние:» — a second print of a state, in a third voice;
 *   - «волна 0» / «волна 1» — one wave is the whole ripple; a bounded wave is noise;
 *   - «'не написана'» — a placeholder for a chapter that has no text yet. Two entries guard it:
 *     the quoted literal (the copy branch) and the bare text (a JSX text node, «<span>не
 *     написана</span>»). The bare pattern carries a negative lookbehind for «ещё », so the legit
 *     «'ещё не написана'» in `Chronicle.tsx` — a chapter not yet written, in the chronicle's own
 *     sentence — is not a hit; the quote lookbehind keeps the two entries from both firing on
 *     one quoted literal.
 *
 * The scan is over `web/src/**\/*.{ts,tsx}`, tests excluded, comments blanked: a comment may
 * quote a removed string, a component may not print it. Pure and sync, so `arch.mjs` prints it
 * and the test seeds a file to prove the failure path.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every phrase the editor's table removed, with the reason it may not come back. */
export const FORBIDDEN = Object.freeze([
  { phrase: 'книга начинается', why: 'a mood about the book — the zero state is «глав ещё нет»' },
  { phrase: 'записи нет', why: 'one missing timestamp is not a fact about the book' },
  { phrase: 'тишина с', why: 'silence is not provable — the chip states the last entry’s day' },
  { phrase: '0 замечаний', why: 'a chip never counts nothing — «замечаний нет» is the sentence' },
  { phrase: '0 правок', why: 'a chip never counts nothing — «в очереди пусто» is the sentence' },
  { phrase: 'дальше держится', why: 'the cascade does not say the far wing holds; the state word says it once' },
  { phrase: 'состояние:', why: 'a state is printed once, in the chip’s own voice' },
  { phrase: 'волна 0', why: 'a wave below two is not news — a bounded wave is noise' },
  { phrase: 'волна 1', why: 'one wave is the whole ripple — «волна 1» says nothing' },
  { phrase: "'не написана'", why: 'a placeholder for a chapter with no text — absence renders nothing' },
  {
    phrase: 'не написана',
    // Bare text (a JSX text node), never «ещё не написана» and never the quoted literal that the
    // entry above already reports.
    pattern: /(?<!ещё )(?<!['"`])не написана/gu,
    why: 'a placeholder for a chapter with no text — absence renders nothing, and a bare text node is still copy',
  },
]);

/** 1-based line of a byte index in `text`. */
function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === '\n') line += 1;
  return line;
}

/**
 * The phrase as a pattern. A phrase that starts or ends with a digit carries a boundary on that
 * side, so «0 замечаний» is not found inside the site's own «10 замечаний в час»: the rule is
 * about a zero, not about every number that ends in one.
 */
function phrasePattern(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const lead = /^\d/u.test(phrase) ? '(?<!\\d)' : '';
  const tail = /\d$/u.test(phrase) ? '(?!\\d)' : '';
  return new RegExp(`${lead}${escaped}${tail}`, 'gu');
}

/**
 * Blank out `//` and block comments with their length kept, so a line number still points at
 * the file. Quotes and template literals are tracked, so `https://…` inside a string is text.
 */
function withoutComments(source) {
  let out = '';
  let cursor = 0;
  let quote = null;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (quote !== null) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        cursor += 2;
        continue;
      }
      if (char === quote) quote = null;
      cursor += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      cursor += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (cursor < source.length && source[cursor] !== '\n') {
        out += ' ';
        cursor += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) {
        out += source[cursor] === '\n' ? '\n' : ' ';
        cursor += 1;
      }
      out += '  ';
      cursor += 2;
      continue;
    }
    out += char;
    cursor += 1;
  }
  return out;
}

/** Every `.ts`/`.tsx` under `dir` that ships copy: the tests are not reader-facing. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sources(path, out);
      continue;
    }
    if (!/\.(ts|tsx)$/u.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/u.test(entry.name) || /\.dom\.test\.(ts|tsx)$/u.test(entry.name)) continue;
    out.push(path);
  }
  return out.sort();
}

/**
 * @param {string} webSrcDir the SPA's source directory (`web/src`)
 * @returns {Array<{ file: string; line: number; message: string }>}
 */
export function copyProblems(webSrcDir) {
  /** @type {Array<{ file: string; line: number; message: string }>} */
  const problems = [];
  for (const file of sources(webSrcDir)) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    for (const { phrase, why, pattern } of FORBIDDEN) {
      for (const match of source.matchAll(pattern ?? phrasePattern(phrase))) {
        problems.push({
          file,
          line: lineAt(source, match.index ?? 0),
          message: `«${phrase}» is retired (BOOK-70): ${why}`,
        });
      }
    }
  }
  return problems.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}
