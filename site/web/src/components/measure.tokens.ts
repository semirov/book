/**
 * BOOK-88 — checks 1 and 2 of the one-column guard: the tokens and the canvas.
 *
 * 1. `--column` and `--measure` have one home each (`tokens.css`), at the values the design
 *    memo fixes, and the retired `--shell` is gone for good.
 * 2. `var(--column)` is the box of `.canvas` — the one box on the page allowed to be wider
 *    than the text column — and of nothing else, and only as a `max-width`; plus one position,
 *    the running folio's right margin, which places a box against the canvas and sizes
 *    nothing with it (`CANVAS_READERS`). The canvas states the whole frame: the bound, the
 *    centring and the gutters, so no register has to state any of them again.
 */

import { exactly, squash, stating, where, TOKENS, type Rule } from './measure.css.ts';

/** The canvas: the only box on the page that may be wider than the measure (BOOK-88 §2). */
export const CANVAS = '.canvas';

type FramePosition = 'inset' | 'inset-inline' | 'inset-inline-start' | 'inset-inline-end';

/**
 * The one reader of the canvas that is not a box (BOOK-89): the running folio stands in the
 * outer margin, flush with the canvas's inner right edge (1188 at 1440, 366 at 390), and
 * states no width of its own — it is `position: fixed`, with nothing in the text column, so it
 * may change a hundred times without moving a line of prose. Its offset is the canvas's own
 * arithmetic, so it names `var(--column)`; a `width`/`max-width` from the same token is still
 * the bug check 2 is for. A second row is a new decision, like one in `OVERLAYS`.
 */
export const CANVAS_READERS: ReadonlyArray<{ selector: string; property: FramePosition; why: string }> = [
  {
    selector: '.folio',
    property: 'inset-inline-end',
    why: 'the number sits in the margin between the text and the canvas’s edge; a size here would be a box',
  },
];

const COLUMN_VALUE = 'var(--column)';
const GUT_VALUE = 'var(--gut)';

/** Every value a rule states for one property, with the rule it came from, filtered by name. */
const states = (rules: Rule[], selector: string, property: string, value: string): boolean =>
  rules.some((rule) => exactly(rule, selector) && squash(rule.declarations.get(property) ?? '') === squash(value));

/** 1 — the two tokens have one home each, and the retired one is not aliased back. */
export function tokenProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  const list = (entries: Array<{ rule: Rule; value: string }>): string =>
    entries.map((entry) => `${entry.rule.file} ${entry.rule.selector} ${entry.value}`).join('; ') || 'nowhere';

  const column = stating(rules, '--column');
  const [onlyColumn] = column;
  if (column.length !== 1 || onlyColumn === undefined) {
    problems.push(`--column is declared ${column.length} time(s) (${list(column)}) — the canvas has one home, ${TOKENS}`);
  } else if (onlyColumn.rule.file !== TOKENS || onlyColumn.rule.at.length > 0) {
    problems.push(`${where(onlyColumn.rule, '--column', onlyColumn.value)} — ${TOKENS} declares the canvas at the root: it does not narrow`);
  } else if (squash(onlyColumn.value) !== '1000px') {
    problems.push(`--column: ${onlyColumn.value} — the canvas is 1000px`);
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
    problems.push(`${where(entry.rule, '--measure', entry.value)} — the text column has one home, ${TOKENS}`);
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
      `--shell is back (${legacy.length} declaration(s), ${legacyUse.length} use(s)) — BOOK-88 renamed the canvas to --column; two canvas tokens is two frames`,
    );
  }
  return problems;
}

/** 2 — `var(--column)` is the box of `.canvas`, only as a `max-width`; one position may read it. */
export function canvasProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (!value.includes(COLUMN_VALUE)) continue;
      const box = property === 'max-width' && exactly(rule, CANVAS);
      const reader = CANVAS_READERS.find((entry) => entry.property === property && exactly(rule, entry.selector));
      if (!box && reader === undefined) {
        problems.push(
          `${where(rule, property, value)} — var(--column) is the box of ${CANVAS} (the one box allowed to be wider than the text), and only as a max-width`,
        );
      }
    }
  }
  if (!states(rules, CANVAS, 'max-width', COLUMN_VALUE)) {
    problems.push(`${CANVAS} does not state its bound — the canvas is max-width: var(--column)`);
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
    problems.push(`${CANVAS} does not centre the column — margin: 0 auto is the canvas's, and the registers stay flush left inside it`);
  }
  // An exception nobody holds is a rule nobody holds: a stale row must fail too.
  for (const reader of CANVAS_READERS) {
    const held = rules.some(
      (rule) => exactly(rule, reader.selector) && (rule.declarations.get(reader.property) ?? '').includes(COLUMN_VALUE),
    );
    if (!held) {
      problems.push(
        `${reader.selector} { ${reader.property} } does not read var(--column) — a stale canvas-reader exception (${reader.why})`,
      );
    }
  }
  return problems;
}
