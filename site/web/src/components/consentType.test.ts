import { describe, expect, it } from 'vitest';

import { CONSENT_COPY } from '../lib/consent.ts';
import { blankComments, rulesOf, squash, type Rule, type SheetSet } from './measure.css.ts';
import { BASE, PROSE, TOKENS, layoutProblems, replaced, seeded, sheets, tokenPx } from './measure.guard.ts';

/**
 * BOOK-88 — the consent strip carries two type registers, not three.
 *
 * The rule (owner, screenshot; BOOK-128 #3900): the sentence is prose at `--fs-note`; the two
 * buttons and the privacy link are one action register — `--fs-micro` in `--mono`, lowercase as
 * written, no tracking — the book's mark voice, never a browser default. The primary differs
 * from the secondary in ink alone (`--ink` vs `--ink-3`), and every action keeps a 44 px tap
 * target where the row wraps.
 *
 * This file reads `consent.css` as text: the strip's declarations are resolved per selector in
 * file order, so the evidence is the cascade a browser would apply, not a line the author meant
 * to write. Seeded third sizes, a bare button and a nameless block prove the checks fire.
 */

const SHEET = '../styles/consent.css';

/** The strip's own vocabulary. Anything else in the sheet belongs to `/privacy` or the colophon. */
const STRIP = ['consent', 'consent-body', 'consent-copy', 'consent-actions', 'consent-choice', 'consent-link'] as const;
const ELSEWHERE = ['consent-line', 'consent-state', 'analytics-change'] as const;

/** Exactly two sizes: the promise's, and the action register's floor. */
const SIZES = { sentence: 'var(--fs-note)', action: 'var(--fs-micro)' } as const;
/** The one voice of an action. A different family, size or tracking is a second register. */
const REGISTER = ['font-family', 'font-size', 'letter-spacing'] as const;

const classesOf = (rule: Rule): string[] =>
  rule.parts.flatMap((part) => [...part.matchAll(/\.([\w-]+)/gu)].map((match) => match[1] ?? ''));

const isStrip = (rule: Rule): boolean => {
  const classes = classesOf(rule);
  if (classes.some((name) => (ELSEWHERE as readonly string[]).includes(name))) return false;
  return classes.some((name) => (STRIP as readonly string[]).includes(name));
};

function stripRules(set: SheetSet): Rule[] {
  const css = set[SHEET];
  if (css === undefined) throw new Error(`${SHEET} is not a sheet`);
  return rulesOf(SHEET, blankComments(css)).filter(isStrip);
}

/** The declarations a browser ends up with per selector: later rules win, as in the cascade. */
function resolvedFrom(rules: Rule[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const rule of rules) {
    for (const part of rule.parts) {
      const key = squash(part);
      const declarations = out.get(key) ?? new Map<string, string>();
      for (const [property, value] of rule.declarations) declarations.set(property, value);
      out.set(key, declarations);
    }
  }
  return out;
}

const resolved = (set: SheetSet): Map<string, Map<string, string>> => resolvedFrom(stripRules(set));

const declared = (set: SheetSet, selector: string): Map<string, string> =>
  resolved(set).get(squash(selector)) ?? new Map<string, string>();

/** Does one rule *aimed at this selector* state the property itself (not inherit it)? */
const stated = (set: SheetSet, selector: string, property: string): boolean =>
  stripRules(set).some(
    (rule) => rule.parts.some((part) => squash(part) === squash(selector)) && rule.declarations.has(property),
  );

const fontSizes = (set: SheetSet): string[] => [
  ...new Set(
    stripRules(set).flatMap((rule) => {
      const value = rule.declarations.get('font-size');
      return value === undefined ? [] : [value];
    }),
  ),
];

/** A tracking value in em, or NaN when it is not a relative one. `0` is zero, whatever the unit. */
const trackingEm = (value: string | undefined): number => {
  if (value === undefined) return Number.NaN;
  if (value === '0') return 0;
  return value.endsWith('em') ? Number.parseFloat(value) : Number.NaN;
};

