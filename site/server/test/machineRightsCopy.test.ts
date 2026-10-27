import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * BOOK-69 AC3 — no reader-facing line makes the machine an author, a co-author or a rights
 * holder.
 *
 * BOOK-69 says the opposite on `/rules` and in the README: the machine is a tool, authorship
 * arises only in people, and no program — nor the people who built it — holds a right in the
 * text. That promise is copy, so it can rot: one sentence in a later wave would undo the
 * section without breaking a render test. This file greps for a **paraphrase net**, not for
 * grammar: it is case-blind, it joins the `'…' + '…'` seams reader copy is written with, and
 * it is **negation-aware**, because the honest sentence and the forbidden one share every
 * word except the «не».
 *
 * What the net covers, and what it does not:
 *   - the machine as subject (or object) of an authorship noun — «— автор», «— её автор»,
 *     «— соавтор», «является автором», «автор текста», bare «правообладатель»;
 *   - ownership of the right, singular or plural — «права|право принадлежат|принадлежит»,
 *     «владеет правами»;
 *   - transfer and acquisition — «передаёт права», «отчуждает», and the receive/hold/be-
 *     recognised verbs (`получает|приобретает|имеет|возникает|признаётся`) with «право|права|
 *     автор» up to two words away, in the same clause.
 * It does not parse syntax: a claim phrased with a verb none of these stems cover, or split
 * across two clauses, passes. The net is a floor under the copy, not a proof about it.
 *
 * What is scanned (the product's reader-facing surfaces):
 *   - `README.md`, `site/README.md`, `site/web/index.html`;
 *   - every non-test `*.ts` / `*.tsx` under `site/web/src`;
 *   - every non-test `*.ts` under `site/shared/src` and `site/server/src`.
 *
 * Deliberately not scanned, and why:
 *   - `manuscript/` — the novel itself, not product copy; its prose is the author's;
 *   - `concept/`, `outline/`, `style/`, `notes/`, `process/` — the author's canon and working
 *     notes, not the product's voice, and outside what this AC governs;
 *   - `site/model-lane/` — prompt fixtures: text a model is asked to write, not text a reader
 *     is shown;
 *   - tests and `node_modules` — the guard's own examples are the forbidden sentences.
 *
 * A hit in code this change may not touch is reported to the orchestrator, not allow-listed:
 * an allow-list entry is a decision about the book's copy, not a test detail.
 */

const BOOK_ROOT = join(import.meta.dirname, '../../..');
const SITE = join(BOOK_ROOT, 'site');

/**
 * The nouns that can stand for the machine — the subject half of a claim.
 *
 * Two JavaScript traps are handled here. `\w` is ASCII-only, so a Russian stem takes
 * `[\p{L}]*`; and `\b` is ASCII-only too, so the word edges are lookarounds over letters —
 * without them the case-insensitive «ИИ» would match the tail of «линии».
 */
const ENTITY = String.raw`(?<![\p{L}])(?:ИИ|нейросет[\p{L}]*|модел[\p{L}]*|алгоритм[\p{L}]*|машин[\p{L}]*|программ[\p{L}]*)(?![\p{L}])`;

/**
 * The formulas that would give the machine authorship or a right — the predicate half: the
 * authorship nouns, the singular and plural ownership of the right, the transfer verbs, and
 * the receive/hold/be-recognised verbs near «право|права|автор».
 */
const PREDICATE_PARTS = [
  String.raw`явля[\p{L}]*\s+(?:автор|соавтор|правообладател)[\p{L}]*`,
  // `— автор`, and one optional word between the dash and the noun: `— её автор`.
  String.raw`—\s*(?:[\p{L}]+\s+)?(?:со)?автор[\p{L}]*`,
  String.raw`автор[\p{L}]*\s+(?:текста|книги|главы)`,
  String.raw`правообладател[\p{L}]*`,
  // Ownership: «права принадлежат модели», «право принадлежит модели» — the stem, not the
  // 3rd-person-plural form alone, because «принадлежит» is «принадлеж» + «ит».
  String.raw`(?:право|права)\s+принадлеж[\p{L}]*`,
  String.raw`владеет\s+правами`,
  String.raw`передаёт\s+(?:права|исключительное\s+право)`,
  String.raw`отчуждает`,
  // «модель получает исключительное право», «у модели возникает право», «признаётся автором».
  String.raw`(?:получает|приобретает|имеет|возникает|признаётся)[\p{L}]*\s+(?:[\p{L}]+\s+){0,2}(?:право|права|автор)`,
];
const PREDICATE = `(?:${PREDICATE_PARTS.join('|')})`;

/** A clause, not a sentence: the claim and its subject must sit in the same breath. */
const CLAUSE_BREAK = /[.;:!?…\n]+/u;
/** The negations that make the sentence say the opposite of the claim. */
const NEGATIONS = new Set(['не', 'ни', 'нет']);
/** A contrast starts a new claim: «не машина, а ИИ является автором» names the machine too. */
const CONTRASTS = new Set(['а', 'но', 'однако']);

/** `\b` is ASCII-only in JavaScript, so words are split on everything that is not a letter. */
const words = (text: string): RegExpMatchArray[] => [...text.matchAll(/[\p{L}]+/gu)];

/** True when a negation stands in `window` — the sentence then says the opposite. */
const negated = (window: string): boolean =>
  words(window).some((word) => NEGATIONS.has(word[0].toLowerCase()));

/** Where the last contrast ends in `prefix`: a pair before it is a different claim. */
function lastContrastEnd(prefix: string): number {
  let end = 0;
  for (const word of words(prefix)) {
    if (CONTRASTS.has(word[0].toLowerCase())) end = (word.index ?? 0) + word[0].length;
  }
  return end;
}

type Hit = { start: number; end: number };

/** Case-blind on purpose: «Нейросеть — автор.» is the same claim as its lowercase form. */
function occurrences(text: string, source: string): Hit[] {
  return [...text.matchAll(new RegExp(source, 'giu'))].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/**
 * Reader copy is written as `'…' + '…'`, so the source's newline lands inside the sentence and
 * a clause would end mid-claim. The seam between two adjacent quoted literals is removed, and
 * only it: `'a' + x + 'b'` keeps its quotes and stays two fragments, as it genuinely is.
 */
function joinStringSeams(source: string): string {
  return source.replace(/(['"])\s*\+\s*\1/gu, '');
}

/**
 * The claims in `text` that give the machine authorship or a right, as the clause text that
 * carries them. A pair whose negation stands before it inside the same clause is not a claim:
 * «Машина — инструмент, не автор и не правообладатель» and «ни модель, ни её разработчик не
 * являются ни авторами, ни правообладателями» both pass, and both are the copy BOOK-69 asks
 * for.
 */
export function machineRightsClaims(text: string): string[] {
  const claims: string[] = [];
  for (const clause of joinStringSeams(text).split(CLAUSE_BREAK)) {
    const entities = occurrences(clause, ENTITY);
    const predicates = occurrences(clause, PREDICATE);
    if (entities.length === 0 || predicates.length === 0) continue;
    for (const entity of entities) {
      for (const predicate of predicates) {
        const start = Math.min(entity.start, predicate.start);
        const end = Math.max(entity.end, predicate.end);
        // A contrast inside the prefix starts a fresh claim: the negation before it belongs to
        // the other subject and says nothing about this pair.
        const from = lastContrastEnd(clause.slice(0, start));
        if (negated(clause.slice(from, end))) continue;
        claims.push(clause.slice(start, end).trim());
      }
    }
  }
  return claims;
}

describe('the claim helper is not vacuous', () => {
  /** The ten phrasings BOOK-69 names, as written; the two cases are derived from each. */
  const PHRASINGS = [
    'ИИ — автор',
    'ИИ является автором',
    'нейросеть — автор',
    'ИИ — соавтор книги',
    'права принадлежат модели',
    'правообладатель — модель',
    'ИИ передаёт права',
    'модель отчуждает исключительное право',
    'автор текста — алгоритм',
    'машина владеет правами на книгу',
  ];

  it('flags all ten phrasings, lowercase and sentence-capitalised', () => {
    expect(PHRASINGS).toHaveLength(10);
    for (const phrasing of PHRASINGS) {
      const lower = phrasing.toLowerCase();
      const capitalised = `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
      for (const sentence of [phrasing, lower, capitalised]) {
        expect(machineRightsClaims(sentence), sentence).not.toEqual([]);
      }
    }
  });

  it('flags the paraphrases the predicate set is widened for', () => {
    const paraphrases = [
      'право принадлежит модели',
      'исключительное право принадлежит модели',
      'модель получает исключительное право на текст',
      'модель приобретает исключительное право',
      'нейросеть имеет права на текст',
      'модель признаётся автором',
      'у модели возникает право на текст',
      'книга написана моделью, модель — её автор',
    ];
    for (const sentence of paraphrases) {
      expect(machineRightsClaims(sentence), sentence).not.toEqual([]);
    }
  });

  it('flags a claim the source wraps across its own line break', () => {
    // Reader copy is `'…' + '…'`, so the newline sits inside the sentence, not between two.
    const wrapped = "export const A =\n  'ИИ ' +\n  'является автором книги';\n";
    expect(machineRightsClaims(wrapped)).not.toEqual([]);
    const wrappedDash = "const B =\n  'Нейросеть — ' + 'автор главы';";
    expect(machineRightsClaims(wrappedDash)).not.toEqual([]);
  });

  it('passes the honest sentences, negation and all', () => {
    const legitimate = [
      'Машина — инструмент, не автор и не правообладатель: авторские права возникают только у людей.',
      'У машины нет авторства и нет прав — ни у неё, ни у её разработчика.',
      'Машина — инструмент: она пишет по заданию автора и прав не получает.',
      'ни модель, ни её разработчик не являются ни авторами, ни правообладателями текста',
    ];
    for (const sentence of legitimate) {
      expect(machineRightsClaims(sentence), sentence).toEqual([]);
    }
  });

  it('does not manufacture a claim out of an honest wrapped sentence', () => {
    const wrappedHonest =
      "const C =\n  'Машина — инструмент: она пишет по заданию автора и прав не ' +\n  'получает.';";
    expect(machineRightsClaims(wrappedHonest)).toEqual([]);
    // The same proof on the real file, wrapped the way the repo actually writes it.
    const terms = readFileSync(join(SITE, 'web/src/lib/terms.ts'), 'utf8');
    expect(terms).toContain('Машина — инструмент, не автор и не правообладатель');
    expect(machineRightsClaims(terms)).toEqual([]);
  });

  it('reads the claim in the clause it is written in, not in the next one', () => {
    // The subject and the predicate on either side of a full stop are two statements.
    expect(machineRightsClaims('Модель проверяет текст. Автором остаётся человек.')).toEqual([]);
  });
});

/** Every non-test source file whose text a reader can end up reading. */
function readerFacingSources(): { files: string[]; roots: string[] } {
  const files = ['README.md', join('site', 'README.md'), join('site', 'web', 'index.html')];
  const roots: Array<{ dir: string; ext: RegExp }> = [
    { dir: join(SITE, 'web', 'src'), ext: /\.(ts|tsx)$/u },
    { dir: join(SITE, 'shared', 'src'), ext: /\.ts$/u },
    { dir: join(SITE, 'server', 'src'), ext: /\.ts$/u },
  ];
  const scanned: string[] = [];
  const walk = (dir: string, ext: RegExp): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, ext);
      else if (ext.test(entry.name) && !/\.test\.(ts|tsx)$/u.test(entry.name)) {
        scanned.push(relative(BOOK_ROOT, path).split(sep).join('/'));
      }
    }
  };
  for (const { dir, ext } of roots) walk(dir, ext);
  return { files: files.map((file) => file.split(sep).join('/')), roots: scanned };
}

describe('no reader-facing line gives the machine the book (BOOK-69 AC3)', () => {
  it('finds no claim in the copy, the shell or the README', () => {
    const { files, roots } = readerFacingSources();
    // The walk itself is pinned: an empty or narrowed scan would pass for the wrong reason.
    expect(roots.length).toBeGreaterThan(100);
    for (const surface of ['README.md', 'site/README.md', 'site/web/index.html']) {
      expect(files, surface).toContain(surface);
    }
    for (const surface of ['site/web/src/lib/terms.ts', 'site/server/src/index.ts', 'site/shared/src/index.ts']) {
      expect(roots, surface).toContain(surface);
    }
    const all = [...files, ...roots];
    const hits: string[] = [];
    for (const file of all) {
      const text = readFileSync(join(BOOK_ROOT, file), 'utf8');
      for (const claim of machineRightsClaims(text)) hits.push(`${file}: ${claim}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('the README says the machine is a tool (BOOK-69)', () => {
  const README_SENTENCE =
    'Машина — инструмент: она пишет по заданию автора и прав не получает; ни модель, ни её разработчик не являются ни авторами, ни правообладателями текста.';
  const readme = readFileSync(join(BOOK_ROOT, 'README.md'), 'utf8');

  it('carries the sentence verbatim, between the licence split and the run instructions', () => {
    expect(readme).toContain(README_SENTENCE);
    const licencesAt = readme.indexOf('## Лицензии');
    const sentenceAt = readme.indexOf(README_SENTENCE);
    const runAt = readme.indexOf('## Как запустить');
    expect(licencesAt).toBeGreaterThan(-1);
    expect(licencesAt).toBeLessThan(sentenceAt);
    expect(sentenceAt).toBeLessThan(runAt);
  });

  it('is its own paragraph, and short enough to be read on the way past', () => {
    const before = readme.slice(0, readme.indexOf(README_SENTENCE));
    // A paragraph, not a continuation: a blank line separates it from the licence note above.
    expect(before.endsWith('\n\n')).toBe(true);
    expect(README_SENTENCE.split(/\s+/u).filter((word) => word.length > 0).length).toBeLessThanOrEqual(30);
  });
});
