import { describe, expect, it } from 'vitest';

import { blankComments, exactly, rulesOf } from './measure.css.ts';
import { tokenPxOf } from './measure.rules.ts';
import {
  BASE,
  CANVAS_BOUND,
  COLUMN_BOXES,
  FOLIO_INSET,
  OUTSIDE_CANVAS,
  PROSE,
  REGISTER_COMPONENTS,
  TOKENS,
  canvasWrapperProblems,
  cascade,
  components,
  layoutProblems,
  markupProblems,
  replaced,
  seeded,
  sheets,
  tokenPx,
} from './measure.guard.ts';

/** The declarations of the one rule in a sheet whose selector is exactly `selector`. */
function declarationsIn(file: string, selector: string): Map<string, string> {
  return rulesOf(file, blankComments(sheets[file] ?? '')).find((rule) => exactly(rule, selector))?.declarations
    ?? new Map();
}

/**
 * BOOK-88/BOOK-91 — one column, one canvas, equal margins.
 *
 * The rule and the checks it is built from are documented in `measure.guard.ts`,
 * `measure.tokens.ts` and `measure.rules.ts`; this file is the evidence that they hold on the
 * real tree, that the owner's arithmetic table comes out of the tokens alone, and that each
 * class of violation is really red. A guard nobody has seen fire is a comment.
 */

