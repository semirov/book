import { describe, expect, it } from 'vitest';

import {
  BASE,
  PROSE,
  REGISTER_COMPONENTS,
  TOKENS,
  cascade,
  components,
  layoutProblems,
  markupProblems,
  replaced,
  seeded,
  sheets,
  tokenPx,
} from './measure.guard.ts';

/**
 * BOOK-88 — one column, one prose block, one left edge.
 *
 * The rule and the checks it is built from are documented in `measure.guard.ts` and
 * `measure.rules.ts`; this file is the evidence that they hold on the real tree, that the
 * design memo's arithmetic table comes out of the tokens alone, and that each class of
 * violation is really red. A guard nobody has seen fire is a comment.
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

  it('puts the column and the prose block where the design table says, from the tokens alone', () => {
    const column = tokenPx('--column');
    const measure = tokenPx('--measure', { file: TOKENS });
    const measureNarrow = tokenPx('--measure', { query: 'narrow', file: TOKENS });
    const gutter = tokenPx('--gut');
    const phoneGutter = tokenPx('--gut', { query: 'phone', file: BASE });
    // The numbers the whole table rests on: a 1000 px column, 600 / 584 px of prose, 32 / 24 px
    // of gutter. Read from the sheets, so a drifted token fails here and not in a screenshot.
    expect({ column, measure, measureNarrow, gutter, phoneGutter }).toEqual({
      column: 1000,
      measure: 600,
      measureNarrow: 584,
      gutter: 32,
      phoneGutter: 24,
    });

    // viewport, gutter, prose width, column L, column R, prose R — the memo's table §3.
    const table = [
      [390, phoneGutter, measureNarrow, 24, 366, 366],
      [768, gutter, measureNarrow, 32, 736, 616],
      [1024, gutter, measure, 44, 980, 644],
      [1440, gutter, measure, 252, 1188, 852],
    ] as const;

    for (const [viewport, gut, proseWidth, left, right, proseRight] of table) {
      const box = Math.min(column, viewport);
      const margin = (viewport - box) / 2;
      const columnLeft = margin + gut;
      const columnRight = viewport - margin - gut;
      expect({ viewport, columnLeft, columnRight }).toEqual({ viewport, columnLeft: left, columnRight: right });
      // The prose is flush left, so it starts on the column's own left edge: its right edge is
      // the left edge plus the measure. The "starts on the left edge" half is the guard's — it
      // rejects any horizontal margin on a prose selector — and this half is the table's.
      expect(columnLeft + Math.min(proseWidth, box - 2 * gut), `prose R at ${viewport}`).toBe(proseRight);
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
  it('a second home for either token, or the retired canvas back', () => {
    const measure = layoutProblems(seeded(BASE, ':root { --measure: 33.75rem; }'));
    expect(measure.some((problem) => problem.startsWith('--measure is declared 3 time(s)'))).toBe(true);
    expect(measure.some((problem) => problem.includes('the prose block has one home'))).toBe(true);

    const shape = layoutProblems(replaced(TOKENS, '--column: 1000px;', '--column: 1100px;'));
    expect(shape).toContain('--column: 1100px — the column is 1000px');

    const legacy = layoutProblems(seeded(TOKENS, ':root { --shell: 1000px; }'));
    expect(legacy.some((problem) => problem.startsWith('--shell is back (1 declaration(s)'))).toBe(true);

    // The historical line itself, `.page.sheet` back on the retired canvas token: red twice —
    // the token is gone, and the register states a box that is neither the column nor prose.
    const alias = layoutProblems(seeded(BASE, '.page.sheet { max-width: var(--shell); }'));
    expect(alias.some((problem) => problem.startsWith('--shell is back (0 declaration(s), 1 use(s))'))).toBe(true);
    expect(alias.some((problem) => problem.includes('.page.sheet { max-width: var(--shell) }'))).toBe(true);
  });

  it('reads the frame as a position on the folio, and never as a size', () => {
    // BOOK-89's running folio is the one reader of the frame that is not a box: its right margin
    // is the frame's inner right edge. The real tree holds it (the seed-free run above), and the
    // token is still a size nowhere else.
    const sized = layoutProblems(seeded('../styles/live.css', '.folio { width: var(--column); }'));
    expect(sized.some((problem) => problem.includes('.folio { width: var(--column) } — var(--column) is the box of .page'))).toBe(true);

    // Another selector may not borrow the permission: a position on it is the same second frame.
    const borrowed = layoutProblems(seeded('../styles/live.css', '.seam { inset-inline-end: var(--column); }'));
    expect(borrowed.some((problem) => problem.includes('.seam { inset-inline-end: var(--column) }'))).toBe(true);

    // The exception is held by the tree, not by the comment: drop the read and the guard says so.
    const stale = layoutProblems(replaced('../styles/live.css', '(100% - var(--column)) / 2', '0px'));
    expect(stale.some((problem) => problem.includes('a stale frame-reader exception'))).toBe(true);
  });

  it('a register that states its own width, from a later sheet or as a literal', () => {
    // The exact BOOK-88 regression: a later sheet re-widening a register past `.page`, which
    // is what `.page.sheet` did (it is inert now, so only a seeded rule can bring it back).
    const sheet = layoutProblems(seeded('../styles/live.css', '.page.sheet { max-width: var(--column); }'));
    expect(sheet.some((problem) => problem.includes('— var(--column) is the box of .page'))).toBe(true);

    const literal = layoutProblems(seeded('../styles/live.css', '.toc { max-width: 1000px; }'));
    expect(literal.some((problem) => problem.includes('a box is the column (var(--column))'))).toBe(true);

    // The column may not shrink to the prose either: that is the second text track.
    const shrunk = layoutProblems(seeded(BASE, '.page { max-width: var(--measure); }'));
    expect(shrunk.some((problem) => problem.includes('the measure is the prose block, never a box'))).toBe(true);

    const ribbon = layoutProblems(seeded('../styles/ribbon.css', '.ribbon { max-width: 660px; }'));
    expect(ribbon.some((problem) => problem.includes('.ribbon { max-width: 660px }'))).toBe(true);

    // A register re-widened by `width` is the same bug as one re-widened by `max-width`.
    const widened = layoutProblems(seeded('../styles/live.css', '.toc { width: 700px; }'));
    expect(widened.some((problem) => problem.includes('.toc { width: 700px }'))).toBe(true);
  });

  it('the measure used as a box width, and the old text box inside the column', () => {
    const measureBox = layoutProblems(seeded(BASE, '.toc { width: var(--measure); }'));
    expect(measureBox.some((problem) => problem.includes('var(--measure) is text width, never the width of a box'))).toBe(true);

    // `.legal` and `.state-line` used to re-declare this and centre themselves: the third edge.
    const oldBox = layoutProblems(seeded('../styles/legal.css', '.legal { max-width: calc(var(--measure) + 2 * var(--gut)); }'));
    expect(oldBox.some((problem) => problem.includes('is the old text box'))).toBe(true);
  });

  it('a prose block that centres itself, and a register that re-adds the gutter', () => {
    const centred = layoutProblems(seeded(BASE, '.state-line { margin-inline: auto; }'));
    expect(centred.some((problem) => problem.includes('only the column and the overlays may centre themselves'))).toBe(true);

    const shorthand = layoutProblems(seeded('../styles/book.css', '.front-rule { margin: 0 auto; }'));
    expect(shorthand.some((problem) => problem.includes('.front-rule { margin: 0 auto }'))).toBe(true);

    // The split form of the same centring: two auto margins are the pair, not two pushes, and
    // a register that also states `width: 700px` is caught twice — the width and the centring.
    const split = layoutProblems(seeded('../styles/live.css', '.toc { width: 700px; margin-left: auto; margin-right: auto; }'));
    expect(split.some((problem) => problem.includes('.toc { width: 700px }'))).toBe(true);
    expect(split.some((problem) => problem.includes('with margin-right: auto — only the column and the overlays may centre themselves'))).toBe(true);

    const doubled = layoutProblems(seeded('../styles/live.css', '.toc { padding-inline: calc(var(--gut) * 2); }'));
    expect(doubled.some((problem) => problem.includes("a register keeps exactly the column's one gutter"))).toBe(true);

    const inner = layoutProblems(seeded('../styles/book.css', '.colophon .row { padding-inline: var(--gut); }'));
    expect(inner.some((problem) => problem.includes('a descendant of the column re-adds its gutter'))).toBe(true);
  });

  it('a register that drops the column’s centring with a margin shorthand', () => {
    // The BOOK-63/BOOK-88 blocker: `.consent` is a `.page`, and `margin: 30px 0 6px` reset the
    // inline sides to 0, pinning the strip to the viewport edge above 1000 px.
    const strip = layoutProblems(seeded('../styles/consent.css', '.consent { margin: 30px 0 6px; }'));
    expect(strip.some((problem) => problem.includes('a register\'s horizontal margin is `auto`'))).toBe(true);
    expect(strip.some((problem) => problem.includes('this sets it to `0`'))).toBe(true);
  });

  it('a prose selector left without its cap', () => {
    // The prose rule renamed out from under `.qline`: the selector is then capped by nothing.
    const uncapped = layoutProblems(replaced(BASE, '.qline,', '.qline-x,'));
    expect(uncapped).toContain(
      '».qline« is prose, but no rule in ../styles/base.css caps it at var(--measure) — the one prose rule is the only cap',
    );
  });

  it('the consent strip’s content block is prose, not a second box', () => {
    // BOOK-88, type: the strip is a `.page`; inside it the notice stands on the prose measure
    // (`consent-body`), so the copy and the two hairlines share the page's left edge. The block
    // is prose like any other, and it may neither centre itself nor state a box of its own.
    expect(PROSE).toContain('.consent-body');

    const centred = layoutProblems(seeded('../styles/consent.css', '.consent-body { margin-inline: auto; }'));
    expect(centred.some((problem) => problem.includes('only the column and the overlays may centre themselves'))).toBe(true);

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

    // Re-widened to the column from a later sheet is the same bug stated as a box of its own.
    const wide = layoutProblems(seeded('../styles/seam.css', '.seam { max-width: var(--column); }'));
    expect(wide.some((problem) => problem.includes('.seam { max-width: var(--column) }'))).toBe(true);
  });

  it('does not fire on the copy caps, the column restated, or the overlays', () => {
    // The false positives that would make the guard useless: a `ch`/percentage cap is copy, not
    // a box; a register restating the column states the same frame; an overlay is not a page
    // register.
    const legitimate = seeded(
      '../styles/book.css',
      [
        '.title-genre { max-width: min(100%, 58ch); }',
        '.chr-summary { max-width: 62ch; }',
        '.media-wide { max-width: 100%; }',
        '.media-free { max-width: none; }',
        '.ribbon { max-width: var(--column); }',
        '.focus-stage { max-width: 590px; margin-inline: auto; }',
        '.chain { width: min(calc(var(--measure) + 2 * var(--gut)), 100%); }',
      ].join('\n'),
    );
    expect(layoutProblems(legitimate)).toEqual([]);
  });
});
