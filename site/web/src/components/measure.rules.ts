/**
 * BOOK-88/BOOK-91/BOOK-170 — the sheet checks behind `measure.test.ts`: one column, one canvas,
 * equal margins, one root size.
 *
 * The rule (owner, 2026-10-27, final; BOOK-91; BOOK-170): the column is the reading measure —
 * 640 px at ≥1024, 622 px below, 342 px at 390 — and *every* text block is exactly that box:
 * the TOC, the colophon, the header's rows, the cover, page 2, the discussion, the legal
 * documents and the prose. There is no second frame: the canvas is the column plus its two
 * gutters and centres it, so the same slack sits on both sides (400..1040 in a 368..1072 canvas
 * at 1440; 192..832 in 160..864 at 1024; 73..695 in 41..727 at 768; 24..366 at 390). The prose
 * is not narrower than the column: it *is* the column, so no two blocks can read as two
 * documents.
 *
 * The defect this is built for is a class, not a number: a text block stating a width of its
 * own. Rules are read as text and checked for: the measure and its two steps, the retired
 * `--shell`/`--column` gone for good (1); the canvas as the column plus its gutters, centred,
 * and the folio's one position (2, in `measure.tokens.ts`); every register box exactly the
 * measure, and no other `max-width` but a copy cap, a listed overlay or the one box outside
 * the canvas (3, 4); no register stating an inline padding or a horizontal margin — the canvas
 * owns both (5); every prose selector still named by the one prose rule, which is what pins a
 * future child (6); no declaration value carrying a `rem` length (8), because `rem` follows the
 * reader's root font size and the reading geometry must not. The four-viewport arithmetic, on
 * `tokenPx`, is check 7, in the test. Check 9 (`marginChannelProblems`) is the margin's two
 * objects: the mark is an item of the channel now, so its 40 × 44 target and its edge are held
 * by the same guard as the note's (BOOK-218).
 *
 * Not policed, on purpose: `ch` copy caps (58ch genre/promise, 62ch a chronicle row) bound a
 * sentence, not the page — and the overlays, which are laid over the page and keep their own
 * geometry.
 */

import {
  exactly,
  squash,
  subjectClasses,
  ancestorClasses,
  topLevel,
  where,
  BASE,
  GAUGE,
  type Rule,
} from './measure.css.ts';
import { canvasProblems, tokenProblems, CANVAS, CANVAS_BOUND } from './measure.tokens.ts';

/** The prose block of the design memo §2 — the selectors the one prose rule names. */
export const PROSE = [
  '.p', '.ch-title', '.ch-h', '.sec-h', '.qline', '.front-rule', '.state-line',
  '.annotation .p', '.how-made > p', '.legal > *', '.authors > *',
  '.talks .comments',
  // The consent strip's content block: the notice stands on the column, so its copy and the
  // two hairlines on its edges share the page's one left edge (BOOK-88).
  '.consent-body',
  // BOOK-68/BOOK-88: the seam strip and its stale line are block siblings of the `<p>`
  // (a41932b), so the prose rule has to name them too — otherwise the strip's band and its
  // `.seam-cta` (`margin-left: auto`) stretch across the column above a measure-wide paragraph.
  '.seam', '.p-stale',
  // Two of the chapter register's own surfaces join the memo's list: the placeholder is the
  // *form* of the prose (its bars must stand where the text will), and `.ch-fail` is the
  // chapter's `.state-line` — its retry belongs on the prose's right edge, not the column's.
  '.ch-placeholder', '.ch-fail',
] as const;

/** The registers: every class the markup co-classes with `.page` (BOOK-88 §2). */
export const REGISTERS = [
  'page', 'top-in', 'titul', 'annotation', 'how-made', 'views', 'toc', 'ch', 'talks',
  'authors', 'colophon', 'legal', 'consent', 'chronicle', 'ribbon', 'noscript',
] as const;

/** The boxes that are exactly the text column: `.page`, and the head's second row, which is a
 *  text block inside the header rather than a `.page`. Both state `var(--measure)` as their
 *  `max-width` — the inverted rule of the final frame (the old guard forbade the measure on a
 *  box; it is now the only box a register may be). */