describe('the page has one column (BOOK-88/BOOK-91)', () => {
  it('reads every stylesheet of the cascade main.tsx boots', () => {
    // The guard is only as wide as the set it reads: every sheet of the cascade is here, and
    // every sheet here is in the cascade — an orphan file cannot slip past the check.
    expect(cascade).toEqual(Object.keys(sheets).sort());
    expect(cascade).toContain(TOKENS);
  });

  it('holds the one column and the one prose block on the real tree', () => {
    // The seed-free run: any register stating its own width, any re-added gutter, any centred
    // measure — from any sheet, in any query — fails here.
    expect(layoutProblems(sheets)).toEqual([]);
  });

  it('renders every branch inside the one canvas', () => {
    // The canvas is the only element that states the bound, the centring and the gutters: a
    // branch rendered beside it (or the wrapper dropped) would leave the column unstated.
    expect(canvasWrapperProblems()).toEqual([]);
    expect(canvasWrapperProblems('<div id="root"></div><App />')).toContain(
      'main.tsx does not render a <div className="canvas"> — nothing states the column’s bound, centring and gutters',
    );
    // A branch outside the div is the same defect one step in.
    expect(
      canvasWrapperProblems('<div className="canvas"><App /></div><LegalPage page={page} />'),
    ).toContain('main.tsx renders <LegalPage page={page} /> outside .canvas — that branch is not the column');
  });

  it('centres the column with equal margins, from the tokens alone', () => {
    const measure = tokenPx('--measure', { file: TOKENS });
    const measureNarrow = tokenPx('--measure', { query: 'narrow', file: TOKENS });
    const gutter = tokenPx('--gut');
    const phoneGutter = tokenPx('--gut', { query: 'phone', file: BASE });
    // The numbers the whole table rests on: a 640 / 622 px column, 32 / 24 px of gutter.
    // Read from the sheets, so a drifted token fails here and not in a screenshot.
    expect({ measure, measureNarrow, gutter, phoneGutter }).toEqual({
      measure: 640,
      measureNarrow: 622,
      gutter: 32,
      phoneGutter: 24,
    });

    // The frame at a viewport: the canvas is the column plus its two gutters, centred, and the
    // column is that box minus the gutters, capped by the viewport. BOOK-91: the slack is the
    // same on both sides of the text — all 368 px of it used to sit on the right at 1440.
    const round = (value: number): number => Math.round(value * 10) / 10;
    const frame = (viewport: number, gut: number, width: number): [number, number, number, number] => {
      const canvas = Math.min(viewport, width + 2 * gut);
      const canvasLeft = (viewport - canvas) / 2;
      const canvasRight = viewport - canvasLeft;
      const columnLeft = canvasLeft + gut;
      const columnWidth = Math.min(width, canvasRight - canvasLeft - 2 * gut);
      return [round(canvasLeft), round(canvasRight), round(columnLeft), round(columnLeft + columnWidth)];
    };

    // viewport, gutter, measure — the owner's four widths, as canvas L/R and column L/R.
    const table = [
      [390, phoneGutter, measureNarrow],
      [768, gutter, measureNarrow],
      [1024, gutter, measure],
      [1440, gutter, measure],
    ] as const;
    for (const [viewport, gut, width] of table) {
      const [canvasLeft, canvasRight, left, right] = frame(viewport, gut, width);
      // Equal margins, at every width: the column's left margin is its right margin.
      expect(left, `${viewport}px`).toBeCloseTo(viewport - right, 6);
      expect(canvasRight - canvasLeft).toBeCloseTo(Math.min(viewport, width + 2 * gut), 6);
    }

    // The owner's rects, pinned: 24..366 at 390, 73..695 in a 41..727 canvas at 768,
    // 192..832 in 160..864 at 1024, 400..1040 in 368..1072 at 1440.
    expect(frame(390, phoneGutter, measureNarrow)).toEqual([0, 390, 24, 366]);
    expect(frame(768, gutter, measureNarrow)).toEqual([41, 727, 73, 695]);
    expect(frame(1024, gutter, measure)).toEqual([160, 864, 192, 832]);
    expect(frame(1440, gutter, measure)).toEqual([368, 1072, 400, 1040]);

    // The folio's right edge is the column's right edge + 20 px wherever it is in the margin
    // (≥768): inset (100% − measure) / 2 − 20 from the viewport's right.
    for (const [viewport, gut, width] of table.filter(([viewport]) => viewport >= 768)) {
      const [, , , right] = frame(viewport, gut, width);
      const folioRight = viewport - ((viewport - width) / 2 - 20);
      expect(folioRight).toBeCloseTo(right + 20, 6);
    }
  });

  it('names the canvas, the folio’s one position and the one box outside it', () => {
    // The exceptions are data, and the seed-free run above proves the tree holds them; this
    // pins the shape, so a future edit widens the list on purpose or not at all.
    const folio = declarationsIn('../styles/live.css', '.folio');
    expect(folio.get('position')).toBe('fixed');
    expect(folio.get('pointer-events')).toBe('none');
    expect(folio.get('font-size')).toBe('var(--fs-micro)');
    expect(folio.get('inset-inline-end')).toBe(FOLIO_INSET);
    expect(declarationsIn(BASE, '.canvas').get('max-width')).toBe(CANVAS_BOUND);
    expect(OUTSIDE_CANVAS.map((row) => row.selector)).toEqual(['.noscript']);
    expect(COLUMN_BOXES).toEqual(['.page', '.ribbon']);
  });

  it('puts the folio on the running head’s first-row baseline, not at 40vh', () => {
    // The number's top is the head's first-row baseline, taken from the head's own geometry and
    // the shipped fonts (hhea per 1000 em: PT Mono 885/−235): `.top-in` starts row 1 at 14 px;
    // this 12 px PT Mono line carries its own baseline (16.2 − 1.12 × 12) / 2 + 0.885 × 12 = 12
    // down its 16.2 px box, and the head's row box leaves it starting at 15.598 ≈ 15.6. The
    // 15.6 is the pinned declaration below; the derivation only has to agree with the font.
    const folio = declarationsIn('../styles/live.css', '.folio');
    const head = declarationsIn('../styles/chrome.css', '.top-in');
    const rowTop = Number.parseFloat(head.get('padding-top') ?? '0');
    const micro = tokenPx('--fs-micro', { file: TOKENS });
    const baselineInFolio = (1.35 * micro - 1.12 * micro) / 2 + 0.885 * micro;
    expect({ rowTop, micro }).toEqual({ rowTop: 14, micro: 12 });
    expect(baselineInFolio).toBeCloseTo(12, 6);
    expect(folio.get('line-height')).toBe('1.35');
    expect(folio.get('top')).toBe('calc(env(safe-area-inset-top) + 15.6px)');
    // 768–1023: the narrow head states 11 px, and the number follows it (11.598 → 12.6).
    const narrowFolio = rulesOf('../styles/live.css', blankComments(sheets['../styles/live.css'] ?? '')).find(
      (rule) => exactly(rule, '.folio') && rule.at.length === 1,
    );
    expect(narrowFolio?.declarations.get('top')).toBe('calc(env(safe-area-inset-top) + 12.6px)');
  });
});

