/**
 * BOOK-88 — the guard behind `measure.test.ts`: one column, one prose block, one left edge.
 *
 * The rule (owner, 2026-10-27): the page is a single column, up to 1000 px on the desktop and
 * adaptive on the mobile by its gutters alone. Every register — header, cover, page 2, the TOC,
 * the chronicle, the colophon, the discussion, the legal documents — lives in that column and
 * shares one left edge, and the prose keeps its measure inside it, flush left.
 *
 * This module is the file side: it globs the cascade and the register components as text and
 * exposes the two entry points the test needs. The six sheet checks are in `measure.rules.ts`
 * and the CSS parser in `measure.css.ts`; the markup check lives here because it needs the
 * component glob. The four-viewport arithmetic, on `tokenPx`, is check 7, in the test.
 *
 * Not policed, on purpose: `ch` copy caps (58ch genre/promise, 62ch a chronicle row, 26ch the
 * legal page's pull quote) bound a sentence, not the page — and the overlays, which are laid
 * over the page and keep their own geometry. No product code imports this module.
 */

import {
  blankComments,
  classTokensPerAttribute,
  rulesOf,
  type Rule,
  type SheetSet,
} from './measure.css.ts';
import { layoutProblemsOf, tokenPxOf } from './measure.rules.ts';

export { BASE, TOKENS } from './measure.css.ts';
export { COLUMN_SELECTORS } from './measure.tokens.ts';
export { OVERLAYS, PROSE, REGISTERS } from './measure.rules.ts';

/** The sheets as text, and the entry point they are derived from. */
const OUTER = import.meta.glob<string>(['../main.tsx', '../styles/*.css'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Every stylesheet of the cascade, keyed as `../styles/<name>.css`. */
export const sheets: SheetSet = Object.fromEntries(
  Object.entries(OUTER).filter(([file]) => file.endsWith('.css')),
);
const mainSource = OUTER['../main.tsx'] ?? '';

/** The sheets `main.tsx` puts in the cascade, as keys of `sheets`. */
export function cascadeSheets(source: string): string[] {
  const files = [...source.matchAll(/'\.\/styles\/([\w-]+\.css)'/gu)].map((match) => `../styles/${match[1] ?? ''}`);
  return [...new Set(files)].sort();
}

/** The cascade `main.tsx` boots, for the "the guard reads the whole cascade" test. */
export const cascade: string[] = cascadeSheets(mainSource);

/** The register components as text, keyed as `./<Name>.tsx`. */
export const components: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>(['./*.tsx'], {
    query: '?raw',
    import: 'default',
    eager: true,
  })),
);

/**
 * The markup half of the one-column rule: a register is rendered by a component whose root
 * class string carries `page`, and that string also names the register. A dropped
 * `className="page"` leaves the register outside the column, and no sheet can tell — the
 * element simply stops being a `.page`. `.ribbon` and `.noscript` are the two column boxes
 * that are not `.page`: the ribbon states its own frame, and the no-JS fallback is in
 * `index.html`, not in a component.
 */
export const REGISTER_COMPONENTS = [
  { file: './TitleSheet.tsx', register: 'titul' },
  { file: './Header.tsx', register: 'top-in' },
  { file: './Annotation.tsx', register: 'annotation' },
  { file: './HowTheBookIsMade.tsx', register: 'how-made' },
  { file: './ViewSwitch.tsx', register: 'views' },
  { file: './TableOfContents.tsx', register: 'toc' },
  { file: './ChapterArticle.tsx', register: 'ch' },
  { file: './Discussion.tsx', register: 'talks' },
  { file: './Authors.tsx', register: 'authors' },
  { file: './Colophon.tsx', register: 'colophon' },
  { file: './LegalPage.tsx', register: 'legal' },
  { file: './ConsentBanner.tsx', register: 'consent' },
  { file: './Chronicle.tsx', register: 'chronicle' },
] as const;

/**
 * Every way the markup fails to keep a register in the column. Pure: `markupProblems()` is the
 * real tree, `markupProblems(dropped)` is a seeded violation.
 */
export function markupProblems(source: Record<string, string> = components): string[] {
  const problems: string[] = [];
  for (const { file, register } of REGISTER_COMPONENTS) {
    const text = source[file];
    if (text === undefined) {
      problems.push(`${file} is missing — the ${register} register has no component`);
      continue;
    }
    const carries = classTokensPerAttribute(text).some(
      (tokens) => tokens.includes('page') && tokens.includes(register),
    );
    if (!carries) {
      problems.push(`${file} no longer carries \`page ${register}\` in one className — the register would leave the column`);
    }
  }
  return problems;
}

const parse = (set: SheetSet): Rule[] =>
  Object.entries(set).flatMap(([file, css]) => rulesOf(file, blankComments(css)));

/**
 * Every way the sheet set fails to hold the one column. Pure: `layoutProblems(sheets)` is the
 * real tree, `layoutProblems(seeded(...))` is a seeded violation.
 */
export function layoutProblems(set: SheetSet): string[] {
  return layoutProblemsOf(parse(set));
}

/** A copy of the real sheets with one rule appended to one of them — the seed of a regression. */
export function seeded(file: string, css: string): SheetSet {
  const base = sheets[file];
  if (base === undefined) throw new Error(`${file} is not a sheet`);
  return { ...sheets, [file]: `${blankComments(base)}\n${css}\n` };
}

/** A copy of the real sheets with one exact string rewritten — a seed that removes a rule. */
export function replaced(file: string, from: string, to: string): SheetSet {
  const base = sheets[file];
  if (base === undefined) throw new Error(`${file} is not a sheet`);
  const next = blankComments(base).replace(from, to);
  if (next === blankComments(base)) throw new Error(`${from} is not in ${file}`);
  return { ...sheets, [file]: next };
}

/**
 * One token as a number of px, read from the real sheets. `narrow` reads the ≤1023 step of
 * `tokens.css`, `phone` the ≤599 block of `base.css` — the two places a token narrows.
 */
export function tokenPx(
  name: string,
  options: { query?: 'narrow' | 'phone'; file?: string } = {},
): number {
  return tokenPxOf(parse(sheets), name, options);
}
