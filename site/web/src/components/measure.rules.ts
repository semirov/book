/**
 * BOOK-88 — the six checks behind `measure.test.ts`: one column, one prose block, one left edge.
 *
 * The rule (owner, 2026-10-27): the page is a single column, up to 1000 px on the desktop and
 * adaptive on the mobile by its gutters alone. Every register — header, cover, page 2, the TOC,
 * the chronicle, the colophon, the discussion, the legal documents — lives in that column and
 * shares one left edge, and the prose keeps its measure inside it, flush left.
 *
 * The defect this is built for is a class, not a number: a later sheet stating a width of its
 * own (`.page.sheet { max-width: … }`, `.legal { max-width: calc(measure + gutters);
 * margin: 0 auto }`). Rules are read as text and checked for: the two tokens and their homes
 * (1, and `--shell` gone for good); `var(--column)` as the box of the column only (2); every
 * other `max-width` being the prose measure, a copy cap or a listed overlay, and no register
 * stating a `width` of its own (3); the measure never sizing a non-prose box and the old text
 * box `calc(measure + 2 gutters)` surviving only in `.chain` (4); no self-centring, one
 * horizontal margin per register (and it is `auto`), exactly one gutter per register (5);
 * every prose selector actually capped by the one prose rule (6). The four-viewport
 * arithmetic, on `tokenPx`, is check 7, in the test.
 *
 * Not policed, on purpose: `ch` copy caps (58ch genre/promise, 62ch a chronicle row) bound a
 * sentence, not the page — and the overlays, which are laid over the page and keep their own
 * geometry.
 */

import {
  squash,
  subjectClasses,
  ancestorClasses,
  topLevel,
  where,
  BASE,
  GAUGE,
  type Rule,
} from './measure.css.ts';
import { columnProblems, tokenProblems } from './measure.tokens.ts';

/** The prose block of the design memo §2 — the only selectors capped at the measure. */
export const PROSE = [
  '.p', '.ch-title', '.ch-h', '.sec-h', '.qline', '.front-rule', '.state-line',
  '.annotation .p', '.how-made > p', '.legal > *', '.authors > *',
  '.talks .comments', '.talks .talks-list',
  // The consent strip's content block: the notice stands on the prose measure, so its copy
  // and the two hairlines on its edges share the page's one left edge (BOOK-88).
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

/** The closed list of box widths that are neither the column nor a `ch` copy cap. Each row is
 *  a design decision with the one reason it may leave the one-column rule; adding a row is a
 *  new decision, not a fix. Both are overlays laid *over* the page, not registers in it. */
export const OVERLAYS = [
  {
    selector: '.focus-stage',
    property: 'max-width',
    value: '590px',
    why: 'the прицел’s lit sheet is its own narrower paper over the page (BOOK-DOC-35 §7)',
  },
  {
    selector: '.chain',
    property: 'width',
    value: 'min(calc(var(--measure) + 2 * var(--gut)), 100%)',
    why: 'the paragraph-chain popover is anchored to a tapped phrase, not laid out in the page',
  },
] as const;

/** The only rules allowed to centre themselves with a horizontal `auto` margin — the column and
 *  the overlays. `.consent` is a `.page` (a column) that states its vertical margins as a
 *  shorthand, so it also has to restate `auto` on the inline sides. `.title-ripple::after` is a
 *  46 px decoration under the cover title, not a text box. */
const CENTRED = ['.page', '.ribbon', '.noscript', '.consent', '.focus-stage', '.title-ripple::after'] as const;

/** What may legitimately narrow a `ch` line: one cap, or one against the parent's width. A
 *  `percentage`/`none` cap is a media cap too (`img { max-width: 100% }`), never a page width. */
const COPY_CAP = /^(?:none|100%|min\(\s*100%\s*,\s*[1-9]\d*ch\s*\)|[1-9]\d*ch)$/u;
/** The old text box (measure + two gutters), which is what `.legal` and `.state-line` used to
 *  state for themselves: inside the column it lands their text two gutters too far right. */
const OLD_TEXT_BOX = 'calc(var(--measure)+2*var(--gut))';
const COLUMN_VALUE = 'var(--column)';
const MEASURE_VALUE = 'var(--measure)';
const CENTRING = 'only the column and the overlays may centre themselves; prose stays flush left';

const SIZING = new Set(['width', 'max-width', 'min-width', 'inline-size', 'max-inline-size', 'min-inline-size']);
const MARGINS = new Set(['margin', 'margin-inline', 'margin-inline-start', 'margin-inline-end', 'margin-left', 'margin-right']);
const PADDINGS = new Set(['padding', 'padding-inline', 'padding-inline-start', 'padding-inline-end', 'padding-left', 'padding-right']);
/** A register's own `width` may only be the column, or the size it already has. */
const REGISTER_WIDTH = new Set(['auto', '100%', COLUMN_VALUE]);

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

const isAuto = (rule: Rule, property: string): boolean =>
  squash(rule.declarations.get(property) ?? '') === 'auto';

/** 3 — every `max-width` is the column, the prose measure, a copy cap or a listed overlay; no
 *  register states a `width` of its own (a wider register by `width: 700px` is the same bug). */
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
    if (value === COLUMN_VALUE) continue; // columnProblems owns this one
    if (value === MEASURE_VALUE) {
      const outside = rule.parts.filter((part) => !(PROSE as readonly string[]).includes(part));
      if (outside.length > 0) {
        problems.push(`${where(rule, 'max-width', raw)} — the measure is the prose block, never a box: ${outside.join(', ')} may not shrink to it`);
      }
      continue;
    }
    if (COPY_CAP.test(value)) continue;
    const overlay = OVERLAYS.find(
      (entry) => entry.property === 'max-width' && squash(entry.value) === value && isNamed(rule, entry.selector),
    );
    if (overlay === undefined) {
      problems.push(
        `${where(rule, 'max-width', raw)} — a box is the column (var(--column)), the prose measure (var(--measure)) or a ch copy cap; anything else is a box of its own`,
      );
    }
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
  return problems;
}