describe('the TOC row is a register like every other (BOOK-88, BOOK-89)', () => {
  it('closes the page cell on the row’s own right edge, and fits at 390', () => {
    const link = declarationsIn('../styles/live.css', '.toc-link');
    const page = declarationsIn('../styles/live.css', '.toc-page');
    // BOOK-89: the page cell ends on the prose axis. The row *is* the column since the final
    // frame, so the old `100% − measure` inset is a no-op — it is gone, and the cell closes on
    // the row's own right edge, which is the paragraph's. Every row is this one link now
    // (owner, 2026-10-28): the `.toc-line` stub a dead row used to be no longer exists.
    expect(link.has('padding-inline-end')).toBe(false);
    expect(link.get('grid-template-columns')).toBe('36px minmax(0, 1fr) 3ch');
    expect(link.get('min-height')).toBe('44px');
    expect(link.get('padding')).toBe('10px 0');
    expect(page.get('inline-size')).toBe('3ch');
    expect(page.get('white-space')).toBe('nowrap');
    // The leaf and the leader at 390: 390 − 2 × 24 = 342 px of column, and the fixed tracks —
    // the 36 px numeral, two 14 px gaps and the 3ch page slot at the 12 px mono (0.6 em) —
    // leave the title 256 px, so neither the leaf nor the dotted leader is squeezed.
    const gap = Number.parseFloat(link.get('column-gap') ?? '0');
    const micro = tokenPx('--fs-micro', { file: TOKENS });
    expect({ gap, micro }).toEqual({ gap: 14, micro: 12 });
    expect(390 - 2 * tokenPx('--gut', { query: 'phone', file: BASE }) - (36 + 2 * gap + 3 * 0.6 * micro)).toBeCloseTo(256.4, 1);
    // BOOK-91: the wider column only adds room to the title cell — 640 at 1440 leaves 554.4,
    // 622 at 768 leaves 536.4 — so the row still fits with the leader at every width.
    for (const [width, title] of [[640, 554.4], [622, 536.4]] as const) {
      expect(width - (36 + 2 * gap + 3 * 0.6 * micro)).toBeCloseTo(title, 1);
    }
  });
});

describe('the markup keeps every register a .page', () => {
  it('pins each register component by name and its class string', () => {
    expect(REGISTER_COMPONENTS).toHaveLength(13);
    expect(markupProblems()).toEqual([]);
  });

  it('fires when a register component drops `page` from its own class string', () => {
    const file = './TableOfContents.tsx';
    const source = components[file] ?? '';
    const dropped = { ...components, [file]: source.replace('page sheet toc', 'sheet toc') };
    expect(dropped[file]).not.toBe(source);
    expect(markupProblems(dropped)).toContain(
      `${file} no longer carries \`page toc\` in one className — the register would leave the column`,
    );
  });
});

