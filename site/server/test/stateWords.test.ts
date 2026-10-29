import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { READING_LADDER, reviseLine } from '@book/shared';
import { describe, expect, it } from 'vitest';

/**
 * The state-word guard (BOOK-218, BOOK-DOC-82).
 *
 * A reader is shown what happened to **their** edit, in the book's nouns: never a queue, a lane,
 * a pass, a triage, a verdict or a gate. The words themselves live in `shared/src/stateWords.ts`
 * and in the copy modules beside it; this half walks the reader-facing sources and extracts
 * **every place a sentence can be written**:
 *
 *   · string and template literals (a comment may name the machine — the code may not);
 *   · literals nested inside a `${ … }` interpolation, which used to be skipped whole;
 *   · JSX text children — the runs between `>` and `<` — because a sentence typed straight into
 *     the markup is copy as much as a literal is (`LegalPage`'s terms were the blind spot).
 *
 * Reading source files is allowed in `server/test` (see `copy.test.ts`); the rendered half is
 * `web/src/components/copyGuard.test.tsx`.
 */

const ROOT = join(import.meta.dirname, '../..');

/**
 * The reader-copy modules outside `web/src`, where a state word may also be spelled. A trailing
 * slash is a directory: every non-test source inside it is walked (`server/src/history/` prints
 * the chronicle's lines, and that surface is reader-facing too).
 */
const COPY_MODULES = [
  'shared/src/stateWords.ts',
  'shared/src/naming.ts',
  'shared/src/change.ts',
  'shared/src/disposition.ts',
  'shared/src/terms.ts',
  'server/src/writer/reasons.ts',
  'server/src/comments/service.ts',
  'server/src/push/passEvent.ts',
  'server/src/history/',
];

/**
 * The machinery's stems: a reader's sentence may not carry one (BOOK-218). `модель` is its own
 * matcher below — the noun has cases, and the ordinary verb «смоделировать» must stay readable.
 */
const STEMS = ['очеред', 'лейн', 'пасс', 'триаж', 'вердикт', 'гейт', 'итераци', 'ревизи', 'сокет', 'печатник'] as const;

/**
 * BOOK-218 — a reader may never read a state that asks a person to decide, or a sentence about
 * the machinery's own check. The words are the vocabulary's, not a surface's, so they are banned
 * wherever a sentence can be written.
 */
const BANNED_PHRASES = ['нужно решение', 'шаг не закрылся', 'проверка не ответила'] as const;

/**
 * `модель` as the noun, in its own cases — and never inside a longer word: a sentence about a
 * thing being modelled is not a sentence about the machine.
 */
const MODEL_NOUN = /(?<!\p{L})модел(?:ь|и|ью|ей|ям|ями|ях)(?!\p{L})/u;

/** `LLM` is the machine by its English name, and a sentence carrying one is not the book's. */
const LLM = /(?:^|[^a-z0-9_])llm(?:[^a-z0-9_]|$)/iu;

/**
 * The pass noun in **its own forms**, never the ordinary verb: `проход`, `прохода`, `проходу`,
 * `проходом`, `проходе`, `проходов`, `проходы` — and not «проходит», which is a sentence about
 * a thing happening. A bare stem would refuse the verb and pass the noun it was written for.
 */
const PASS_NOUN = /проход(?:а|у|ом|е|ов|ы)?(?!\p{L})/u;

/** The machine's own words: never inside a sentence a reader can see. */
const WORDS = ['processing', 'accepted', 'change'] as const;

/**
 * Exact exemptions, `{ file, string }` pairs. Empty on purpose: a word that is genuinely the
 * book's is added here with the whole string that carries it, never as a file-wide pass.
 */
const ALLOWED: ReadonlyArray<{ file: string; string: string }> = [];

/** A quoted run, with its closing quote's index; an unterminated one stops at the line. */
function readQuoted(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let index = start + 1;
  let value = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      value += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    if (char === '\n') return { value, end: index };
    value += char;
    index += 1;
  }
  return { value, end: source.length };
}