export const COLUMN_BOXES = ['.page', '.ribbon'] as const;

/** One box lives outside the canvas: the no-JS fallback, rendered by `index.html` before
 *  `main.tsx` ever runs, so nothing centres it and nothing supplies its gutters. It may state
 *  the measure plus its own two gutters, centre itself, and pad itself — exactly these three
 *  declarations, each one pinned, and a stale row fails like any other exception. A second row
 *  is a new decision, not a fix. */
export const OUTSIDE_CANVAS: ReadonlyArray<{
  selector: string;
  declarations: ReadonlyArray<readonly [string, string]>;
  why: string;
}> = [
  {
    selector: '.noscript',
    declarations: [
      ['max-width', 'calc(var(--measure) + 2 * var(--gut))'],
      ['margin', '0 auto'],
      ['padding', '64px var(--gut)'],
    ],
    why: 'the fallback is not inside .canvas: nothing centres it and nothing supplies its gutters, so it states the measure plus its own two and centres the result',
  },
];

/** The closed list of box widths that are neither the canvas nor the column nor a `ch` copy
 *  cap. Each row is a design decision with the one reason it may leave the one-column rule;
 *  adding a row is a new decision, not a fix. It is empty now: the focus view's narrower sheet
 *  was the last box laid over the page, and a change is a section of the record. */
export type OverlayRule = { selector: string; property: string; value: string; why: string };

export const OVERLAYS: readonly OverlayRule[] = [];

/**
 * BOOK-218 — the margin channel's two objects, as the sheet must state them. The mark used to be
 * placed by its own component, which is how it ended up on the prose line and over the note
 * above it; it is an item of the ledger now, and its geometry is the channel's contract: both
 * objects start at the prose's right edge — the mark after the air
 * (`left: calc(100% + var(--mark-air, 16px))`), the note one `--note-gap` further out — the mark
 * is a 40 × 44 target at ≥1024 and a 24 × 44 tick below, and neither is fixed or shadowed above
 * 1023. Every token carries the design's number as its fallback (BOOK-208). A row names the
 * selector, the file and its declarations.
 */
export type MarginChannelRule = {
  selector: string;
  file: string;
  declarations: ReadonlyArray<readonly [string, string]>;
  why: string;
};

export const MARGIN_CHANNEL: readonly MarginChannelRule[] = [
  {
    selector: '.filing-mark',
    file: '../styles/marginalia.css',
    declarations: [
      ['position', 'absolute'],
      ['left', 'calc(100% + var(--mark-air, 16px))'],
      ['width', 'var(--mark-hit, 40px)'],
      ['height', '44px'],
      ['margin', '0'],
    ],
    why: 'the mark is an item of the margin channel: absolute at the prose’s right edge, a 40 × 44 target, placed by the ledger',
  },
  {
    selector: '.margin-note',
    file: '../styles/marginalia.css',
    declarations: [
      ['position', 'absolute'],
      ['left', 'calc(100% + var(--note-gap, 56px))'],
      ['width', 'var(--note-fit, var(--note-w, 188px))'],
    ],
    why: 'the note hangs beyond the mark’s target, at the width the channel can hold (BOOK-91)',
  },
];

/** The 1023 px step's overrides: the numeral leaves the text and the target narrows. */
export const MARGIN_CHANNEL_NARROW: readonly MarginChannelRule[] = [
  {
    selector: '.filing-mark',
    file: '../styles/marginalia.css',
    declarations: [
      ['width', '24px'],
      ['padding-left', '2px'],
    ],
    why: 'below 1024 the gutter cannot hold the numeral: the mark is the 24 × 44 tick and the number lives in the strip',
  },
  {
    selector: '.filing-mark-num',
    file: '../styles/marginalia.css',
    declarations: [['display', 'none']],
    why: 'the numeral is painted only where the channel holds it',
  },
];

/** A rule whose subject is the selector, in the given file. */
function rulesOfSelector(rules: Rule[], file: string, selector: string): Rule[] {
  return rules.filter((rule) => rule.file === file && isNamed(rule, selector));
}