/** 4 — the measure never sizes a box that is not prose, and the old text box is overlay-only. */
function measureBoxProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (SIZING.has(property) && property !== 'max-width' && value.includes(MEASURE_VALUE)) {
        const overlay = OVERLAYS.find((entry) => entry.property === property && isNamed(rule, entry.selector));
        if (overlay === undefined) {
          problems.push(`${where(rule, property, value)} — var(--measure) is text width, never the width of a box`);
        }
      }
      if (!squash(value).includes(OLD_TEXT_BOX)) continue;
      const overlay = OVERLAYS.find((entry) => squash(entry.value).includes(OLD_TEXT_BOX) && isNamed(rule, entry.selector));
      if (overlay === undefined) {
        problems.push(
          `${where(rule, property, value)} — calc(var(--measure) + 2 * var(--gut)) is the old text box: inside the column it lands the text two gutters past the column's left edge (BOOK-88)`,
        );
      }
    }
  }
  return problems;
}

/** 5 — nothing centres itself but the column and the overlays; a register's horizontal margin is
 *  `auto`; one gutter, not two. */
function frameProblems(rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    const allowed = rule.parts.some((part) => (CENTRED as readonly string[]).includes(part));
    for (const [property, value] of rule.declarations) {
      if (MARGINS.has(property) && centresHorizontally(property, value) && !allowed) {
        problems.push(`${where(rule, property, value)} — ${CENTRING}`);
      }
      // `margin-left: auto` alone is a push to one edge, not a centring; the pair is.
      if (isRegister(rule) && MARGINS.has(property)) {
        const offCentre = horizontalSides(property, value).find((side) => squash(side) !== 'auto');
        if (offCentre !== undefined) {
          problems.push(
            `${where(rule, property, value)} — a register's horizontal margin is \`auto\` (the column centres once, in .page); this sets it to \`${offCentre}\``,
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
      if (register) {
        if (squash(gutter) !== 'var(--gut)') {
          problems.push(`${where(rule, property, value)} — a register keeps exactly the column's one gutter (var(--gut)); it may not drop it or state another`);
        }
      } else if (insideRegister && value.includes('var(--gut)')) {
        problems.push(`${where(rule, property, value)} — a descendant of the column re-adds its gutter; the gutters are .page's, once`);
      }
    }
    if (!allowed && isAuto(rule, 'margin-left') && isAuto(rule, 'margin-right')) {
      problems.push(`${where(rule, 'margin-left', 'auto')} with margin-right: auto — ${CENTRING}`);
    }
  }
  return problems;
}

/** 6 — every prose selector is capped by the one prose rule in `base.css`. */
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

/** Every way one parsed sheet set fails to hold the one column. */
export function layoutProblemsOf(rules: Rule[]): string[] {
  return [
    ...tokenProblems(rules),
    ...columnProblems(rules),
    ...boxProblems(rules),
    ...measureBoxProblems(rules),
    ...frameProblems(rules),
    ...proseProblems(rules),
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
