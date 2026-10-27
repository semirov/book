#!/usr/bin/env node
/**
 * scripts/styles.mjs — the type floor and the adaptive regime (BOOK-DOC-35 §7, AC3/AC4/AC6).
 *
 * Rules over `web/src/styles/*.css`, checked without a build and without a browser:
 *
 *   1. the token ladder is closed and guarded where it is defined. Only the six `--fs-*` rungs
 *      exist, each must resolve to ≥12px, and a token that cannot be resolved (a `calc()` over
 *      an unknown variable, an `em` with no known parent) fails rather than passes silently.
 *      A removed rung may not come back under a new name: `--fs-nano` is a failure even when
 *      its value is 12px, because the ladder is the contract, not the number.
 *   2. no `font-size` literal below 12px, in px or rem (rem is resolved against the root size,
 *      which is measured from `html`/`:root`, default 16). `calc()` is evaluated when every
 *      operand is known; `clamp()` passes on its minimum; anything else must be listed as a
 *      documented exception (the design's own allowed list).
 *   3. the `font:` shorthand is read too: `font: 11px/1.4 …` sets the size without a
 *      `font-size` declaration and used to slip through.
 *   4. no `@media (min-width: …)`. The regime is adaptive: the base rules are the desktop
 *      layout and every query narrows. `min-width: 0` as a property is not a query.
 *   5. no spinner and no shimmer anywhere in the sheet set (BOOK-DOC-43 §5, chrome.css:173):
 *      a wait is a sentence and a form with blank fields, never a moving gradient — so
 *      `shimmer`, `spinner` and `background-position` are all problems, comments excluded.
 *   6. a skeleton rule declares no motion of its own but the one 120 ms fade in, and only as
 *      the whole shorthand (`animation: skel-in var(--dur-tick) var(--ease-out) both`). A
 *      rule is a skeleton rule when any selector's **last compound** carries the `.skel`
 *      class — `.focus-stage .skel-sheet`, `.page > .skel`, `.skel-line::before` all count.
 *      Every other `animation*` declaration is a problem, named longhand or a future one:
 *      a longhand overrides the shorthand, and that is how a loop or a longer pulse gets in.
 *
 * `styleProblems(dir)` is pure; `arch.mjs` prints it and the test seeds one violation of each
 * kind to prove the failure path. Reading a sheet is `css.mjs`'s job (comments blanked, rule
 * bodies, selectors, sizes); this file only judges what was read.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { declarationsOf, lineAt, reaches, ruleBodies, toPx, withoutComments } from './css.mjs';

/** The floor for every label, counter and meta line (BOOK-DOC-35 §4.1). */
export const MIN_FONT_PX = 12;

/** The ladder is the design's whole type scale: 12 / 13 / 14 / 15 → 18 / 19. */
export const LADDER = Object.freeze({
  '--fs-micro': 12,
  '--fs-label': 13,
  '--fs-meta': 14,
  '--fs-note': 15,
  '--fs-body': 18,
  '--fs-lead': 19,
});

/** Relative sizes that the design allows by name (BOOK-DOC-35 §4.3), not a general escape. */
const DOCUMENTED_RELATIVE = new Set(['0.86em']);

/**
 * BOOK-70 — the chips this pass defines, plus the reference lines the guard can prove, and the
 * one fact each is allowed to state. The registry is the contract: a chip that loses its rule,
 * its size, its voice or its ink fails the build, so the rules of the two audits (form and
 * truth) cannot rot quietly. It is not a census of every styled span in the app: a surface
 * nobody audited yet is not silently blessed by being left out either — it is simply out of
 * this pass.
 *
 * The discussion's queue line (`.qline`) is **not** a chip and is not registered: it is a data
 * line that carries a sentence beside it («правки идут по одной, в порядке записи»), and a chip
 * never carries a second voice.
 *
 * BOOK-112 removed the header's `.live` chip from the reading surface: the state it stated
 * (writing, revising, paused, the last entry's day, «глав ещё нет») belongs to panels, the
 * chronicle and the end matter. The registry no longer lists it — a rule that no surface may
 * print cannot be kept alive as a chip.
 *
 * `tier` decides which checks apply:
 *
 *   - `state` — one fact, one word or one short clause: 12 px label, one of two inks, one line;
 *   - `count` — a number with its noun, and never a zero: same form as `state`;
 *   - `ref`   — a record numeral, a count or a moment: 12 px mono, tabular, `.02em`, one line;
 *   - `sentence` — a clause or a receipt that no chip can hold: 14 px, sentence case, may wrap.
 */
