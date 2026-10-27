/**
 * BOOK-88 — checks 1 and 2 of the one-column guard: the tokens and the column's box.
 *
 * 1. `--column` and `--measure` have one home each (`tokens.css`), at the values the design
 *    memo fixes, and the retired `--shell` is gone for good.
 * 2. `var(--column)` is the box of `.page` (and of `.ribbon` / `.noscript`, the two boxes that
 *    are the column without being a `.page` inside it), and only as a `max-width`.
 */

import { squash, stating, where, TOKENS, type Rule } from './measure.css.ts';

/** The three boxes that are the column, and the only readers of `var(--column)`. */
export const COLUMN_SELECTORS = ['.page', '.ribbon', '.noscript'] as const;

const COLUMN_VALUE = 'var(--column)';

/** 1 — the two tokens have one home each, and the retired one is not aliased back. */
export function tokenProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  const list = (entries: Array<{ rule: Rule; value: string }>): string =>
    entries.map((entry) => `${entry.rule.file} ${entry.rule.selector} ${entry.value}`).join('; ') || 'nowhere';

  const column = stating(rules, '--column');
  const [onlyColumn] = column;
  if (column.length !== 1 || onlyColumn === undefined) {
    problems.push(`--column is declared ${column.length} time(s) (${list(column)}) — the column has one home, ${TOKENS}`);
  } else if (onlyColumn.rule.file !== TOKENS || onlyColumn.rule.at.length > 0) {
    problems.push(`${where(onlyColumn.rule, '--column', onlyColumn.value)} — ${TOKENS} declares the column at the root: it does not narrow`);
  } else if (squash(onlyColumn.value) !== '1000px') {
    problems.push(`--column: ${onlyColumn.value} — the column is 1000px`);
  }

  const measure = stating(rules, '--measure');
  const base = measure.filter((entry) => entry.rule.at.length === 0);
  const narrow = measure.filter((entry) => entry.rule.at.length > 0);
  if (measure.length !== 2 || base.length !== 1 || narrow.length !== 1) {
    problems.push(
      `--measure is declared ${measure.length} time(s) (${list(measure)}) — exactly two steps: 37.5rem at the root and 36.5rem inside @media (max-width: 1023px)`,
    );
  }
  for (const entry of measure.filter((item) => item.rule.file !== TOKENS)) {
    problems.push(`${where(entry.rule, '--measure', entry.value)} — the prose block has one home, ${TOKENS}`);
  }
  const [baseMeasure] = base;
  if (baseMeasure !== undefined && squash(baseMeasure.value) !== '37.5rem') {
    problems.push(`--measure: ${baseMeasure.value} — 37.5rem = 600px = 67 ch at 18px`);
  }
  const [narrowMeasure] = narrow;
  if (narrowMeasure !== undefined) {
    if (squash(narrowMeasure.value) !== '36.5rem') {
      problems.push(`--measure: ${narrowMeasure.value} in ${narrowMeasure.rule.at.join(' ')} — 36.5rem = 584px = 66.7 ch at 17.5px`);
    }
    if (!narrowMeasure.rule.at.some((query) => squash(query).includes('max-width:1023px'))) {
      problems.push(`${where(narrowMeasure.rule, '--measure', narrowMeasure.value)} — the narrow step belongs to @media (max-width: 1023px)`);
    }
  }

  const legacy = stating(rules, '--shell');
  const legacyUse = rules.flatMap((rule) =>
    [...rule.declarations]
      .filter(([, value]) => value.includes('var(--shell)'))
      .map(([property, value]) => where(rule, property, value)),
  );
  if (legacy.length > 0 || legacyUse.length > 0) {
    problems.push(
      `--shell is back (${legacy.length} declaration(s), ${legacyUse.length} use(s)) — BOOK-88 renamed the frame to --column; two canvas tokens is two frames`,
    );
  }
  return problems;
}

/** 2 — `var(--column)` is the box of the column, and only as a `max-width`. */
export function columnProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (!value.includes(COLUMN_VALUE)) continue;
      const named = rule.parts.length === 1 && (COLUMN_SELECTORS as readonly string[]).includes(rule.parts[0] ?? '');
      if (property !== 'max-width' || !named) {
        problems.push(
          `${where(rule, property, value)} — var(--column) is the box of .page (and of .ribbon / .noscript, the two boxes that are the column without being a .page inside it), and only as a max-width`,
        );
      }
    }
  }
  for (const selector of COLUMN_SELECTORS) {
    const found = rules.some(
      (rule) =>
        rule.parts.length === 1 &&
        squash(rule.parts[0] ?? '') === squash(selector) &&
        squash(rule.declarations.get('max-width') ?? '') === COLUMN_VALUE,
    );
    if (!found) problems.push(`${selector} does not state its box — the column is var(--column)`);
  }
  return problems;
}
