import { describe, expect, it } from 'vitest';

import { cascadeRules, definitions, sides, sheets, winning } from './sheets.ts';
import type { ParsedRule } from './sheets.ts';

/**
 * BOOK-92 — the two static documents: one spacing style.
 *
 * The owner's `/rules` screenshot showed the lead indented and narrow while the title and the
 * sections shared one left edge. The cause was a cascade collision, so these guards read the
 * cascade the way the browser does — the declaration that **wins** a selector (the last one in
 * boot order) and how many rules declare it at all — not the first text that matches a name.
 * That was the hole in the first version: `panels.css` loads after `legal.css`, so one appended
 * `26ch` rule re-opened the defect and every test stayed green.
 *
 * Pinned here: the lead is its own class (`.legal .legal-lead`), the kicker and the nav keep the
 * book's label voice, every step is the book's (8 / 12 / 24 / 32), and the lead is the body size
 * — `--fs-lead` belongs to the annotation and the «прицел» sheet (BOOK-DOC-35 §4.1); the legal
 * lead's stature is the standfirst, not one more pixel.
 *
 * Declarations are compared as property → value, so `margin: 0 0 8px 0`, a reordered block or a
 * step split over two rules pass when the geometry is the same; comments are blanked first, so a
 * commented-out rule is not a rule.
 */