export const CHIP_SELECTORS = Object.freeze([
  { selector: '.ch-print', tier: 'state', fact: 'this chapter is printing now' },
  { selector: '.sec-meta', tier: 'count', fact: 'how many filings there are — or «замечаний нет»' },
  { selector: '.seam-filing-n', tier: 'ref', fact: 'the filing’s own record suffix («№A7K»)' },
  { selector: '.author-plus', tier: 'ref', fact: 'how many readers’ text survived («+ 3»)' },
  { selector: '.seam-filing-stamp', tier: 'ref', fact: 'the moment a filing was made («25.10, 12:04»)' },
  { selector: '.stamp-time', tier: 'ref', fact: 'the moment a decision or a note was recorded' },
  { selector: '.ch-data', tier: 'ref', fact: 'a written chapter’s length and the moment it was last written' },
  { selector: '.stamp-state', tier: 'state', fact: 'one word for where a change stands' },
  { selector: '.filing-state', tier: 'state', fact: 'one word for where a filing stands' },
  {
    selector: '.filing-sentence',
    tier: 'sentence',
    fact: 'a filing state that is a clause, or a receipt naming the chapter it entered and the right that moved with it',
  },
]);

/** A chip of this pass is 12 px, to the pixel: 11 is unreadable and 13 is a second size. */
const CHIP_PX = 12;
/** A sentence is the meta rung (BOOK-DOC-35 §4.1): 14 px, the book's voice, and it may wrap. */
const SENTENCE_PX = 14;

/** Absolute size keywords: a legal `font:` component that renders ≈9–11 px, never provable. */
const SIZE_KEYWORD = /\b(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller)\b/u;

/**
 * Every spelling of a `min-width` query: `(min-width: 600px)`, `screen and (min-width: …)`,
 * the range form `(width >= 600px)` and its mirror `(600px <= width)`. `max-width` queries and
 * the `min-width: 0` property are not queries and pass.
 */
const MIN_WIDTH_QUERY = /@media[^{]*?\(\s*(?:min-width\s*[:)]|width\s*>=\s*\d|\d[\d.]*\w*\s*<=\s*width)/u;
/** BOOK-DOC-43 §5: the motion vocabulary a wait may not use. `background-position` is the
 * moving gradient a hand-built shimmer needs. */
const BANNED_MOTION = [
  ['shimmer', 'shimmer — a placeholder never animates time passing; it is a static form with blank fields (BOOK-DOC-43 §5)'],
  ['spinner', 'spinner — a failing fetch is a sentence and a retry, never a spinner (chrome.css:173, BOOK-DOC-43 §5)'],
  ['background-position', 'background-position — a moving gradient is a shimmer built by hand (BOOK-DOC-43 §5)'],
];
/** A `.skel` class in a compound: `.skel`, `.skel-line`, `.skel-chapter`. */
const SKEL_CLASS = /\.skel(?:-[\w-]+)?(?![-\w])/u;

/** The one legal motion in a skeleton rule, whitespace-normalised. */
const SKEL_FADE = 'skel-in var(--dur-tick) var(--ease-out) both';

/**
 * The last compound of a selector — `.page > .skel-line::before` → `.skel-line`.
 *
 * A skeleton selector is recognised by the compound it styles, not by where it starts: a
 * descendant (`.focus-stage .skel-sheet`), a child (`.page > .skel`) and a pseudo-element
 * (`.skel-line::before`) are all the skeleton's rule, and the guard used to miss the first
 * two. Combinators and whitespace split the compounds; a trailing `::part` / `:state` (with
 * its own parentheses) is dropped, because it is the element the compound names.
 */
function lastCompound(selector) {
  const parts = selector.split(/[\s>+~]+/u).filter((part) => part.length > 0);
  const last = parts.at(-1) ?? '';
  return last.replace(/(?:::?[a-z-]+(?:\([^()]*\))?)+$/iu, '');
}

/** Every selector in a rule's list whose last compound carries the skeleton's class. */
function isSkeletonRule(selector) {
  return selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => part.length > 0 && SKEL_CLASS.test(lastCompound(part)));
}