/**
 * 9 — the margin channel's geometry (`MARGIN_CHANNEL`, `MARGIN_CHANNEL_NARROW`): every named
 * declaration is in the sheet, the mark is never `position: fixed` or shadowed, and no
 * transition moves its geometry.
 */
export function marginChannelProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const row of [...MARGIN_CHANNEL, ...MARGIN_CHANNEL_NARROW]) {
    const found = rulesOfSelector(rules, row.file, row.selector);
    if (found.length === 0) {
      problems.push(`${row.selector} is not in ${row.file} — ${row.why}`);
      continue;
    }
    for (const [property, value] of row.declarations) {
      const held = found.some((rule) => squash(rule.declarations.get(property) ?? '') === squash(value));
      if (!held) {
        problems.push(`${row.file}: ${row.selector} does not state ${property}: ${value} — ${row.why}`);
      }
    }
  }
  // The prose is the containing block: a positioned sentence span would make `left: 100%` the
  // middle of the line — the mark back on the text.
  if (!rules.some((rule) => exactly(rule, '.p') && squash(rule.declarations.get('position') ?? '') === 'relative')) {
    problems.push('.p does not state position: relative — the channel is measured from the prose’s right edge');
  }
  for (const rule of rules) {
    if (rule.declarations.has('position') && rule.parts.some((part) => squash(part).includes('[data-s]'))) {
      problems.push(`${where(rule, 'position', rule.declarations.get('position') ?? '')} — a sentence span is no containing block: the mark’s left: 100% is the prose’s right edge`);
    }
  }
  for (const selector of ['.filing-mark', '.margin-note']) {
    for (const rule of rulesOfSelector(rules, '../styles/marginalia.css', selector)) {
      const fixed = rule.declarations.get('position');
      if (fixed !== undefined && squash(fixed) === 'fixed') {
        problems.push(`${where(rule, 'position', fixed)} — the margin channel has no fixed layer above 1023`);
      }
      if (rule.declarations.has('box-shadow')) {
        problems.push(`${where(rule, 'box-shadow', rule.declarations.get('box-shadow') ?? '')} — a channel object is not raised above the page`);
      }
      for (const [property, value] of rule.declarations) {
        if (property !== 'transition') continue;
        if (/\b(top|height|width|left|inset)\b/u.test(value)) {
          problems.push(`${where(rule, property, value)} — no transition on the channel's geometry; opacity only, once`);
        }
      }
    }
  }
  return problems;
}

/** The only rules allowed to centre themselves with a horizontal `auto` margin: the canvas
 *  (once) and the one box outside it. `.title-ripple::after` is a 46 px decoration under the
 *  cover title, not a text box. */
const CENTRED = [CANVAS, '.title-ripple::after', ...OUTSIDE_CANVAS.map((row) => row.selector)] as const;

/** What may legitimately narrow a `ch` line: one cap, or one against the parent's width. A
 *  `percentage`/`none` cap is a media cap too (`img { max-width: 100% }`), never a page width. */
const COPY_CAP = /^(?:none|100%|min\(\s*100%\s*,\s*[1-9]\d*ch\s*\)|[1-9]\d*ch)$/u;
/** The measure plus two gutters: the canvas's own bound and the no-JS fallback's box. It is the
 *  canvas now (BOOK-91) — a register inside the canvas is the measure, never this box.
 *  BOOK-128 comment #3815: the paragraph-chain popover is gone (the phrase's facts are a margin
 *  item of the column, not an overlay), so no overlay states this box any more. */
const OUTSIDE_TEXT_BOX = 'calc(var(--measure)+2*var(--gut))';
const MEASURE_VALUE = 'var(--measure)';
const CENTRING = 'only the canvas, the no-JS box and the overlays may centre themselves; the registers stay flush left inside the canvas';

const SIZING = new Set(['width', 'max-width', 'min-width', 'inline-size', 'max-inline-size', 'min-inline-size']);
const MARGINS = new Set(['margin', 'margin-inline', 'margin-inline-start', 'margin-inline-end', 'margin-left', 'margin-right']);
const PADDINGS = new Set(['padding', 'padding-inline', 'padding-inline-start', 'padding-inline-end', 'padding-left', 'padding-right']);
/** A register's own `width` may only be the size it already has; the column is a `max-width`. */
const REGISTER_WIDTH = new Set(['auto', '100%']);

