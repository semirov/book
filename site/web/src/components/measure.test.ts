import { describe, expect, it } from 'vitest';

import { blankComments, exactly, rulesOf } from './measure.css.ts';
import {
  BASE,
  CANVAS_READERS,
  COLUMN_BOXES,
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
 * BOOK-88 — one canvas, one column, one right edge.
 *
 * The rule and the checks it is built from are documented in `measure.guard.ts`,
 * `measure.tokens.ts` and `measure.rules.ts`; this file is the evidence that they hold on the
 * real tree, that the owner's arithmetic table comes out of the tokens alone, and that each
 * class of violation is really red. A guard nobody has seen fire is a comment.
 */

describe('the page has one column (BOOK-88)', () => {
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

  it('puts the canvas and the column where the design table says, from the tokens alone', () => {
    const column = tokenPx('--column');
    const measure = tokenPx('--measure', { file: TOKENS });
    const measureNarrow = tokenPx('--measure', { query: 'narrow', file: TOKENS });
    const gutter = tokenPx('--gut');
    const phoneGutter = tokenPx('--gut', { query: 'phone', file: BASE });
    // The numbers the whole table rests on: a 1000 px canvas, a 600 / 584 px column, 32 / 24 px
    // of gutter. Read from the sheets, so a drifted token fails here and not in a screenshot.
    expect({ column, measure, measureNarrow, gutter, phoneGutter }).toEqual({
      column: 1000,
      measure: 600,
      measureNarrow: 584,
      gutter: 32,
      phoneGutter: 24,
    });

    // viewport, gutter, column width, canvas L, canvas R, column L, column R — the owner's
    // measurement of the deployed build, as the table every register must land on.
    const table = [
      [390, phoneGutter, measureNarrow, 0, 390, 24, 366],
      [768, gutter, measureNarrow, 0, 768, 32, 616],
      [1024, gutter, measure, 12, 1012, 44, 644],
      [1440, gutter, measure, 220, 1220, 252, 852],
    ] as const;

    for (const [viewport, gut, columnWidth, canvasLeft, canvasRight, left, right] of table) {
      // The canvas: the 1000 px bound, centred in the viewport, never wider than it.
      const canvas = Math.min(column, viewport);
      expect({ viewport, canvasLeft, canvasRight }).toEqual({
        viewport,
        canvasLeft: (viewport - canvas) / 2,
        canvasRight: viewport - (viewport - canvas) / 2,
      });
      // The column: the measure, capped by the canvas's inner width, flush left on the
      // canvas's own left edge — 252 at 1440, not the canvas's 220 nor the viewport's centre.
      const inner = canvasRight - canvasLeft - 2 * gut;
      expect({ viewport, left: canvasLeft + gut, right: canvasLeft + gut + Math.min(columnWidth, inner) }).toEqual({
        viewport,
        left,
        right,
      });
      // The canvas is the column plus its two gutters, once: the gutter is inside the bound.
      expect(right + gut).toBeLessThanOrEqual(canvasRight);
    }
  });

  it('names the canvas, its one non-box reader and its one box outside it', () => {
    // The exceptions are data, and the seed-free run above proves the tree holds them; this
    // pins the shape, so a future edit widens the list on purpose or not at all.
    expect(CANVAS_READERS).toHaveLength(1);
    expect(CANVAS_READERS[0]?.selector).toBe('.folio');
    expect(OUTSIDE_CANVAS.map((row) => row.selector)).toEqual(['.noscript']);
    expect(COLUMN_BOXES).toEqual(['.page', '.ribbon']);
  });
});

describe('the TOC row is a register like every other (BOOK-88, BOOK-89)', () => {
  it('closes the page cell on the row’s own right edge, and fits at 390', () => {
    const line = declarationsIn('../styles/live.css', '.toc-line');
    const link = declarationsIn('../styles/live.css', '.toc-link');
    const page = declarationsIn('../styles/live.css', '.toc-page');
    // BOOK-89: the page cell ends on the prose axis. The row *is* the column since the final
    // frame, so the old `100% − measure` inset is a no-op — it is gone, and the cell closes on
    // the row's own right edge, which is the paragraph's.
    for (const rule of [line, link]) expect(rule.has('padding-inline-end')).toBe(false);
    expect(line.get('grid-template-columns')).toBe('36px minmax(0, 1fr) 3ch');
    expect(line.get('height')).toBe('26px');
    expect(link.get('min-height')).toBe('44px');
    expect(link.get('padding')).toBe('10px 0');
    expect(page.get('inline-size')).toBe('3ch');
    expect(page.get('white-space')).toBe('nowrap');
    // The leaf and the leader at 390: 390 − 2 × 24 = 342 px of column, and the fixed tracks —
    // the 36 px numeral, two 14 px gaps and the 3ch page slot at the 12 px mono (0.6 em) —
    // leave the title 256 px, so neither the leaf nor the dotted leader is squeezed.
    const gap = Number.parseFloat(line.get('column-gap') ?? '0');
    const micro = tokenPx('--fs-micro', { file: TOKENS });
    expect({ gap, micro }).toEqual({ gap: 14, micro: 12 });
    expect(390 - 2 * tokenPx('--gut', { query: 'phone', file: BASE }) - (36 + 2 * gap + 3 * 0.6 * micro)).toBeCloseTo(256.4, 1);
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
  it('a second home for either token, or the retired canvas back', () => {
    const measure = layoutProblems(seeded(BASE, ':root { --measure: 33.75rem; }'));
    expect(measure.some((problem) => problem.startsWith('--measure is declared 3 time(s)'))).toBe(true);
    expect(measure.some((problem) => problem.includes('the text column has one home'))).toBe(true);

    const shape = layoutProblems(replaced(TOKENS, '--column: 1000px;', '--column: 1100px;'));
    expect(shape).toContain('--column: 1100px — the canvas is 1000px');

    const legacy = layoutProblems(seeded(TOKENS, ':root { --shell: 1000px; }'));
    expect(legacy.some((problem) => problem.startsWith('--shell is back (1 declaration(s)'))).toBe(true);

    // The historical line itself, `.page.sheet` back on the retired canvas token: red twice —
    // the token is gone, and the register states a box that is not the measure.
    const alias = layoutProblems(seeded(BASE, '.page.sheet { max-width: var(--shell); }'));
    expect(alias.some((problem) => problem.startsWith('--shell is back (0 declaration(s), 1 use(s))'))).toBe(true);
    expect(alias.some((problem) => problem.includes('.page.sheet { max-width: var(--shell) }'))).toBe(true);
  });

  it('reads the canvas as a position on the folio, and never as a size', () => {
    // BOOK-89's running folio is the one reader of the canvas that is not a box: its right
    // margin is the canvas's inner right edge. The real tree holds it (the seed-free run above),
    // and the token is still a size nowhere else.
    const sized = layoutProblems(seeded('../styles/live.css', '.folio { width: var(--column); }'));
    expect(sized.some((problem) => problem.includes('.folio { width: var(--column) } — var(--column) is the box of .canvas'))).toBe(true);

    // Another selector may not borrow the permission: a position on it is the same second frame.
    const borrowed = layoutProblems(seeded('../styles/live.css', '.seam { inset-inline-end: var(--column); }'));
    expect(borrowed.some((problem) => problem.includes('.seam { inset-inline-end: var(--column) }'))).toBe(true);

    // The exception is held by the tree, not by the comment: drop the read and the guard says so.
    const stale = layoutProblems(replaced('../styles/live.css', '(100% - var(--column)) / 2', '0px'));
    expect(stale.some((problem) => problem.includes('a stale canvas-reader exception'))).toBe(true);
  });

  it('the canvas that drops its bound, its gutters or its centring', () => {
    // The three declarations are what makes the column sit at 252 inside the 1000 px bound; a
    // canvas missing one of them silently falls back to the viewport.
    const noGutters = layoutProblems(replaced(BASE, 'padding-inline: var(--gut);', 'padding-inline: 0;'));
    expect(noGutters.some((problem) => problem.includes('does not state padding-inline: var(--gut)'))).toBe(true);

    const noCentring = layoutProblems(replaced(BASE, 'margin: 0 auto;', 'margin: 0;'));
    expect(noCentring.some((problem) => problem.includes('.canvas does not centre the column'))).toBe(true);
  });

  it('a register that states its own width, from a later sheet or as a literal', () => {
    // The BOOK-88 regression: a later sheet re-widening a register past the column. The canvas
    // token is not available to a register any more — that is the final frame's whole point.
    const sheet = layoutProblems(seeded('../styles/live.css', '.page.sheet { max-width: var(--column); }'));
    expect(sheet.some((problem) => problem.includes('— var(--column) is the box of .canvas'))).toBe(true);

    const literal = layoutProblems(seeded('../styles/live.css', '.toc { max-width: 1000px; }'));
    expect(literal.some((problem) => problem.includes('a register is exactly the column (max-width: var(--measure))'))).toBe(true);

    // The measure is the register's box; a register that stops stating it leaves the canvas.
    const unboxed = layoutProblems(replaced(BASE, 'max-width: var(--measure);', 'max-width: var(--column);'));
    expect(unboxed.some((problem) => problem.includes('.page does not state its box'))).toBe(true);
    expect(unboxed.some((problem) => problem.includes('var(--column) is the box of .canvas'))).toBe(true);

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
    // edge. Since the final frame it belongs only to the no-JS fallback and the chain overlay.
    const oldBox = layoutProblems(seeded('../styles/legal.css', '.legal { max-width: calc(var(--measure) + 2 * var(--gut)); }'));
    expect(oldBox.some((problem) => problem.includes('is the no-JS box outside the canvas'))).toBe(true);

    // The outside-canvas row is held by the tree, not by the comment.
    const stale = layoutProblems(replaced(BASE, 'calc(var(--measure) + 2 * var(--gut))', 'var(--column)'));
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
    // the 600 px strip in the 936 px canvas — the column must stay flush left.
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
    // its `.seam-cta` (`margin-left: auto`) run across the whole column above a 600 px
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
        '.chain { width: min(calc(var(--measure) + 2 * var(--gut)), 100%); }',
      ].join('\n'),
    );
    expect(layoutProblems(legitimate)).toEqual([]);
  });
});