/** The px of a `min-height`, or NaN. */
const px = (value: string | undefined): number =>
  value !== undefined && value.endsWith('px') ? Number.parseFloat(value) : Number.NaN;

/**
 * The px a `font-size` really resolves to: a `var(--fs-*)` token is read from `tokens.css`, a
 * literal is parsed. Two names are not two sizes — the register is a rendered height, and a
 * token that drifts changes the page without changing a single rule.
 */
function pixelSize(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const token = /^var\((--[\w-]+)\)$/u.exec(value)?.[1];
  if (token !== undefined) return tokenPx(token, { file: TOKENS });
  return px(value);
}

/** /privacy's own consent line: the strip's action row, rendered on the legal page. */
const LEGAL_ACTIONS = '.consent-actions';
const LEGAL_CHOICE = '.consent-choice';
const LEGAL_STATE = '.consent-state';

/** Every way the strip's typography leaves its two registers. Pure, so a seed goes through it. */
function typeProblems(set: SheetSet): string[] {
  const problems: string[] = [];
  const sizes = fontSizes(set);

  for (const value of sizes) {
    if (value !== SIZES.sentence && value !== SIZES.action) {
      problems.push(
        `consent.css: a third size in the strip — font-size: ${value}; the strip has exactly two: ${SIZES.sentence} for the sentence and ${SIZES.action} for the actions`,
      );
    }
  }
  for (const wanted of [SIZES.sentence, SIZES.action]) {
    if (!sizes.includes(wanted)) problems.push(`consent.css: the strip lost its ${wanted} size — one of the two registers is missing`);
  }

  const copy = declared(set, '.consent-copy');
  const actions = declared(set, '.consent-actions');

  // Resolved, not named: the notice's sentence is the larger of the two registers in px.
  const sentencePx = pixelSize(copy.get('font-size'));
  const actionPx = pixelSize(actions.get('font-size'));
  if (!(sentencePx > actionPx)) {
    problems.push(
      `consent.css: the sentence resolves to ${sentencePx}px and the action to ${actionPx}px — the sentence is the larger register, whatever the tokens are called`,
    );
  }

  if (copy.get('font-size') !== SIZES.sentence) {
    problems.push(`consent.css: the sentence is ${SIZES.sentence} (the promise's size), not ${copy.get('font-size') ?? 'nothing'}`);
  }
  if (copy.has('max-width')) {
    problems.push(
      `consent.css: .consent-copy caps itself (${copy.get('max-width') ?? ''}) — the notice stands on the prose measure, not on a second reading column`,
    );
  }
  if (actions.get('font-family') !== 'var(--mono)') {
    problems.push('consent.css: the actions are not in var(--mono) — the book action voice is the mono mark register');
  }
  // The mark register is lowercase as written (BOOK-128 #3900 §3): a case transform is a second
  // voice, and the guard names it rather than the caps it would print.
  if (actions.has('text-transform')) {
    problems.push(
      `consent.css: the actions declare text-transform: ${actions.get('text-transform') ?? ''} — the mark register is lowercase as written`,
    );
  }
  if (trackingEm(actions.get('letter-spacing')) !== 0) {
    problems.push(
      `consent.css: the actions declare tracking (got ${actions.get('letter-spacing') ?? 'nothing'}) — the mark register is set at 0`,
    );
  }

  // The UA sheet resets the tracking on a form control, so an inherited value never arrives: the
  // button has to state it itself, or its label reads as a browser default.
  if (!stated(set, '.consent-choice', 'letter-spacing')) {
    problems.push(
      "consent.css: .consent-choice does not state letter-spacing — Chrome's UA sheet resets it on a form control, so the action falls out of the register",
    );
  }
  for (const selector of ['.consent-choice', '.consent-link'] as const) {
    const rule = declared(set, selector);
    // A case transform on an action is the retired register returning (BOOK-128 #3900 §3).
    if (rule.has('text-transform')) {
      problems.push(
        `consent.css: ${selector} declares text-transform: ${rule.get('text-transform') ?? ''} — the mark register is lowercase as written`,
      );
    }
    for (const property of REGISTER) {
      if (rule.get(property) !== actions.get(property)) {
        problems.push(
          `consent.css: ${selector} ${property} is ${rule.get(property) ?? 'nothing'}, the actions are ${actions.get(property) ?? 'nothing'} — size, weight and family never separate the actions`,
        );
      }
    }
    if (!(px(rule.get('min-height')) >= 44)) {
      problems.push(
        `consent.css: ${selector} has a ${rule.get('min-height') ?? '0px'} tap target — an action needs 44 px where the row wraps`,
      );
    }
    if (rule.get('display') !== 'inline-flex' || rule.get('align-items') !== 'center') {
      problems.push(
        `consent.css: ${selector} is not an inline-flex box with a centred label — the 44 px target would not hold the text on the line`,
      );
    }
    if (rule.get('font-weight') !== undefined && rule.get('font-weight') !== '400') {
      problems.push(`consent.css: ${selector} changes the weight (${rule.get('font-weight') ?? ''}) — the register is one weight`);
    }
  }

  // Ink alone: --ink for «Разрешить», --ink-3 for «Только необходимое» and the privacy link.
  if (declared(set, '.consent-choice').get('color') !== 'var(--ink)') {
    problems.push('consent.css: the primary action is not var(--ink)');
  }
  const secondary = declared(set, '.consent-choice + .consent-choice');
  if (secondary.get('color') !== 'var(--ink-3)') {
    problems.push('consent.css: the secondary action is not var(--ink-3)');
  }
  const inkOnly = [...secondary.keys()].filter((property) => property !== 'color');
  if (inkOnly.length > 0) {
    problems.push(
      `consent.css: the secondary action differs by more than ink — it also states ${inkOnly.join(', ')}; size, weight and family are shared`,
    );
  }
  if (declared(set, '.consent-link').get('color') !== 'var(--ink-3)') {
    problems.push('consent.css: the privacy link is not var(--ink-3)');
  }
  return problems;
}

