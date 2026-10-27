import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The shell and the palette as shipped (BOOK-DOC-3 §3, BOOK-DOC-6 Job B).
 *
 * These are string checks on the files the browser gets and runs — the shell's metadata and
 * the CSS. They exist because three of them regressed invisibly: a genre label and a length
 * promise in the share card, a warm-beige paper with a grain layer, and empty TOC numerals
 * dimmed to `--ink-3`. They live on the server side because a `web/` source file may not
 * touch `node:` (arch rule 2), and this is a build guard, not a component test.
 *
 * The sheets and their order are read from `main.tsx`, the module the browser boots: a guard
 * over a hand-kept list can pass while a sheet that loads later re-grids the page (BOOK-73).
 */

const WEB = join(import.meta.dirname, '..', '..', 'web');
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const main = readFileSync(join(WEB, 'src', 'main.tsx'), 'utf8');

/** Every `import './styles/<name>.css';` of the boot module, in cascade order. */
const sheetNames = [...main.matchAll(/import\s+['"]\.\/styles\/([a-z0-9-]+)\.css['"];/gu)].map(
  (match) => match[1] ?? '',
);
// Loudly, not silently: an empty list would make every assertion below vacuous.
if (sheetNames.length === 0) throw new Error('no stylesheet imports found in web/src/main.tsx');

const sheets: Record<string, string> = Object.fromEntries(
  sheetNames.map((name) => [name, readFileSync(join(WEB, 'src', 'styles', `${name}.css`), 'utf8')]),
);
const css = sheetNames.map((name) => sheets[name] ?? '').join('\n');

function metaContent(name: string): string {
  const match = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]+)"`, 'u').exec(html);
  if (match?.[1] === undefined) throw new Error(`no meta ${name}`);
  return match[1];
}