/** Does a shorthand `margin` (or `margin-inline`) centre its box horizontally? Only both sides. */
function centresHorizontally(property: string, value: string): boolean {
  const sides = topLevel(value);
  if (property === 'margin-inline') return sides.length === 1 && sides[0] === 'auto';
  if (property !== 'margin') return false;
  const right = sides[1] ?? sides[0];
  const left = sides.length >= 4 ? sides[3] : (sides[1] ?? sides[0]);
  return right === 'auto' && left === 'auto';
}

/** The horizontal component(s) of a margin declaration; empty for its vertical sides. */
function horizontalSides(property: string, value: string): string[] {
  const sides = topLevel(value);
  const [first = ''] = sides;
  if (property === 'margin-left' || property === 'margin-inline-start') return [first];
  if (property === 'margin-right' || property === 'margin-inline-end') return [first];
  if (property === 'margin-inline') return sides.length >= 2 ? [first, sides[1] ?? first] : [first, first];
  if (property !== 'margin') return [];
  if (sides.length >= 4) return [sides[1] ?? first, sides[3] ?? first];
  if (sides.length >= 2) return [sides[1] ?? first];
  return [first, first];
}

/** The horizontal component of a padding declaration. */
function horizontalPadding(property: string, value: string): string {
  const sides = topLevel(value);
  if (property === 'padding') return sides[1] ?? sides[0] ?? '';
  return sides[0] ?? '';
}

/** A rule whose subject is one of the named selectors, exactly. */
const isNamed = (rule: Rule, selector: string): boolean =>
  rule.parts.some((part) => squash(part) === squash(selector));

/** A rule whose subject compound carries a register class (`.page.sheet`, `.toc`, …). */
const isRegister = (rule: Rule): boolean =>
  rule.parts.flatMap(subjectClasses).some((name) => (REGISTERS as readonly string[]).includes(name));

/** A rule that is the column: exactly `.page` or `.ribbon`. */
const isColumnBox = (rule: Rule): boolean => COLUMN_BOXES.some((selector) => exactly(rule, selector));

/** A rule that is entirely prose selectors (a list of them is fine, anything mixed is not). */
const isProse = (rule: Rule): boolean => rule.parts.every((part) => (PROSE as readonly string[]).includes(part));

/** The `OUTSIDE_CANVAS` row a rule is, when its three declarations are exactly the row's. */
const outsideRow = (rule: Rule) =>
  OUTSIDE_CANVAS.find(
    (row) =>
      exactly(rule, row.selector) &&
      row.declarations.every(([property, value]) => squash(rule.declarations.get(property) ?? '') === squash(value)),
  );

const isAuto = (rule: Rule, property: string): boolean =>
  squash(rule.declarations.get(property) ?? '') === 'auto';