/**
 * /privacy, not the strip: `LegalPage` renders the same `.consent-actions` row inside a
 * `.consent-line`, with the two buttons and a `.consent-state` between them. One line carries
 * one action register, so the state states it itself — and the checks read `consent.css`, the
 * sheet that actually styles the line: a selector that moved out of it fails the test instead
 * of passing over an empty map.
 */
function legalProblems(set: SheetSet): string[] {
  const problems: string[] = [];
  const sheet = rulesOf(SHEET, blankComments(set[SHEET] ?? ''));
  const resolvedLine = resolvedFrom(sheet);

  for (const selector of [LEGAL_ACTIONS, LEGAL_CHOICE, LEGAL_STATE] as const) {
    if (!resolvedLine.has(squash(selector))) {
      problems.push(
        `consent.css: ${selector} has no rule in the sheet that renders /privacy's consent line — the check would read an empty map`,
      );
    }
  }

  const row = resolvedLine.get(squash(LEGAL_ACTIONS)) ?? new Map<string, string>();
  const choice = resolvedLine.get(squash(LEGAL_CHOICE)) ?? new Map<string, string>();
  const state = resolvedLine.get(squash(LEGAL_STATE)) ?? new Map<string, string>();
  for (const property of REGISTER) {
    if (state.get(property) !== row.get(property)) {
      problems.push(
        `consent.css: /privacy's .consent-state ${property} is ${state.get(property) ?? 'nothing'}, its actions are ${row.get(property) ?? 'nothing'} — the line carries one action register`,
      );
    }
  }
  if (pixelSize(state.get('font-size')) !== pixelSize(choice.get('font-size'))) {
    problems.push(
      `consent.css: /privacy's .consent-state resolves to ${pixelSize(state.get('font-size'))}px and its buttons to ${pixelSize(choice.get('font-size'))}px — the same register is the same size`,
    );
  }
  if (state.get('color') !== 'var(--ink-3)') {
    problems.push(
      `consent.css: /privacy's .consent-state ink is ${state.get('color') ?? 'nothing'} — a state is var(--ink-3); ink alone separates it from an action`,
    );
  }
  return problems;
}