function rule(selector: string, source = css): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\{([^}]*)\\}`, 'u').exec(
    source,
  );
  if (match?.[1] === undefined) throw new Error(`no rule ${selector}`);
  return match[1];
}

/** One `<sheets>.toc { … }` rule that declares a grid track, and the sheet it came from. */
interface TrackDeclaration {
  sheet: string;
  body: string;
}

/**
 * Every `.toc { … }` rule whose body declares a grid track, over the whole cascade (BOOK-73).
 *
 * The selector boundary is guarded: `.toc-part`, `.toc-label` and `.toc-row-empty` are other
 * rules and never count. The body is read, not the selector alone, because a later sheet can
 * re-grid the contents without touching `live.css`. Comments are blanked first — a commented
 * rule is not a rule (the styles guard's rule, BOOK-DOC-35).
 */
function tocTrackDeclarations(source: Record<string, string>): TrackDeclaration[] {
  const found: TrackDeclaration[] = [];
  for (const [sheet, text] of Object.entries(source)) {
    const live = text.replace(/\/\*[\s\S]*?\*\//gu, ' ');
    for (const match of live.matchAll(/(?:^|[\s,>])\.toc\s*\{([^}]*)\}/gu)) {
      const body = match[1] ?? '';
      if (/grid-template-columns\s*:/u.test(body)) found.push({ sheet, body });
    }
  }
  return found;
}

const TOC_TRACK = /grid-template-columns:\s*1fr;/u;
const TWO_TRACKS = /1fr\s+1fr/u;

describe('the shell a share card sees', () => {
  it('describes the book without a genre label or a length promise', () => {
    const description = metaContent('description');
    expect(description.toLowerCase()).not.toContain('роман');
    expect(description.toLowerCase()).not.toMatch(/глав/u);
    expect(description.toLowerCase()).not.toMatch(/\d/u);
    // One sentence: no interior sentence break, one full stop at the end.
    expect(description.match(/[.!?](\s|$)/gu)).toHaveLength(1);
    expect(description.trim().endsWith('.')).toBe(true);
  });

  it('paints the bar in the concrete paper, not the beige', () => {
    expect(metaContent('theme-color')).toBe('#CFD3D2');
  });
});

describe('the page is concrete, not paper', () => {
  it('ships no grain layer', () => {
    expect(css).not.toMatch(/feTurbulence/iu);
    expect(css).not.toMatch(/body::after/u);
  });

  it('carries no warm beige token anywhere', () => {
    expect(css).not.toMatch(/#e9e8e2/iu);
    expect(css).not.toMatch(/233,\s*232,\s*226/u);
  });

  it('bases the day theme on the measured concrete palette', () => {
    const day = rule(':root', sheets.tokens);
    expect(day).toContain('--paper: #cfd3d2');
    expect(day).toContain('--paper-2: #dde1e0');
    expect(day).toContain('--ink: #14171a');
    expect(day).toContain('--ink-2: #4e5455');
    expect(day).toContain('--rule: #a6adac');
    const night = rule("[data-theme='night']", sheets.tokens);
    expect(night).toContain('--paper: #0b0c0d');
  });
});

describe('the empty table of contents', () => {
  it('numeral of an empty slot takes full ink, not the label grey', () => {
    const empty = rule('.toc-row-empty .toc-num');
    expect(empty).toContain('color: var(--ink)');
    expect(empty).not.toContain('var(--ink-3)');
  });

  it('keeps the void at 26 px rows and 32 px part headers, taps at 44 px', () => {
    // BOOK-DOC-35 §5: a 12px numeral needs a 26px row to keep the column quiet, and each part
    // head keeps its 32px of air — BOOK-73 removed the spread, so there is no layout to fit.
    expect(rule('.toc-row-empty')).toContain('height: 26px');
    expect(rule('.toc-part-h')).toContain('padding: 32px 0 10px');
    expect(rule('.toc-link')).toContain('min-height: 44px');
  });

  it('lists the contents in one column at every width', () => {
    // BOOK-73: one list in one column, the desktop canvas stays ≤1000px.
    const toc = rule('.toc');
    expect(toc).toMatch(TOC_TRACK);
    expect(toc).not.toMatch(TWO_TRACKS);
  });

  it('declares exactly one TOC track, in live.css, as a single column', () => {
    // The guard runs over every sheet the browser loads, in cascade order: the spread could
    // come back from `seam.css` or `panels.css` without a line changing in `live.css`.
    const declarations = tocTrackDeclarations(sheets);
    expect(declarations).toHaveLength(1);
    const [track] = declarations;
    expect(track?.sheet).toBe('live');
    expect(track?.body).toMatch(TOC_TRACK);
    expect(track?.body).not.toMatch(TWO_TRACKS);
  });

  it('catches a later sheet that re-grids the TOC, and is not grepping nothing', () => {
    // The shape the guard exists for: `live.css` ships one track, and `seam.css` — which the
    // browser loads after it — puts the spread back.
    const seeded = tocTrackDeclarations({
      live: ['.toc {', '  display: grid;', '  grid-template-columns: 1fr;', '}', ''].join('\n'),
      seam: ['.toc {', '  grid-template-columns: 1fr 1fr;', '}', ''].join('\n'),
    });
    expect(seeded.map((declaration) => declaration.sheet)).toEqual(['live', 'seam']);
    expect(seeded[0]?.body).toMatch(TOC_TRACK);
    expect(seeded[1]?.body).toMatch(TWO_TRACKS);
    // A narrower selector is another rule, not the contents: `.toc-part` and `.toc-link`
    // declare tracks of their own and must not be counted.
    expect(
      tocTrackDeclarations({
        live: [
          '.toc-part {',
          '  grid-template-columns: 1fr 1fr;',
          '}',
          '.toc-link {',
          '  grid-template-columns: 36px 1fr;',
          '}',
          '',
        ].join('\n'),
      }),
    ).toEqual([]);
    // A commented-out override is not a rule either.
    expect(tocTrackDeclarations({ seam: '/* .toc { grid-template-columns: 1fr 1fr; } */\n' })).toEqual(
      [],
    );
    // And an empty cascade finds nothing: a guard that only passes on the real tree is no guard.
    expect(tocTrackDeclarations({})).toEqual([]);
  });
});

describe('the shipped stylesheets', () => {
  it('are read from the module the browser boots, in cascade order', () => {
    expect(sheetNames).toContain('live');
    expect(new Set(sheetNames).size).toBe(sheetNames.length);
    // `live.css` is not last in the cascade, so a guard over one sheet is not a guard: an
    // override in any sheet after it wins on equal specificity.
    expect(sheetNames.indexOf('live')).toBeLessThan(sheetNames.length - 1);
    expect(Object.keys(sheets)).toEqual(sheetNames);
  });
});