/** 3 — every register is exactly the measure; any other `max-width` is a copy cap, a listed overlay or the one box outside the canvas, and no register states a `width` of its own. */
function boxProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    const rawWidth = rule.declarations.get('width');
    if (rawWidth !== undefined && isRegister(rule) && !REGISTER_WIDTH.has(squash(rawWidth))) {
      problems.push(`${where(rule, 'width', rawWidth)} — a register takes its width from the column, never a width of its own`);
    }
    const raw = rule.declarations.get('max-width');
    if (raw === undefined) continue;
    const value = squash(raw);
    // The canvas's own bound is `measure.tokens.ts`'s check 2: the column plus its gutters.
    if (exactly(rule, CANVAS) && value === squash(CANVAS_BOUND)) continue;
    if (value === MEASURE_VALUE && (isColumnBox(rule) || isProse(rule))) continue;
    // `none` is a copy cap only for a block that is not a register: on a register it removes
    // the column and leaves the canvas's 936 px — the exact defect this file is for.
    if (value === 'none' && isRegister(rule)) {
      problems.push(`${where(rule, 'max-width', raw)} — a register may not drop its column: max-width: none is the canvas's width, not the measure`);
      continue;
    }
    if (COPY_CAP.test(value)) continue;
    if (outsideRow(rule) !== undefined) continue;
    const overlay = OVERLAYS.find(
      (entry) => entry.property === 'max-width' && squash(entry.value) === value && isNamed(rule, entry.selector),
    );
    if (overlay === undefined) {
      problems.push(
        `${where(rule, 'max-width', raw)} — a register is exactly the column (max-width: var(--measure)); the canvas is the column plus its two gutters, and a ch cap is copy, not a page`,
      );
    }
  }
  for (const selector of COLUMN_BOXES) {
    const found = rules.some(
      (rule) => exactly(rule, selector) && squash(rule.declarations.get('max-width') ?? '') === MEASURE_VALUE,
    );
    if (!found) problems.push(`${selector} does not state its box — every register is exactly max-width: var(--measure)`);
  }
  // An exception nobody holds is a rule nobody holds: a stale row must fail too.
  for (const overlay of OVERLAYS) {
    const found = rules.some(
      (rule) => squash(rule.declarations.get(overlay.property) ?? '') === squash(overlay.value) && isNamed(rule, overlay.selector),
    );
    if (!found) {
      problems.push(`${overlay.selector} { ${overlay.property}: ${overlay.value} } is not in the sheets — a stale overlay exception (${overlay.why})`);
    }
  }
  for (const row of OUTSIDE_CANVAS) {
    const held = row.declarations.every(([property, value]) =>
      rules.some((rule) => exactly(rule, row.selector) && squash(rule.declarations.get(property) ?? '') === squash(value)),
    );
    if (!held) {
      problems.push(`${row.selector} does not state its ${row.declarations.length} declarations — a stale outside-canvas exception (${row.why})`);
    }
  }
  return problems;
}

/** 4 — the measure is the column: only `.page`, `.ribbon` and the prose rule state it, only as a `max-width`; the measure-plus-two-gutters box is the canvas's own bound (BOOK-91). */
function measureBoxProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (SIZING.has(property) && value.includes(MEASURE_VALUE)) {
        if (property === 'max-width' && (isColumnBox(rule) || isProse(rule))) continue;
        // The canvas is the column plus its gutters: the one sizing use of the measure that is
        // not the measure itself.
        if (property === 'max-width' && exactly(rule, CANVAS) && squash(value) === squash(CANVAS_BOUND)) continue;
        const overlay = OVERLAYS.find((entry) => entry.property === property && isNamed(rule, entry.selector));
        if (overlay === undefined && outsideRow(rule) === undefined) {
          problems.push(
            `${where(rule, property, value)} — var(--measure) is the column: .page, .ribbon and the prose rule state it, and only as a max-width`,
          );
        }
      }
      if (!squash(value).includes(OUTSIDE_TEXT_BOX)) continue;
      // The canvas's own bound (check 2 pins it): the column plus its gutters, once.
      if (property === 'max-width' && exactly(rule, CANVAS) && squash(value) === squash(CANVAS_BOUND)) continue;
      const overlay = OVERLAYS.find((entry) => squash(entry.value).includes(OUTSIDE_TEXT_BOX) && isNamed(rule, entry.selector));
      if (overlay === undefined && outsideRow(rule) === undefined) {
        problems.push(
          `${where(rule, property, value)} — calc(var(--measure) + 2 * var(--gut)) is the canvas's own box (and the no-JS fallback's): inside the canvas a register is the measure, so it states no such box (BOOK-88)`,
        );
      }
    }
  }
  return problems;
}