const CSS_RULE = /([^{}]+)\{([^{}]*)\}/gu;
const ANIMATION_DECLARATION = /([a-z-]*animation[a-z-]*)\s*:\s*([^;}]+)/gu;
const TOKEN = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/gu;
const FS_TOKEN = /--fs-[a-z0-9-]+/u;
const FONT_SIZE = /font-size\s*:\s*([^;}]+)/gu;
const FONT_SHORTHAND = /(?:^|[\s;{])font\s*:\s*([^;}]+)/gu;
const ROOT_SIZE = /(?:^|[\s;{}])(?:html|:root)\s*\{[^}]*?font-size\s*:\s*([\d.]+)px/gu;

/** The file a `--fs-*` rung may live in: the scale is defined once, in the tokens sheet. */
const TOKENS_FILE = 'tokens.css';

/**
 * @param {string} stylesDir the directory holding `tokens.css`, `base.css`, …
 * @param {{ requireChips?: boolean }} [options] `requireChips` is the real-tree mode: every
 *   registered chip must have a rule even when the set carries no chip at all, so deleting the
 *   whole registry fails instead of passing through the fixture hatch.
 * @returns {Array<{ file: string; line: number; message: string }>}
 */
export function styleProblems(stylesDir, { requireChips = false } = {}) {
  /** @type {Array<{ file: string; line: number; message: string }>} */
  const problems = [];
  const names = readdirSync(stylesDir)
    .filter((name) => name.endsWith('.css'))
    .sort();
  // Comments are blanked before anything is scanned: a commented-out rule is not a rule, and
  // its length is kept so the reported line still points at the sheet.
  const files = names.map((name) => ({ name, path: join(stylesDir, name), css: withoutComments(readFileSync(join(stylesDir, name), 'utf8')) }));

  /** The root size every `rem` resolves against. */
  let rootPx = 16;
  for (const { css } of files) {
    for (const match of css.matchAll(ROOT_SIZE)) {
      const size = Number(match[1]);
      if (Number.isFinite(size) && size > 0) rootPx = size;
    }
  }

  /**
   * Every custom property in the sheet set, not only `--fs-*`: `--type-micro: 9px` used as
   * `font-size: var(--type-micro, 12px)` renders 9 px, and the fallback never applies.
   */
  const tokens = new Map();
  for (const { css } of files) {
    for (const match of css.matchAll(TOKEN)) tokens.set(match[1], match[2]);
  }

  const report = (file, css, index, message) => problems.push({ file, line: lineAt(css, index), message });

  for (const { name, path, css } of files) {
    for (const match of css.matchAll(TOKEN)) {
      const index = match.index ?? 0;
      const [raw, token, value] = match;
      if (!FS_TOKEN.test(token)) continue;
      if (name !== TOKENS_FILE) {
        report(path, css, index, `${token} is declared outside ${TOKENS_FILE} — the ladder has one home`);
        continue;
      }
      if (!(token in LADDER)) {
        report(path, css, index, `${token} is not on the type ladder — a removed rung may not return`);
        continue;
      }
      const px = toPx(value, tokens, rootPx);
      if (px === null) report(path, css, index, `${token}: ${value.trim()} cannot be proven ≥${MIN_FONT_PX}px`);
      else if (px < MIN_FONT_PX) report(path, css, index, `${token} resolves to ${px}px, below the ${MIN_FONT_PX}px floor`);
    }

    for (const [pattern, kind] of [
      [FONT_SIZE, 'font-size'],
      [FONT_SHORTHAND, 'font'],
    ]) {
      for (const match of css.matchAll(pattern)) {
        const index = match.index ?? 0;
        const raw = match[1].trim();
        // The shorthand carries its size as the component with a unit; `font: inherit` has none.
        const numeric = /(\d*\.?\d+(?:px|rem|em|%))(?:\s*\/\s*[\d.]+\w*)?/u.exec(raw)?.[1];
        const keyword = SIZE_KEYWORD.exec(raw)?.[0];
        // A `font-size` value is the whole declaration; a shorthand's size is one component.
        const size = kind === 'font-size' ? raw : (numeric ?? keyword);
        if (size === undefined) continue;
        if (DOCUMENTED_RELATIVE.has(size)) continue;
        const px = toPx(size, tokens, rootPx);
        if (px === null) report(path, css, index, `${kind}: ${size} cannot be proven ≥${MIN_FONT_PX}px`);
        else if (px < MIN_FONT_PX) report(path, css, index, `${kind}: ${size} is ${px}px, below the ${MIN_FONT_PX}px floor`);
      }
    }

    const query = MIN_WIDTH_QUERY.exec(css);
    if (query !== null) {
      report(path, css, query.index, '@media min-width query — the base is the desktop; narrow with max-width (BOOK-DOC-35 §3)');
    }

    // 5 — no spinner, no shimmer: a wait is a sentence and a form with blank fields.
    for (const [token, message] of BANNED_MOTION) {
      for (const match of css.matchAll(new RegExp(token, 'giu'))) {
        report(path, css, match.index ?? 0, message);
      }
    }

    // 6 — a skeleton rule owns one fade in and nothing else. The selector is the text before
    // its `{`, so `@keyframes skel-in` itself is not a skeleton rule; and the rule is a
    // skeleton's when the *last compound* of any selector is, which is what `isSkeletonRule`
    // reads (a descendant or a pseudo-element is no alibi).
    for (const rule of css.matchAll(CSS_RULE)) {
      const [, selector, body] = rule;
      if (!isSkeletonRule(selector)) continue;
      const bodyAt = (rule.index ?? 0) + selector.length + 1;
      for (const declaration of body.matchAll(ANIMATION_DECLARATION)) {
        const property = declaration[1];
        const value = declaration[2].replace(/\s+/gu, ' ').trim();
        const at = bodyAt + (declaration.index ?? 0);
        if (property === 'animation') {
          if (value !== SKEL_FADE) {
            report(path, css, at, `animation: ${value} — a .skel rule admits only «${SKEL_FADE}», the one 120 ms fade in (BOOK-DOC-43 §5)`);
          }
        } else {
          // Every longhand, the ones CSS has today and any future one: a longhand overrides
          // the shorthand, and that is how a loop or a longer pulse gets in.
          report(path, css, at, `${property}: ${value} — the shorthand «${SKEL_FADE}» is the only motion a placeholder owns; a longhand such as ${property} overrides it (BOOK-DOC-43 §5)`);
        }
      }
    }
  }

  // ── BOOK-70 — the chips ──────────────────────────────────────────────────────────────────
  // Declarations are merged from every rule that *reaches* the registered selector, so a chip
  // cannot dodge the guard by moving its size somewhere else: the exact selector, a grouped
  // list (`.live, .brand`), a compound (`.live.idle`, `.live:hover`, `.live[data-x]`) and a
  // functional pseudo (`:is(.live, …)`, `:where(…)`, `:not(…)`) all count. A class that merely
  // starts with the same letters (`.livewire`) does not: the selector must end at a boundary.
  //
  // A `@media` body is merged exactly like the base rule, by design: the base is the desktop
  // and every query narrows, so a chip keeps one size in every query — and if a query ever
  // changes a chip's size, the merged value is what the guard checks (last declaration wins).
  // A chip whose size differs between the base and a query is therefore a finding, not a pass.
  //
  // A later rule wins inside a sheet, and the sheets are read in report order. The line
  // reported is the last rule that contributed, which is the chip's own.
  const chips = new Map(CHIP_SELECTORS.map((chip) => [chip.selector, { declarations: new Map(), file: '', line: 1 }]));
  for (const { path, css } of files) {
    for (const rule of ruleBodies(css)) {
      for (const selector of rule.selectors) {
        const entry = [...chips.entries()].find(([registered]) => reaches(selector, registered))?.[1];
        if (entry === undefined) continue;
        entry.file = path;
        entry.line = rule.line;
        for (const [property, value] of declarationsOf(rule.body)) entry.declarations.set(property, value);
      }
    }
  }

  // A sheet set that carries no chip at all is a fixture, not the app, so a two-file seed does
  // not report eleven absences and prove nothing. `requireChips` is the real-tree mode
  // (`arch.mjs`): there, an absent rule is a finding even when every chip is gone — otherwise
  // deleting the whole registry would be the way to pass.
  const anyChip = [...chips.values()].some((entry) => entry.file !== '');

  for (const chip of CHIP_SELECTORS) {
    const { selector, tier } = chip;
    const entry = chips.get(selector);
    const declarations = entry.declarations;
    if (entry.file === '') {
      if (anyChip || requireChips) {
        problems.push({
          file: stylesDir,
          line: 1,
          message: `${selector}: a registered chip has no rule in the sheets — the BOOK-70 registry cannot outlive the rule`,
        });
      }
      continue;
    }
    /** Report against the chip's own rule, named by the selector so the message stands alone. */
    const fail = (message) => problems.push({ file: entry.file, line: entry.line, message: `${selector}: ${message}` });

    const size = declarations.get('font-size');
    const wantPx = tier === 'sentence' ? SENTENCE_PX : CHIP_PX;
    /** «a state chip» / «a sentence» — the message names the form the rule must hold. */
    const what = tier === 'sentence' ? 'a sentence' : `a ${tier} chip`;
    if (size === undefined) {
      fail(`${what} declares its own font-size — the size is one`);
    } else {
      const px = toPx(size, tokens, rootPx);
      if (px === null) fail(`font-size: ${size} cannot be proven to be ${wantPx}px`);
      else if (px !== wantPx) fail(`font-size: ${size} resolves to ${px}px, but ${what} is ${wantPx}px`);
    }

    if (tier === 'ref') {
      if (declarations.get('font-family') !== 'var(--mono)') fail('a reference chip is mono — font-family: var(--mono)');
      const spacing = declarations.get('letter-spacing') ?? '';
      if (!/^0?\.02em$/u.test(spacing)) fail(`a reference chip is set at .02em, not ${spacing || 'the inherited spacing'}`);
      if (declarations.get('font-variant-numeric') !== 'tabular-nums') fail('a reference chip is tabular');
    }

    if (tier === 'state' || tier === 'count') {
      const ink = declarations.get('color');
      if (ink !== 'var(--live)' && ink !== 'var(--ink-3)') {
        fail(`a chip's ink is var(--live) or var(--ink-3), not ${ink ?? 'inherited'}`);
      }
    }

    if (tier !== 'sentence' && declarations.get('white-space') !== 'nowrap') {
      fail('a chip takes one line — white-space: nowrap');
    }
    if (declarations.has('animation')) fail('a chip never animates — no animation');
    if (declarations.has('transition')) fail('a chip never animates — no transition');
    if (declarations.get('text-overflow') === 'ellipsis') fail('a chip is never ellipsized — an ellipsized state is a lie');
    if (declarations.has('overflow') && declarations.get('overflow') !== 'visible') {
      fail('a chip may not clip its own line — overflow would hide the fact it states');
    }
  }

  // Files are already sorted; within a file, read the sheet top to bottom.
  return problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