describe('the consent strip carries two type registers (BOOK-88)', () => {
  it('resolves both sizes to px, not just to token names', () => {
    // The check above compares names; this one compares what a browser paints: 15 px of PT
    // Serif against 12 px of PT Mono. A token that drifts (or a literal posing as one) fails
    // here even though every rule still names a token.
    expect({
      sentence: pixelSize(declared(sheets, '.consent-copy').get('font-size')),
      action: pixelSize(declared(sheets, '.consent-actions').get('font-size')),
      note: tokenPx('--fs-note', { file: TOKENS }),
      micro: tokenPx('--fs-micro', { file: TOKENS }),
    }).toEqual({ sentence: 15, action: 12, note: 15, micro: 12 });
  });

  it('holds them on the real tree', () => {
    expect(typeProblems(sheets)).toEqual([]);
    // The two registers really are the two of the sheet: one sentence, one action voice.
    expect(fontSizes(sheets).sort()).toEqual([SIZES.action, SIZES.sentence].sort());
    // Nothing inherits a size from elsewhere: every strip rule names one of the two.
    expect(fontSizes(sheets).every((value) => value === SIZES.sentence || value === SIZES.action)).toBe(true);
  });

  it('is prose on the prose measure, capped by the one prose rule and never centred', () => {
    expect(PROSE).toContain('.consent-body');
    // No box of its own: the cap is `base.css`'s, so consent.css states no max-width for it.
    expect(declared(sheets, '.consent-body').has('max-width')).toBe(false);
    const base = rulesOf(BASE, blankComments(sheets[BASE] ?? ''));
    expect(
      base.some(
        (rule) =>
          rule.parts.some((part) => squash(part) === '.consent-body') &&
          squash(rule.declarations.get('max-width') ?? '') === 'var(--measure)',
      ),
    ).toBe(true);
    expect(layoutProblems(sheets)).toEqual([]);
  });

  it('still reads as two lines at the wider measure, not four', () => {
    // The strip is prose at 15 px on the column; at 640 a line holds at least 640 / (0.5 × 15)
    // = 85 characters, so the 126-character notice still takes two lines — the old 600 px
    // column already did, and a wider one cannot add a line. It is not one line either.
    const perLine = Math.floor(640 / (0.5 * 15));
    expect(perLine).toBe(85);
    expect(Math.ceil(CONSENT_COPY.length / perLine)).toBe(2);
    expect(CONSENT_COPY.length).toBeGreaterThan(perLine);
  });

  it('fires on a third size in the strip', () => {
    // The seeded violation: a third rung (14 px) on the section itself. The strip may not borrow
    // a size from anywhere else in the book.
    const third = typeProblems(seeded(SHEET, '.consent { font-size: var(--fs-meta); }'));
    expect(third).toContain(
      'consent.css: a third size in the strip — font-size: var(--fs-meta); the strip has exactly two: var(--fs-note) for the sentence and var(--fs-micro) for the actions',
    );
  });

  it('fires when the secondary action brings a size of its own', () => {
    const divergent = typeProblems(seeded(SHEET, '.consent-choice + .consent-choice { font-size: var(--fs-meta); }'));
    expect(divergent.some((problem) => problem.includes('a third size in the strip'))).toBe(true);
    expect(divergent.some((problem) => problem.includes('the secondary action differs by more than ink'))).toBe(true);
  });

  it('fires when a button stops stating the register, or states the old one', () => {
    // A later rule putting the UA values back: the property is stated, and wrong.
    const bare = typeProblems(seeded(SHEET, '.consent-choice { letter-spacing: normal; }'));
    expect(bare.some((problem) => problem.includes('.consent-choice letter-spacing is normal, the actions are 0'))).toBe(true);

    // The row itself declaring tracking is the same defect, named as the register's own rule.
    const row = typeProblems(seeded(SHEET, '.consent-actions { letter-spacing: 0.1em; }'));
    expect(row.some((problem) => problem.includes('the mark register is set at 0'))).toBe(true);

    // A case transform is the retired register returning: named, not silently printed.
    const shout = typeProblems(seeded(SHEET, '.consent-choice { text-transform: uppercase; }'));
    expect(
      shout.some((problem) => problem.includes('.consent-choice declares text-transform: uppercase')),
    ).toBe(true);

    // And the real bug: the declaration is simply not on the button (only on the row), which the
    // cascade hides — `stated` is what catches it.
    const inherited = typeProblems(
      replaced(SHEET, 'letter-spacing: 0;\n  text-decoration: underline;', 'text-decoration: underline;'),
    );
    expect(
      inherited.some((problem) =>
        problem.includes('.consent-choice does not state letter-spacing'),
      ),
    ).toBe(true);
  });
});