/** 5 — the canvas owns the centring and the gutters: no register margin or inline padding, and no descendant re-adds `var(--gut)`. */
function frameProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    const allowed = rule.parts.some((part) => (CENTRED as readonly string[]).includes(part));
    const outside = outsideRow(rule) !== undefined;
    for (const [property, value] of rule.declarations) {
      if (MARGINS.has(property) && centresHorizontally(property, value) && !allowed) {
        problems.push(`${where(rule, property, value)} — ${CENTRING}`);
      }
      // `margin-left: auto` alone is a push to one edge, not a centring; the pair is.
      if (isRegister(rule) && !outside && MARGINS.has(property)) {
        const offCentre = horizontalSides(property, value).find((side) => squash(side) !== '0');
        if (offCentre !== undefined) {
          problems.push(
            `${where(rule, property, value)} — a register's horizontal margin is \`0\` (the column is flush left inside the canvas; the canvas centres once); this sets it to \`${offCentre}\``,
          );
        }
      }
      if (!PADDINGS.has(property)) continue;
      const gutter = horizontalPadding(property, value);
      if (gutter === '') continue;
      const register = isRegister(rule);
      const insideRegister = rule.parts.some((part) =>
        ancestorClasses(part).some((name) => (REGISTERS as readonly string[]).includes(name)),
      );
      if (register && !outside) {
        if (squash(gutter) !== '0') {
          problems.push(`${where(rule, property, value)} — a register states no inline padding (the canvas's gutters are the only ones); its own padding is block-only`);
        }
      } else if (insideRegister && value.includes('var(--gut)')) {
        problems.push(`${where(rule, property, value)} — a descendant of the column re-adds its gutter; the gutters are .canvas's, once`);
      }
    }
    if (!allowed && isAuto(rule, 'margin-left') && isAuto(rule, 'margin-right')) {
      problems.push(`${where(rule, 'margin-left', 'auto')} with margin-right: auto — ${CENTRING}`);
    }
  }
  return problems;
}

/** 6 — every prose selector is still named by the one prose rule in `base.css`. */
function proseProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const selector of PROSE) {
    const capped = rules.some(
      (rule) =>
        rule.file === BASE &&
        squash(rule.declarations.get('max-width') ?? '') === MEASURE_VALUE &&
        rule.parts.some((part) => squash(part) === squash(selector)),
    );
    if (!capped) {
      problems.push(`»${selector}« is prose, but no rule in ${BASE} caps it at var(--measure) — the one prose rule is the only cap`);
    }
  }
  return problems;
}

/** A `rem` length in a declaration value: `40rem`, `1.6rem`, `2REM`, `1e2rem`. The unit is
 *  case-insensitive and a number may carry an exponent; `premise` and `1rem2` are not units. */
const REM_LENGTH = /(?<![\w.])(?:[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)rem\b/iu;

/** 8 — no declaration value carries a `rem` length. The design's lengths are absolute: the
 *  column, the gutters and the type are px, and the only relative cap is a `ch` copy cap; a
 *  `rem` would follow the reader's root font size and move the reading geometry under them. */
export function rootScaleProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (REM_LENGTH.test(value)) {
        problems.push(
          `${where(rule, property, value)} — a rem follows the reader's root font size; the reading geometry is px and a copy cap is ch`,
        );
      }
    }
  }
  return problems;
}

/** Every way one parsed sheet set fails to hold the one column. */
export function layoutProblemsOf(rules: Rule[]): string[] {
  return [
    ...tokenProblems(rules),
    ...canvasProblems(rules),
    ...boxProblems(rules),
    ...measureBoxProblems(rules),
    ...frameProblems(rules),
    ...proseProblems(rules),
    ...marginChannelProblems(rules),
    ...rootScaleProblems(rules),
  ];
}

/**
 * One token as a number of px, read from parsed rules. `narrow` reads the ≤1023 step of
 * `tokens.css`, `phone` the ≤599 block of `base.css` — the two places a token narrows.
 */
export function tokenPxOf(
  rules: Rule[],
  name: string,
  options: { query?: 'narrow' | 'phone'; file?: string } = {},
): number {
  const entry = rules.find(
    (rule) =>
      rule.declarations.has(name) &&
      rule.parts.some((part) => squash(part) === ':root') &&
      rule.at.length === (options.query === undefined ? 0 : 1) &&
      (options.query === 'phone'
        ? rule.at.some((query) => squash(query).includes('max-width:599px'))
        : true) &&
      (options.file === undefined || rule.file === options.file),
  );
  const raw = entry?.declarations.get(name) ?? '0';
  return raw.endsWith('rem') ? Number.parseFloat(raw) * GAUGE : Number.parseFloat(raw);
}
