/**
 * BOOK-88/BOOK-91 — checks 1 and 2 of the one-column guard: the tokens and the canvas.
 *
 * 1. `--measure` has one home (`tokens.css`), at the value the design memo fixes, and the
 *    retired `--shell` and `--column` are gone for good. BOOK-91 retired `--column` with the
 *    1000 px frame: the canvas is no longer a second, wider box, it is the column plus its
 *    gutters, so a token that named a frame had nothing left to name.
 * 2. `.canvas` is the column plus its two gutters, centred — `max-width:
 *    calc(var(--measure) + 2 * var(--gut))`, `padding-inline: var(--gut)`, `margin-inline:
 *    auto` — and it is the only rule that states the frame. Every register inside it is
 *    exactly the measure; the running folio is the one box that reads the measure as a
 *    position (`FOLIO_INSET`), and it states no size of its own.
 */

import { exactly, squash, stating, where, TOKENS, type Rule } from './measure.css.ts';

/** The canvas: the column plus its two gutters, centred (BOOK-91). */
export const CANVAS = '.canvas';

/** The canvas's own bound: the column, never a frame wider than it. */
export const CANVAS_BOUND = 'calc(var(--measure) + 2 * var(--gut))';

/**
 * The running folio's inset (BOOK-89/BOOK-91): its right edge sits 20 px outside the column's
 * right edge — 1060 at 1440, 852 at 1024, 715 at 768. It states no width, so the number can
 * change a hundred times without moving a line of prose.
 */
export const FOLIO_INSET = 'calc((100% - var(--measure)) / 2 - 20px)';

const RETIRED = [
  {
    name: '--shell',
    why: 'BOOK-88 renamed the canvas to --column and BOOK-91 retired that too; two canvas tokens is two frames',
  },
  {
    name: '--column',
    why: 'BOOK-91 retired the 1000 px frame: the canvas is calc(var(--measure) + 2 * var(--gut)), not a second box',
  },
] as const;

const GUT_VALUE = 'var(--gut)';

/** Every value a rule states for one property, with the rule it came from, filtered by name. */
const states = (rules: Rule[], selector: string, property: string, value: string): boolean =>
  rules.some((rule) => exactly(rule, selector) && squash(rule.declarations.get(property) ?? '') === squash(value));

/** 1 — the measure has one home with two steps, and the retired tokens are not aliased back. */
export function tokenProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  const list = (entries: Array<{ rule: Rule; value: string }>): string =>
    entries.map((entry) => `${entry.rule.file} ${entry.rule.selector} ${entry.value}`).join('; ') || 'nowhere';

  const measure = stating(rules, '--measure');
  const base = measure.filter((entry) => entry.rule.at.length === 0);
  const narrow = measure.filter((entry) => entry.rule.at.length > 0);
  if (measure.length !== 2 || base.length !== 1 || narrow.length !== 1) {
    problems.push(
      `--measure is declared ${measure.length} time(s) (${list(measure)}) — exactly two steps: 640px at the root and 622px inside @media (max-width: 1023px)`,
    );
  }
  for (const entry of measure.filter((item) => item.rule.file !== TOKENS)) {
    problems.push(`${where(entry.rule, '--measure', entry.value)} — the text column has one home, ${TOKENS}`);
  }
  const [baseMeasure] = base;
  if (baseMeasure !== undefined && squash(baseMeasure.value) !== '640px') {
    problems.push(`--measure: ${baseMeasure.value} — 640px = 71.1 ch at 18px; a rem would follow the reader’s root font size`);
  }
  const [narrowMeasure] = narrow;
  if (narrowMeasure !== undefined) {
    if (squash(narrowMeasure.value) !== '622px') {
      problems.push(`--measure: ${narrowMeasure.value} in ${narrowMeasure.rule.at.join(' ')} — 622px = 71.1 ch at 17.5px; a rem would follow the reader’s root font size`);
    }
    if (!narrowMeasure.rule.at.some((query) => squash(query).includes('max-width:1023px'))) {
      problems.push(`${where(narrowMeasure.rule, '--measure', narrowMeasure.value)} — the narrow step belongs to @media (max-width: 1023px)`);
    }
  }

  for (const retired of RETIRED) {
    const declared = stating(rules, retired.name);
    const used = rules.flatMap((rule) =>
      [...rule.declarations]
        .filter(([, value]) => value.includes(`var(${retired.name})`))
        .map(([property, value]) => where(rule, property, value)),
    );
    if (declared.length > 0 || used.length > 0) {
      problems.push(
        `${retired.name} is back (${declared.length} declaration(s), ${used.length} use(s)) — ${retired.why}`,
      );
    }
  }
  return problems;
}

/** 2 — the canvas is the column plus its gutters, centred; the retired frame is read nowhere. */
export function canvasProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  if (!states(rules, CANVAS, 'max-width', CANVAS_BOUND)) {
    problems.push(`${CANVAS} does not state its bound — the canvas is max-width: ${CANVAS_BOUND}, the column plus its two gutters`);
  }
  if (!states(rules, CANVAS, 'padding-inline', GUT_VALUE)) {
    problems.push(`${CANVAS} does not state padding-inline: var(--gut) — the gutters are the canvas's, once; a register may not keep its own`);
  }
  const centred = rules.some(
    (rule) =>
      exactly(rule, CANVAS) &&
      ['margin', 'margin-inline'].some((property) => squash(rule.declarations.get(property) ?? '').includes('auto')),
  );
  if (!centred) {
    problems.push(`${CANVAS} does not centre the column — margin-inline: auto is the canvas's, and the registers stay flush left inside it`);
  }
  // The retired frame may not survive as a use either: `var(--column)` is reported by check 1,
  // and a rule that reads it is the same second frame one step in.
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (!value.includes('var(--column)')) continue;
      problems.push(`${where(rule, property, value)} — var(--column) is retired (BOOK-91); the canvas is the column plus its gutters`);
    }
  }
  // The folio's one position: its right edge is the column's right edge + 20 px. It is pinned
  // as a declaration, so a stale inset fails here instead of drifting a few pixels a year.
  const folio = rules.find((rule) => exactly(rule, '.folio'));
  const inset = folio?.declarations.get('inset-inline-end') ?? '';
  if (squash(inset) !== squash(FOLIO_INSET)) {
    problems.push(
      `.folio { inset-inline-end: ${inset || 'nothing'} } — the number's right edge is 20px outside the column's: ${FOLIO_INSET}`,
    );
  }
  if (!states(rules, '.folio', 'position', 'fixed')) {
    problems.push('.folio does not state position: fixed — the running number is out of the flow and moves no line');
  }
  return problems;
}
