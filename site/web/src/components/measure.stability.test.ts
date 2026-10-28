import { describe, expect, it } from 'vitest';

import { blankComments, rulesOf, TOKENS, type Rule } from './measure.css.ts';
import { rootScaleProblems } from './measure.rules.ts';
import { BASE, sheets, seeded, tokenPx } from './measure.guard.ts';

/**
 * BOOK-170 — the reading column does not follow the reader's root font size.
 *
 * jsdom has no layout engine, so the four-viewport proof in a real browser is
 * `scripts/type-stability.mjs`; this file is the arithmetic that browser must then confirm:
 * the column and the body are px at any root, the step keeps one character count, and the guard
 * refuses a `rem` that would bring the reader's size back into the cascade.
 */

const ROOTS = [16, 18, 20];

const parse = (set = sheets): Rule[] =>
  Object.entries(set).flatMap(([file, css]) => rulesOf(file, blankComments(css)));

type Step = 'base' | 'narrow' | 'phone';

/** A token's value as the sheet writes it: `640px` at the root, `622px` in `@media`. */
function declared(name: string, step: Step): string {
  const query = step === 'narrow' ? '1023px' : step === 'phone' ? '599px' : '';
  const rule = parse().find(
    (entry) =>
      entry.file === TOKENS &&
      entry.declarations.has(name) &&
      entry.parts.length === 1 &&
      entry.parts[0] === ':root' &&
      entry.at.length === (step === 'base' ? 0 : 1) &&
      (query === '' || entry.at.some((at) => at.includes(query))),
  );
  return rule?.declarations.get(name) ?? '';
}

/** A declared length at a root font size: `px` is absolute, `rem` is `n × root`. */
const resolve = (value: string, root: number): number => {
  const n = Number.parseFloat(value);
  return value.trim().endsWith('rem') ? n * root : n;
};

describe('the column and the body are px (BOOK-170)', () => {
  it('keeps the two measures absolute: 640 px, and 622 px below 1024', () => {
    expect(tokenPx('--measure')).toBe(640);
    expect(tokenPx('--measure', { query: 'narrow' })).toBe(622);
    expect([declared('--measure', 'base'), declared('--measure', 'narrow')]).toEqual(['640px', '622px']);
    // The type rungs are unchanged: 18 / 17.5 / 17 px.
    expect([
      tokenPx('--fs-body'),
      tokenPx('--fs-body', { query: 'narrow' }),
      tokenPx('--fs-body', { query: 'phone' }),
    ]).toEqual([18, 17.5, 17]);
  });

  it('finds no `rem` length anywhere in the cascade', () => {
    expect(rootScaleProblems(parse())).toEqual([]);
  });

  it('resolves the column and the body to the same px at a 16, 18 and 20 px root', () => {
    const at = (step: Step, root: number): number[] => [
      resolve(declared('--measure', step), root),
      resolve(declared('--fs-body', step), root),
    ];
    for (const root of ROOTS) {
      expect(at('base', root)).toEqual([640, 18]);
      expect(at('narrow', root)).toEqual([622, 17.5]);
    }
  });

  it('holds one character count across the 1023/1024 step', () => {
    // The design's nominal half an em per character, the same arithmetic `lib/layout.ts` folds.
    const charsPerLine = (width: number, font: number): number => width / (0.5 * font);
    const wideGutter = tokenPx('--gut');
    const phoneGutter = tokenPx('--gut', { query: 'phone', file: BASE });
    const column = (viewport: number, measure: number, gutter: number): number =>
      Math.min(measure, viewport - 2 * gutter);

    const table = [
      [390, column(390, 622, phoneGutter), 17],
      [768, column(768, 622, wideGutter), 17.5],
      [1024, column(1024, 640, wideGutter), 18],
      [1440, column(1440, 640, wideGutter), 18],
    ] as const;
    expect(table.map(([, width]) => width)).toEqual([342, 622, 640, 640]);
    expect(table.map(([, width, font]) => Math.round(charsPerLine(width, font) * 100) / 100)).toEqual([
      40.24, 71.09, 71.11, 71.11,
    ]);
    // The step's whole point: the two sides of 1023/1024 read the same number of characters.
    const narrow = charsPerLine(column(1023, 622, wideGutter), 17.5);
    expect(narrow).toBeCloseTo(charsPerLine(column(1024, 640, wideGutter), 18), 1);
  });

  it('reports a 40rem measure as a rem problem, so the guard is seen to fire', () => {
    const problems = rootScaleProblems(parse(seeded(TOKENS, ':root { --measure: 40rem; }')));
    expect(problems).toContain(
      `${TOKENS}: :root { --measure: 40rem } — a rem follows the reader's root font size; the reading geometry is px and a copy cap is ch`,
    );
  });
});