describe('/privacy carries the same one action register (BOOK-88)', () => {
  it('holds it on the real tree, in the sheet that styles the line', () => {
    expect(legalProblems(sheets)).toEqual([]);
    // The evidence is `consent.css` itself, and the state is in the same register as the row
    // and the buttons it sits between — not inherited from the legal page's label voice.
    const state = resolvedFrom(rulesOf(SHEET, blankComments(sheets[SHEET] ?? ''))).get(squash(LEGAL_STATE));
    expect(state?.get('font-family')).toBe('var(--mono)');
    expect(state?.get('font-size')).toBe('var(--fs-micro)');
    // Lowercase as written: no case transform at all (BOOK-128 #3900 §3).
    expect(state?.has('text-transform')).toBe(false);
    expect(trackingEm(state?.get('letter-spacing'))).toBe(0);
    expect(state?.get('color')).toBe('var(--ink-3)');
  });

  it('fires when the state falls back to a page voice', () => {
    // The reported defect, re-seeded with the canon's own two faces: the serif at 0.08em beside
    // two 12 px PT Mono buttons at 0 — two voices on one line.
    const fallback = legalProblems(
      seeded(SHEET, '.consent-state { font-family: var(--serif); letter-spacing: 0.08em; }'),
    );
    expect(fallback).toContain(
      "consent.css: /privacy's .consent-state font-family is var(--serif), its actions are var(--mono) — the line carries one action register",
    );
    expect(
      fallback.some((problem) => problem.includes('.consent-state letter-spacing is 0.08em, its actions are 0')),
    ).toBe(true);
  });

  it('fires when a later rule changes the state ink or its size', () => {
    const ink = legalProblems(seeded(SHEET, '.consent-state { color: var(--ink); }'));
    expect(ink.some((problem) => problem.includes('.consent-state ink is var(--ink)'))).toBe(true);

    const size = legalProblems(seeded(SHEET, '.consent-state { font-size: var(--fs-meta); }'));
    expect(size.some((problem) => problem.includes('.consent-state font-size is var(--fs-meta)'))).toBe(true);
    expect(size.some((problem) => problem.includes('resolves to 14px and its buttons to 12px'))).toBe(true);
  });

  it('fires when the sheet read is not the one that styles the line', () => {
    // The guard is only as good as the sheet it reads: a selector that left `consent.css` must
    // fail loudly, not quietly check an empty map.
    const missing = legalProblems(replaced(SHEET, '.consent-state {', '.consent-state-x {'));
    expect(missing).toContain(
      "consent.css: .consent-state has no rule in the sheet that renders /privacy's consent line — the check would read an empty map",
    );
    expect(missing.some((problem) => problem.includes('.consent-state font-family is nothing'))).toBe(true);
  });
});