describe('the guard fires on every class of violation it names', () => {
  it('a second home for the measure, or a retired frame back', () => {
    const measure = layoutProblems(seeded(BASE, ':root { --measure: 33.75rem; }'));
    expect(measure.some((problem) => problem.startsWith('--measure is declared 3 time(s)'))).toBe(true);
    expect(measure.some((problem) => problem.includes('the text column has one home'))).toBe(true);

    // BOOK-91: both retired frame tokens fail as a declaration, not only as a use.
    const column = layoutProblems(seeded(TOKENS, ':root { --column: 1000px; }'));
    expect(column.some((problem) => problem.startsWith('--column is back (1 declaration(s)'))).toBe(true);

    const legacy = layoutProblems(seeded(TOKENS, ':root { --shell: 1000px; }'));
    expect(legacy.some((problem) => problem.startsWith('--shell is back (1 declaration(s)'))).toBe(true);

    // The historical line itself, `.page.sheet` back on the retired canvas token: red twice —
    // the token is gone, and the register states a box that is not the measure.
    const alias = layoutProblems(seeded(BASE, '.page.sheet { max-width: var(--shell); }'));
    expect(alias.some((problem) => problem.startsWith('--shell is back (0 declaration(s), 1 use(s))'))).toBe(true);
    expect(alias.some((problem) => problem.includes('.page.sheet { max-width: var(--shell) }'))).toBe(true);
  });

  it('a rem length back in the geometry (BOOK-170)', () => {
    // The size the reader's browser sets is theirs; the line must not follow it. `replaced`,
    // not `seeded`: the 40rem has to be the sheet's *only* `--measure`, or `tokenPxOf` finds
    // the px step first and the rem branch below is never reached.
    const set = replaced(TOKENS, '--measure: 640px;', '--measure: 40rem;');
    expect(layoutProblems(set)).toContain(
      `${TOKENS}: :root { --measure: 40rem } — a rem follows the reader's root font size; the reading geometry is px and a copy cap is ch`,
    );

    // The rem branch is load-bearing: `40 × 16` is the design's 640 px, so drop that branch and
    // this reads 40. The guard refuses the unit, not the value.
    const columns = rulesOf(TOKENS, blankComments(set[TOKENS] ?? ''));
    expect(tokenPxOf(columns, '--measure', { file: TOKENS })).toBe(640);
  });

  it('reads a rem in any case, and as an exponent, as a rem (BOOK-170)', () => {
    // CSS units are case-insensitive and a number may carry an exponent: neither spelling may
    // walk past check 8, and neither may be invented by a word that merely starts like one.
    const upper = layoutProblems(seeded('../styles/live.css', '.toc { padding: 2REM 0; }'));
    expect(upper).toContain(
      `../styles/live.css: .toc { padding: 2REM 0 } — a rem follows the reader's root font size; the reading geometry is px and a copy cap is ch`,
    );

    const exponent = layoutProblems(seeded('../styles/live.css', '.toc { outline-offset: 1e2rem; }'));
    expect(exponent.some((problem) => problem.includes('.toc { outline-offset: 1e2rem }'))).toBe(true);

    // A word is not a unit: `premise` and a number with a word suffix (`1rem2`) stay silent.
    const words = layoutProblems(seeded('../styles/live.css', '.toc { content: "premise 1rem2"; }'));
    expect(words.filter((problem) => problem.includes('premise 1rem2'))).toEqual([]);
  });

  it('retires the canvas token: no rule may read it, and the folio keeps its one inset', () => {
    // BOOK-91: `--column` is gone with the 1000 px frame. A rule reading it is the second frame
    // one step in — whether it asks for a size or for a position.
    const sized = layoutProblems(seeded('../styles/live.css', '.folio { width: var(--column); }'));
    expect(sized.some((problem) => problem.includes('.folio { width: var(--column) } — var(--column) is retired'))).toBe(true);

    const borrowed = layoutProblems(seeded('../styles/live.css', '.seam { inset-inline-end: var(--column); }'));
    expect(borrowed.some((problem) => problem.includes('.seam { inset-inline-end: var(--column) }'))).toBe(true);

    // The folio's inset is held by the tree, not by the comment: its right edge must stay
    // 20 px outside the column's (column right + 20, from the viewport's right half).
    const stale = layoutProblems(replaced('../styles/live.css', '(100% - var(--measure)) / 2 - 20px', '0px'));
    expect(stale.some((problem) => problem.includes('.folio { inset-inline-end: calc(0px) }'))).toBe(true);
    expect(stale.some((problem) => problem.includes("the number's right edge is 20px outside the column's"))).toBe(true);
  });

  it('the canvas that drops its bound, its gutters or its centring', () => {
    // The three declarations are what makes the column sit at 400 inside the 704 px canvas at
    // 1440; a canvas missing one of them silently falls back to the viewport.
    const noBound = layoutProblems(replaced(BASE, 'max-width: calc(var(--measure) + 2 * var(--gut));', 'max-width: var(--measure);'));
    expect(noBound.some((problem) => problem.includes('.canvas does not state its bound'))).toBe(true);

    const noGutters = layoutProblems(replaced(BASE, 'padding-inline: var(--gut);', 'padding-inline: 0;'));
    expect(noGutters.some((problem) => problem.includes('does not state padding-inline: var(--gut)'))).toBe(true);

    const noCentring = layoutProblems(replaced(BASE, 'margin-inline: auto;', 'margin-inline: 0;'));
    expect(noCentring.some((problem) => problem.includes('.canvas does not centre the column'))).toBe(true);
  });

  it('a register that states its own width, from a later sheet or as a literal', () => {
    // The BOOK-88 regression: a later sheet re-widening a register past the column. The frame
    // token is not available to a register any more — that is the final frame's whole point.
    const sheet = layoutProblems(seeded('../styles/live.css', '.page.sheet { max-width: var(--column); }'));
    expect(sheet.some((problem) => problem.includes('— var(--column) is retired'))).toBe(true);

    const literal = layoutProblems(seeded('../styles/live.css', '.toc { max-width: 1000px; }'));
    expect(literal.some((problem) => problem.includes('a register is exactly the column (max-width: var(--measure))'))).toBe(true);

    // BOOK-91's measure is 640: a register one pixel wider than the column is still a register
    // outside it, and the guard does not read a literal as "close enough".
    const overMeasure = layoutProblems(seeded('../styles/live.css', '.toc { max-width: 641px; }'));
    expect(overMeasure.some((problem) => problem.includes('.toc { max-width: 641px }'))).toBe(true);

    // The measure is the register's box; a register that stops stating it leaves the canvas.
    const unboxed = layoutProblems(replaced(BASE, 'max-width: var(--measure);', 'max-width: var(--column);'));
    expect(unboxed.some((problem) => problem.includes('.page does not state its box'))).toBe(true);
    expect(unboxed.some((problem) => problem.includes('var(--column) is retired'))).toBe(true);

    const ribbon = layoutProblems(seeded('../styles/ribbon.css', '.ribbon { max-width: 660px; }'));
    expect(ribbon.some((problem) => problem.includes('.ribbon { max-width: 660px }'))).toBe(true);

    // A register re-widened by `width` is the same bug as one re-widened by `max-width`.
    const widened = layoutProblems(seeded('../styles/live.css', '.toc { width: 700px; }'));
    expect(widened.some((problem) => problem.includes('.toc { width: 700px }'))).toBe(true);

    // And so is a register that drops the cap altogether: `none` is the canvas's width.
    const uncapped = layoutProblems(seeded('../styles/live.css', '.toc { max-width: none; }'));
    expect(uncapped.some((problem) => problem.includes('a register may not drop its column'))).toBe(true);
  });

  it('the measure used as a non-register box, and the measure-plus-gutters box inside the canvas', () => {
    const measureBox = layoutProblems(seeded(BASE, '.toc { width: var(--measure); }'));
    expect(measureBox.some((problem) => problem.includes('var(--measure) is the column: .page, .ribbon and the prose rule state it'))).toBe(true);

    // `.legal` and `.state-line` used to re-declare this box and centre themselves: the third
    // edge. BOOK-91: the box is the canvas's own, and elsewhere only the no-JS fallback's —
    // BOOK-128 comment #3815 removed the phrase's floating panel, so no overlay states it.
    const oldBox = layoutProblems(seeded('../styles/legal.css', '.legal { max-width: calc(var(--measure) + 2 * var(--gut)); }'));
    expect(oldBox.some((problem) => problem.includes("is the canvas's own box (and the no-JS fallback's)"))).toBe(true);

    // The outside-canvas row is held by the tree, not by the comment.
    const stale = layoutProblems(replaced(BASE, 'padding: 64px var(--gut);', 'padding: 64px;'));
    expect(stale.some((problem) => problem.includes('.noscript does not state its 3 declarations'))).toBe(true);
  });

  it('a prose block that centres itself, and a register that re-adds the gutter', () => {
    const centred = layoutProblems(seeded(BASE, '.state-line { margin-inline: auto; }'));
    expect(centred.some((problem) => problem.includes('only the canvas, the no-JS box and the overlays may centre themselves'))).toBe(true);

    const shorthand = layoutProblems(seeded('../styles/book.css', '.front-rule { margin: 0 auto; }'));
    expect(shorthand.some((problem) => problem.includes('.front-rule { margin: 0 auto }'))).toBe(true);

    // The split form of the same centring: two auto margins are the pair, not two pushes, and
    // a register that also states `width: 700px` is caught twice — the width and the centring.
    const split = layoutProblems(seeded('../styles/live.css', '.toc { width: 700px; margin-left: auto; margin-right: auto; }'));
    expect(split.some((problem) => problem.includes('.toc { width: 700px }'))).toBe(true);
    expect(split.some((problem) => problem.includes('with margin-right: auto — only the canvas, the no-JS box and the overlays may centre themselves'))).toBe(true);

    // THE FINAL FRAME'S NEW SEED: a register that re-adds the canvas's gutter. It was correct
    // in BOOK-88's first frame and is a second left edge here — the text starts 32 px inside
    // the column the prose stands on.
    const gutter = layoutProblems(seeded('../styles/live.css', '.toc { padding-inline: var(--gut); }'));
    expect(gutter.some((problem) => problem.includes('.toc { padding-inline: var(--gut) }'))).toBe(true);
    expect(gutter.some((problem) => problem.includes('a register states no inline padding'))).toBe(true);

    const doubled = layoutProblems(seeded('../styles/live.css', '.toc { padding-inline: calc(var(--gut) * 2); }'));
    expect(doubled.some((problem) => problem.includes('a register states no inline padding'))).toBe(true);

    const inner = layoutProblems(seeded('../styles/book.css', '.colophon .row { padding-inline: var(--gut); }'));
    expect(inner.some((problem) => problem.includes('a descendant of the column re-adds its gutter'))).toBe(true);
  });

  it('a register that centres itself with a margin shorthand or a pair of autos', () => {
    // The BOOK-63 bug's mirror: `.consent` is a `.page`, and `margin: 30px auto 6px` centres
    // the 640 px strip inside the 704 px canvas — the column must stay flush inside it.
    const strip = layoutProblems(seeded('../styles/consent.css', '.consent { margin: 30px auto 6px; }'));
    expect(strip.some((problem) => problem.includes('a register\'s horizontal margin is `0`'))).toBe(true);
    expect(strip.some((problem) => problem.includes('this sets it to `auto`'))).toBe(true);

    const pair = layoutProblems(seeded('../styles/ribbon.css', '.ribbon { margin-left: auto; }'));
    expect(pair.some((problem) => problem.includes('.ribbon { margin-left: auto }'))).toBe(true);
  });

  it('a prose selector left without its cap', () => {
    // The prose rule renamed out from under `.qline`: the selector is then capped by nothing.
    const uncapped = layoutProblems(replaced(BASE, '.qline,', '.qline-x,'));
    expect(uncapped).toContain(
      '».qline« is prose, but no rule in ../styles/base.css caps it at var(--measure) — the one prose rule is the only cap',
    );
  });

  it('the consent strip’s content block is prose, not a second box', () => {
    // BOOK-88, type: the strip is a `.page`; inside it the notice stands on the column
    // (`consent-body`), so the copy and the two hairlines share the page's left edge. The block
    // is prose like any other, and it may neither centre itself nor state a box of its own.
    expect(PROSE).toContain('.consent-body');

    const centred = layoutProblems(seeded('../styles/consent.css', '.consent-body { margin-inline: auto; }'));
    expect(centred.some((problem) => problem.includes('only the canvas, the no-JS box and the overlays may centre themselves'))).toBe(true);

    const box = layoutProblems(seeded('../styles/consent.css', '.consent-body { max-width: 720px; }'));
    expect(box.some((problem) => problem.includes('.consent-body { max-width: 720px }'))).toBe(true);

    // A block nobody caps is a block that is no longer prose.
    const uncapped = layoutProblems(replaced(BASE, '.consent-body,', '.consent-body-x,'));
    expect(uncapped).toContain(
      '».consent-body« is prose, but no rule in ../styles/base.css caps it at var(--measure) — the one prose rule is the only cap',
    );
  });

  it('the seam strip and its stale line are prose, one element over from the paragraph', () => {
    // a41932b moved the strip out of the `<p>`: `.seam` and `.p-stale` are now block siblings
    // inside `.page ch`, so the one prose rule has to name them too, or the strip's band and
    // its `.seam-cta` (`margin-left: auto`) run across the whole column above a 640 px
    // paragraph — the same defect, one element over.
    expect(PROSE).toContain('.seam');
    expect(PROSE).toContain('.p-stale');

    // Left uncapped: the strip falls back to the column's own width.
    const strip = layoutProblems(replaced(BASE, '.seam,', '.seam-x,'));
    expect(strip).toContain(
      '».seam« is prose, but no rule in ../styles/base.css caps it at var(--measure) — the one prose rule is the only cap',
    );

    const stale = layoutProblems(replaced(BASE, '.p-stale,', '.p-stale-x,'));
    expect(stale).toContain(
      '».p-stale« is prose, but no rule in ../styles/base.css caps it at var(--measure) — the one prose rule is the only cap',
    );

    // Re-widened to the canvas from a later sheet is the same bug stated as a box of its own.
    const wide = layoutProblems(seeded('../styles/seam.css', '.seam { max-width: var(--column); }'));
    expect(wide.some((problem) => problem.includes('.seam { max-width: var(--column) }'))).toBe(true);
  });

  it('does not fire on the copy caps, the column restated, or the overlays', () => {
    // The false positives that would make the guard useless: a `ch`/percentage cap is copy, not
    // a box; a register restating the column states the same box; an overlay is not a page
    // register, and the no-JS fallback's own row is the one box allowed the old text box.
    const legitimate = seeded(
      '../styles/book.css',
      [
        '.title-genre { max-width: min(100%, 58ch); }',
        '.chr-summary { max-width: 62ch; }',
        '.media-wide { max-width: 100%; }',
        '.media-free { max-width: none; }',
        '.ribbon { max-width: var(--measure); }',
        '.page { max-width: var(--measure); }',
        '.focus-stage { max-width: 590px; margin-inline: auto; }',
      ].join('\n'),
    );
    expect(layoutProblems(legitimate)).toEqual([]);
  });
});