/** The index after a `${ … }` interpolation, and the code inside it. */
function readInterpolation(source: string, start: number): { end: number; inner: string } {
  let index = start;
  let depth = 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return { end: index + 1, inner: source.slice(start, index) };
    }
    if (char === "'" || char === '"') {
      index = readQuoted(source, index).end;
      continue;
    }
    if (char === '`') {
      index = readTemplate(source, index, []).end;
      continue;
    }
    index += 1;
  }
  return { end: source.length, inner: source.slice(start) };
}

/** A template literal, its `${ … }` code scanned as code (a nested literal is copy too). */
function readTemplate(source: string, start: number, out: string[]): { value: string; end: number } {
  let index = start + 1;
  let value = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      value += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === '`') return { value, end: index + 1 };
    if (char === '$' && source[index + 1] === '{') {
      const run = readInterpolation(source, index + 2);
      // BOOK-218 — a literal written inside the interpolation is still a sentence.
      out.push(...literalsOf(run.inner));
      index = run.end;
      continue;
    }
    value += char;
    index += 1;
  }
  return { value, end: source.length };
}

/** Every string literal in a source file: comments are not copy, `${ … }` code is scanned. */
export function literalsOf(source: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const at = source.indexOf('\n', index);
      index = at < 0 ? source.length : at + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const at = source.indexOf('*/', index + 2);
      index = at < 0 ? source.length : at + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const run = readQuoted(source, index);
      out.push(run.value);
      index = run.end;
      continue;
    }
    if (char === '`') {
      const run = readTemplate(source, index, out);
      out.push(run.value);
      index = run.end;
      continue;
    }
    index += 1;
  }
  return out;
}

/** Comments blanked, so a `>` in prose about the markup is not a text child. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/gu, '$1');
}

/**
 * JSX text children: the runs between `>` and `<` that carry Cyrillic. A run that carries code
 * punctuation (`;`, `=`, `=>`, `&&`, `||`) is not a sentence — it is an expression that happened
 * to sit between two angle brackets.
 */
export function jsxTextOf(source: string): string[] {
  const out: string[] = [];
  for (const match of withoutComments(source).matchAll(/>([^<>]*)</gu)) {
    const text = (match[1] ?? '').replace(/\s+/gu, ' ').trim();
    if (text.length === 0 || !/\p{Script=Cyrillic}/u.test(text)) continue;
    if (/=>|&&|\|\||;|=/u.test(text)) continue;
    out.push(text);
  }
  return out;
}

/** Every sentence a file can print: its literals and its JSX text children. */
function copyOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const out = literalsOf(source);
  if (/\.tsx$/u.test(file)) out.push(...jsxTextOf(source));
  return out;
}

/** The non-test TypeScript sources a reader can be shown, as absolute paths. */
function surfaces(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/u.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/u.test(entry.name)) continue;
      out.push(join(entry.parentPath ?? dir, entry.name));
    }
  };
  walk(join(ROOT, 'web/src'));
  for (const module of COPY_MODULES) {
    const path = join(ROOT, module);
    if (module.endsWith('/')) walk(path);
    else out.push(path);
  }
  return out;
}

/**
 * The hit a sentence owes: its stem or its machine word, `null` when it is clean. Only a
 * sentence that carries Cyrillic is reader copy — an English key or a class name is not.
 */