describe('BOOK-92 — the legal pages, one spacing style', () => {
  /** Declarations that put the cover's quote back: a `ch` cap narrows, an `auto` side centres. */
  function centring(rule: ParsedRule): string[] {
    const found: string[] = [];
    const maxWidth = rule.declarations['max-width'];
    if (maxWidth !== undefined && (maxWidth === 'auto' || maxWidth.endsWith('ch'))) {
      found.push(`max-width: ${maxWidth}`);
    }
    for (const property of ['margin', 'margin-inline', 'margin-left', 'margin-right']) {
      const value = rule.declarations[property];
      if (value !== undefined && value.split(' ').includes('auto')) found.push(`${property}: ${value}`);
    }
    return found;
  }

  /** The mark declarations a rule is missing, or has lost to another face (BOOK-70, BOOK-92,
   *  BOOK-128 #3900): the legal page's kicker is a mark — mono 12, the quiet ink — never a
   *  serif sentence and never the retired label face. */
  const MARK_VOICE: Record<string, string> = {
    'font-family': 'var(--mono)',
    'font-size': 'var(--fs-micro)',
    color: 'var(--ink-3)',
  };

  function missingVoice(rule: ParsedRule): string[] {
    return Object.entries(MARK_VOICE)
      .filter(([property, value]) => rule.declarations[property] !== value)
      .map(([property, value]) => `${property}: ${value}`);
  }

  /** The `.legal` rules that shout — a specificity fix must not need `!important`. */
  function shouting(rules: ParsedRule[]): string[] {
    return rules
      .filter((rule) => rule.body.includes('!important'))
      .map((rule) => rule.parts.join(', '));
  }

  /** Every `.legal …` rule: the static pages, not `.legal-nav`, `.legal-how` or `.legal-tail`. */
  function legalRules(source: Record<string, string> = sheets): ParsedRule[] {
    return cascadeRules(source).filter((rule) =>
      rule.parts.some((part) => /^\.legal(?![\w-])/u.test(part)),
    );
  }

  /** The rules this task owns: one declaration each, in the whole cascade. */
  const GUARDED = [
    '.legal .legal-lead',
    '.legal .kicker',
    '.legal .title',
    '.legal section',
    '.legal h2',
    '.legal ul',
    '.legal p + p',
    '.legal ul + p',
    '.legal .legal-tail',
    '.legal .legal-nav',
  ];

  it('declares every guarded rule once, so no later sheet can re-open it', () => {
    // Count, sheet and order in one assertion: a second definition in `panels.css` (loaded after
    // `legal.css`) is a failure here, not a silent win — this is the review's major.
    for (const selector of GUARDED) {
      expect(definitions(selector).map((rule) => rule.sheet), selector).toEqual(['legal']);
    }
    // `winning` is the last rule in boot order; with one definition each it is that same rule.
    for (const selector of GUARDED) expect(winning(selector).sheet).toBe('legal');
    // The seeded shape of the re-opened block, and what the guard reports instead of passing:
    // the first match would have been the right one, the winner is the defect.
    const hijacked = {
      legal: '.legal .legal-lead { margin: 0; }',
      panels: '.legal .legal-lead { margin: 0 auto; }',
    };
    expect(definitions('.legal .legal-lead', hijacked).map((rule) => rule.sheet)).toEqual([
      'legal',
      'panels',
    ]);
    expect(winning('.legal .legal-lead', hijacked).sheet).toBe('panels');
  });

  it('sets the lead as the book’s prose, at the body size, never centred', () => {
    const lead = winning('.legal .legal-lead');
    // The body rung, not one step above it: `--fs-lead` is the annotation's (BOOK-DOC-35 §4.1),
    // and the legal lead's stature is the standfirst — italic, `--ink-2`.
    expect(lead.declarations['font-size']).toBe('var(--fs-body)');
    // BOOK-88 merged: the lead states no width of its own — it is one more child of the column,
    // capped by the one prose rule. `none` was the old 664 px text box's "no narrower than the
    // box"; in the 1000 px column it out-specifies `.legal > *` at (0,2,0) v (0,1,0) and runs
    // the whole page. The pin moves to the rule that now owns the lead's width.
    expect(lead.declarations['max-width']).toBeUndefined();
    expect(winning('.legal > *').declarations['max-width']).toBe('var(--measure)');
    expect(sides(lead)).toEqual(['0', '0', '0', '0']);
    expect(lead.declarations['font-family']).toBe('var(--serif)');
    expect(lead.declarations['line-height']).toBe('1.55');
    expect(lead.declarations['font-style']).toBe('italic');
    expect(lead.declarations['color']).toBe('var(--ink-2)');
    expect(lead.declarations['text-wrap']).toBe('pretty');
    expect(centring(lead)).toEqual([]);
  });

  it('rejects a lead narrowed to 26ch or centred by a later sheet, a comment or a longhand', () => {
    // The reviewer's exact case: `legal.css` is right and `panels.css` — loaded after it —
    // re-centres the quote. The count assertion above fails first; the winner is guilty too.
    const hijacked = {
      legal: '.legal .legal-lead { max-width: none; margin: 0; }',
      panels: '.legal .legal-lead { max-width: 26ch; margin: 0 auto; }',
    };
    expect(definitions('.legal .legal-lead', hijacked)).toHaveLength(2);
    expect(centring(winning('.legal .legal-lead', hijacked))).toEqual([
      'max-width: 26ch',
      'margin: 0 auto',
    ]);
    // A commented-out good rule before a live broken one passes a grep, not this scan.
    const commented = {
      legal: [
        '/* .legal .legal-lead { max-width: none; margin: 0; } */',
        '.legal .legal-lead { max-width: 26ch; margin: 0 auto; }',
        '',
      ].join('\n'),
    };
    expect(definitions('.legal .legal-lead', commented).map((rule) => rule.sheet)).toEqual(['legal']);
    expect(centring(winning('.legal .legal-lead', commented))).toEqual([
      'max-width: 26ch',
      'margin: 0 auto',
    ]);
    // A centred longhand and an `auto` cap are the same defect in another spelling.
    expect(
      centring(
        winning('.legal .legal-lead', {
          legal:
            '.legal .legal-lead { max-width: 34ch; margin-top: 0; margin-right: auto; margin-bottom: 0; margin-left: auto; }',
        }),
      ),
    ).toEqual(['max-width: 34ch', 'margin-left: auto', 'margin-right: auto']);
    // And the same geometry, spelled differently, passes: four sides, reordered declarations.
    expect(
      centring(
        winning('.legal .legal-lead', {
          legal: '.legal .legal-lead { color: var(--ink-2); margin: 0 0 0 0; max-width: none; }',
        }),
      ),
    ).toEqual([]);
  });

  it('retires `p.premise` from every sheet and keeps the empty chapter’s `.premise`', () => {
    const parts = cascadeRules(sheets).flatMap((rule) => rule.parts);
    expect(parts.filter((part) => part === 'p.premise')).toEqual([]);
    // The other component of the same name is a 44px field row and owns its own class.
    expect(definitions('.premise').map((rule) => rule.sheet)).toEqual(['seam-form']);
    // The collision does not move: `legal.css`, where the lead's quote lives, keeps no claim on
    // the empty chapter's field — a commented-out rule does not count either.
    expect(
      cascadeRules({ legal: sheets.legal ?? '' })
        .flatMap((rule) => rule.parts)
        .filter((part) => part === '.premise'),
    ).toEqual([]);
    expect(
      cascadeRules({ legal: '/* .premise { margin: 4px 0 0; } */' }).flatMap((rule) => rule.parts),
    ).toEqual([]);
  });

  it('sets the title block, the sections and the lists on the book’s steps', () => {
    const kicker = winning('.legal .kicker');
    expect(sides(kicker)).toEqual(['0', '0', '8px', '0']);
    // The kicker is a mark, not `.legal p`'s serif body: face, size and ink are the mark's
    // (`--mono` at the 12 px floor), and only the declarations `.legal p` would steal are
    // restated here.
    expect(missingVoice(kicker)).toEqual([]);
    expect(kicker.declarations['line-height']).toBe('1.35');
    expect(kicker.declarations['letter-spacing']).toBe('0');

    const title = winning('.legal .title');
    expect(sides(title)).toEqual(['0', '0', '24px', '0']);
    // The measured face of the page title stays: the fix is the rhythm, not the size.
    expect(title.declarations['font-size']).toBe('clamp(28px, 6vw, 40px)');
    expect(title.declarations['line-height']).toBe('1.12');

    // A document's headings are words of the document (BOOK-128 #3900): serif at the body size,
    // lowercase as written, no tracking — never the retired label face.
    const heading = winning('.legal h2');
    expect(sides(heading)).toEqual(['0', '0', '12px', '0']);
    expect(heading.declarations['font-family']).toBe('var(--serif)');
    expect(heading.declarations['font-size']).toBe('var(--fs-body)');
    expect(heading.declarations['letter-spacing']).toBe('0');
    expect(heading.declarations['text-transform']).toBeUndefined();

    expect(winning('.legal section').declarations['margin-top']).toBe('32px');

    // A list is a paragraph too: P→UL and UL→P are the same 12px step, so a list is not a card
    // of its own and the paragraph after it does not read as part of it.
    expect(sides(winning('.legal ul'))).toEqual(['12px', '0', '0', '0']);
    // `ul + p` is found by its own name, not by riding along with `p + p`.
    expect(winning('.legal p + p').declarations['margin-top']).toBe('12px');
    expect(winning('.legal ul + p').declarations['margin-top']).toBe('12px');

    const tail = winning('.legal .legal-tail');
    expect(tail.declarations['margin-top']).toBe('32px');
    expect(tail.declarations['padding-top']).toBe('16px');
    expect(tail.declarations['font-size']).toBe('var(--fs-note)');
    expect(tail.declarations['color']).toBe('var(--ink-2)');
  });

  it('reads a step split over two rules, and refuses a half-declared step', () => {
    // One grouped rule or two: the geometry is the same, so both pass.
    const split = {
      legal: '.legal p + p { margin-top: 12px; } .legal ul + p { margin-top: 12px; }',
    };
    expect(winning('.legal p + p', split).declarations['margin-top']).toBe('12px');
    expect(winning('.legal ul + p', split).declarations['margin-top']).toBe('12px');
    // A half-declared step has no rule for the missing half, so the lookup throws instead of
    // passing quietly — the shape the first version of this guard could not see.
    expect(() => winning('.legal ul + p', { legal: '.legal p + p { margin-top: 12px; }' })).toThrow(
      /no rule declares/u,
    );
  });

  it('rejects a kicker that loses the mark voice to `.legal p`', () => {
    const kicker = (body: string): ParsedRule =>
      winning('.legal .kicker', { legal: `.legal .kicker { ${body} }` });
    // The shape the defect had: a margin only, so `.legal p` owns the face, the size and the ink.
    expect(missingVoice(kicker('margin: 0 0 8px'))).toEqual([
      'font-family: var(--mono)',
      'font-size: var(--fs-micro)',
      'color: var(--ink-3)',
    ]);
    // One stolen declaration at a time is still a finding, and it names the one that is gone.
    expect(
      missingVoice(
        kicker(
          'margin: 0 0 8px; font-family: var(--mono); font-size: var(--fs-micro); color: var(--ink-2)',
        ),
      ),
    ).toEqual(['color: var(--ink-3)']);
    // A sentence's face on a mark is the same defect as a missing one: the label face is
    // retired, so the seed names the serif a coder might reach for instead.
    expect(
      missingVoice(
        kicker(
          'margin: 0 0 8px; font-family: var(--serif); font-size: var(--fs-micro); color: var(--ink-3)',
        ),
      ),
    ).toEqual(['font-family: var(--mono)']);
    // Reordered declarations and a four-value margin are the same kicker.
    expect(
      missingVoice(
        kicker(
          'color: var(--ink-3); font-size: var(--fs-micro); margin: 0 0 8px 0; font-family: var(--mono)',
        ),
      ),
    ).toEqual([]);
    expect(sides(kicker('margin: 0 0 8px 0'))).toEqual(['0', '0', '8px', '0']);
  });

  it('sets the footer nav as a mark, so `.legal p` cannot reset it to a serif body', () => {
    const nav = winning('.legal .legal-nav');
    expect(nav.declarations['margin-top']).toBe('24px');
    expect(nav.declarations['font-family']).toBe('var(--mono)');
    expect(nav.declarations['font-size']).toBe('var(--fs-micro)');
    expect(nav.declarations['letter-spacing']).toBe('0');
    // No case transform: the register is lowercase as written (BOOK-128 #3900 §3).
    expect(nav.declarations['text-transform']).toBeUndefined();
    expect(nav.declarations.display).toBe('flex');
    expect(nav.declarations.gap).toBe('18px');
    // The bare selectors are gone: a `.legal-nav` rule at (0,1,0) loses to `.legal p`.
    expect(
      cascadeRules(sheets)
        .flatMap((rule) => rule.parts)
        .filter((part) => part === '.legal-nav' || part === '.legal-tail'),
    ).toEqual([]);
  });

  it('needs no `!important` anywhere in the legal block', () => {
    const rules = legalRules();
    // The block is there to be read: an empty scan would make the assertion vacuous.
    expect(rules.length).toBeGreaterThan(5);
    expect(shouting(rules)).toEqual([]);
    // The rejection path, on a seeded cascade: a shout is reported by its selector.
    expect(
      shouting(legalRules({ legal: '.legal .legal-tail { color: var(--ink-2) !important; }' })),
    ).toEqual(['.legal .legal-tail']);
    // A comment is not a rule, and a neighbouring class is not the subject.
    expect(
      shouting(
        legalRules({
          legal: [
            '/* .legal .legal-tail { color: var(--ink-2) !important; } */',
            '.legal-how { color: var(--ink-2) !important; }',
            '',
          ].join('\n'),
        }),
      ),
    ).toEqual([]);
  });
});