function offence(text: string): string | null {
  if (LLM.test(text)) return 'LLM';
  if (!/\p{Script=Cyrillic}/u.test(text)) return null;
  if (MODEL_NOUN.test(text)) return 'модель';
  const lower = text.toLowerCase();
  for (const stem of STEMS) if (lower.includes(stem)) return stem;
  for (const phrase of BANNED_PHRASES) if (lower.includes(phrase)) return phrase;
  if (PASS_NOUN.test(text)) return 'проход';
  for (const word of WORDS) {
    if (new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`, 'iu').test(text)) return word;
  }
  return null;
}

const FILES = surfaces();
const ROWS = FILES.flatMap((file) =>
  copyOf(file)
    .filter((text) => /\p{Script=Cyrillic}/u.test(text))
    .map((text) => ({ file: relative(ROOT, file), text })),
);

describe('the reader’s state words', () => {
  it('walks the surfaces, and the walk is not vacuous', () => {
    // A floor on both halves: a broken walk must fail here, not pass by finding nothing.
    expect(FILES.length).toBeGreaterThan(150);
    expect(ROWS.length).toBeGreaterThan(500);
    const walked = FILES.map((file) => relative(ROOT, file));
    for (const module of COPY_MODULES) {
      if (module.endsWith('/')) {
        expect(walked.some((file) => file.startsWith(module)), module).toBe(true);
      } else {
        expect(walked, module).toContain(module);
      }
    }
  });

  it('spells no machinery noun and no machine word in a reader’s sentence', () => {
    const violations = ROWS.filter((row) => offence(row.text) !== null).map(
      (row) => `${row.file}: ${offence(row.text) ?? ''} in ${JSON.stringify(row.text)}`,
    );
    expect(violations).toEqual([]);
  });

  it('keeps its allow-list exact, and each entry earns its place', () => {
    for (const entry of ALLOWED) {
      const file = join(ROOT, entry.file);
      expect(FILES, entry.file).toContain(file);
      expect(copyOf(file), entry.file).toContain(entry.string);
    }
    // An allow-list entry is a whole literal, never a file-wide pass.
    expect(new Set(ALLOWED.map((entry) => entry.file)).size).toBe(ALLOWED.length);
    expect(ALLOWED).toEqual([]);
  });

  it('names the machine, the reading and the receipt in no sentence of the book', () => {
    // BOOK-218 — the second banned set: the machine's own nouns, and the old receipt's word.
    expect(offence('это ответ LLM')).toBe('LLM');
    expect(offence('модель ответила не по форме')).toBe('модель');
    expect(offence('ответ модели оборвался')).toBe('модель');
    expect(offence('спросили у модели')).toBe('модель');
    expect(offence('сделан триаж заявки')).toBe('триаж');
    expect(offence('вердикт не пришёл')).toBe('вердикт');
    expect(offence('гейт не ответил')).toBe('гейт');
    expect(offence('третья итерация')).toBe('итераци');
    expect(offence('внесено · глава 7 · ревизия 4')).toBe('ревизи');
    expect(offence('сокет закрылся')).toBe('сокет');
    expect(offence('правка в лейне')).toBe('лейн');
    expect(offence('правка в очереди')).toBe('очеред');
    // BOOK-218 part 3: the hand is `машина`, and no sentence asks a person to decide.
    expect(offence('печатник внесла правку')).toBe('печатник');
    expect(offence('шаг не закрылся — нужно решение')).toBe('нужно решение');
    expect(offence('проверка не ответила — текст возвращён')).toBe('проверка не ответила');
    // The ordinary word is not the noun: the book still tells a story about modelling.
    expect(offence('он смоделировал сцену')).toBeNull();
    expect(offence('моделирование продолжалось')).toBeNull();
    // …and the receipts now say the edition in words.
    expect(offence('внесено в главу 1. это третья редакция')).toBeNull();
  });

  it('keeps the ladder in one place, and no surface prints it yet', () => {
    // The owner's reading ladder — attempts two to five, the rule-only last one, the refusal
    // after six — has no engine behind it. It lives as named constants so it lands in one place
    // when the engine grows the facts; a surface that printed one would be telling a lie.
    expect(READING_LADDER.again).toBe('не расслышали с первого раза, читают снова · попытка вторая из пяти');
    expect(READING_LADDER.approach).toContain('третья попытка из пяти');
    expect(READING_LADDER.fourth).toBe('пробуют иначе · попытка четвёртая из пяти');
    expect(READING_LADDER.fifth).toBe('пробуют иначе · попытка пятая из пяти');
    expect(READING_LADDER.ruleOnly).toBe('последняя попытка — по правилу, без машины');
    expect(READING_LADDER.spent).toBe(
      'не дошло: пробовали шесть раз и не смогли. правка не отклонена — нажмите «повторить»',
    );
    // `reviseLine` spells line 9, and no surface holds the bound it needs either.
    expect(reviseLine(2, 5)).toBe('редактор просит поправить одно место \u00b7 вторая поправка из пяти');
    const printed = FILES.filter((file) => /web\/src|server\/src/u.test(file)).map((file) => readFileSync(file, 'utf8'));
    for (const name of ['READING_LADDER', 'reviseLine']) {
      expect(printed.some((source) => source.includes(name)), name).toBe(false);
    }
  });

  it('finds a planted word, and ignores the same word in a comment', () => {
    // The matcher is not a stub: this is what it must refuse…
    expect(offence('правка в очереди на запись')).toBe('очеред');
    expect(offence('правка в триаже')).toBe('триаж');
    expect(offence('вердикт не пришёл')).toBe('вердикт');
    expect(offence('состояние accepted')).toBe('accepted');
    // …and this is what it must keep: a literal with no Cyrillic is not reader copy.
    expect(offence('processing')).toBeNull();
    expect(offence('принято · впишется, когда машина возьмёт главу')).toBeNull();
    // A comment is not a literal: the machine may be named there, the page may not.
    expect(literalsOf('// правка в очереди\nconst x = 1;')).toEqual([]);
    expect(literalsOf('/* проход остановлен */\nconst x = 1;')).toEqual([]);
    // A template's `${ … }` is code — and a literal written inside it is still copy.
    expect(literalsOf('`глава ${change.chapter}`')).toEqual(['глава ']);
    // The nested literals are collected as the interpolation is scanned; the template's own
    // text is pushed after the code it contains.
    expect(literalsOf('`итог: ${flag ? \'ждёт\' : \'готово\'}`')).toEqual(['ждёт', 'готово', 'итог: ']);
  });

  it('nows the pass noun in its own forms, never the verb «проходит»', () => {
    // The noun is the machinery's word…
    expect(offence('этот проход остановлен')).toBe('проход');
    expect(offence('до конца прохода')).toBe('проход');
    expect(offence('на проходе')).toBe('проход');
    expect(offence('два прохода')).toBe('проход');
    // …the ordinary verb is not: a reader may be told that time passes.
    expect(offence('время проходит')).toBeNull();
    expect(offence('правка проходит проверку')).toBeNull();
    expect(offence('они проходят мимо')).toBeNull();
  });

  it('reads the sentences typed straight into the markup, not only the literals', () => {
    // BOOK-218 — the blind spot: `LegalPage` printed «очередь правок — общей» as a JSX child,
    // which no literal scan could see. The extractor is what closes it.
    const source = '<p>Книга остаётся бесплатной, а очередь правок — общей.</p>';
    expect(jsxTextOf(source)).toEqual(['Книга остаётся бесплатной, а очередь правок — общей.']);
    expect(jsxTextOf(source).map(offence)).toEqual(['очеред']);
    // An expression between two angle brackets is not a sentence.
    expect(jsxTextOf('<span>{a > b ? c : d}</span>')).toEqual([]);
    expect(jsxTextOf('<p className="x">текст {n} строк</p>')).toEqual(['текст {n} строк']);
    // The real surface no longer says it, and the walk now sees that file.
    const legal = readFileSync(join(ROOT, 'web/src/components/LegalPage.tsx'), 'utf8');
    expect(jsxTextOf(legal).map(offence).filter((hit) => hit !== null)).toEqual([]);
    expect(jsxTextOf(legal).join(' ')).toContain('правки идут по одной, в порядке записи');
  });
});
