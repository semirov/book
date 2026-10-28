import { describe, expect, it } from 'vitest';

/**
 * BOOK-128 comment #3900 §4 (owner, 2026-10-28) — **two faces and no third**.
 *
 * The screen audit's root cause was a third register: `--label` (PT Sans Narrow, 12–13 px,
 * uppercase, 0.12–0.18 em) and `--ui` (PT Sans) were a fourth voice that set state words,
 * actions, sentences and even the reader's own filing. The canon is two voices — serif for what
 * a reader reads, 12 px mono lowercase for every mark — so the guard is a token-level one: the
 * files must not be able to grow the third face back. Reading the sheets as text is the point:
 * a selector list, a shorthand or a renamed token cannot hide a family from this scan.
 *
 * Failure messages are written to be read on their own ("a third face entered the tokens").
 */

/** Every sheet of `web/src/styles`, plus the dev-only before/after fixture. */
const sheets = import.meta.glob<string>('./*.css', { query: '?raw', import: 'default', eager: true });
const dev = import.meta.glob<string>('../../dev/fixture.css', { query: '?raw', import: 'default', eager: true });

const TOKENS = './tokens.css';

const files = new Map<string, string>(Object.entries({ ...sheets, ...dev }));

/** Comments are not declarations: a commented-out rule is not a rule (the house rule). */
const blanked = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');

const lines = (css: string): Array<{ line: number; text: string }> =>
  css
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => text.trim() !== '');

/** The `@font-face` blocks, with their own text, so their `font-family` never counts as a rule. */
const fontFaces = (css: string): string[] => [...blanked(css).matchAll(/@font-face\s*\{([^}]*)\}/gu)].map((m) => m[1] ?? '');

const withoutFontFaces = (css: string): string => blanked(css).replace(/@font-face\s*\{[^}]*\}/gu, '');

describe('BOOK-128 #3900 — the product has two faces, serif and mono', () => {
  it('reads every sheet and the dev fixture (an empty scan would prove nothing)', () => {
    expect(files.size).toBeGreaterThan(20);
    expect([...files.keys()]).toContain(TOKENS);
    expect([...files.keys()]).toContain('../../dev/fixture.css');
    expect(files.get(TOKENS) ?? '').toContain('--serif');
  });

  it('tokens.css declares exactly two font-family tokens: --serif and --mono', () => {
    const tokens = blanked(files.get(TOKENS) ?? '');
    // A font-family token is a custom property whose value names a family — quoted, or a
    // generic (`serif`, `monospace`, `sans-serif`), or a stack that starts with one.
    const stacks = [...tokens.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gu)]
      .filter(([, , value]) => /['"]|serif|monospace|sans-serif|system-ui/u.test(value ?? ''))
      .map(([, name]) => name ?? '');
    expect(stacks.sort(), 'a third face entered the tokens').toEqual(['--mono', '--serif']);
    // The retired names are not tokens any more — in any spelling.
    expect(tokens).not.toMatch(/(?:^|[\s;{])--ui\s*:/mu);
    expect(tokens).not.toMatch(/(?:^|[\s;{])--label\s*:/mu);
  });

  it('loads exactly two @font-face families: PT Serif and PT Mono', () => {
    const families = [
      ...new Set(
        fontFaces(files.get(TOKENS) ?? '').map(
          (block) => /font-family:\s*['"]?([^'";]+)['"]?\s*;/u.exec(block)?.[1]?.trim() ?? '',
        ),
      ),
    ]
      .filter((family) => family !== '')
      .sort();
    expect(families, 'a third face entered the tokens').toEqual(['PT Mono', 'PT Serif']);
    // PT Sans Narrow and PT Sans are retired with their declarations; the files stay on disk.
    const tokens = blanked(files.get(TOKENS) ?? '');
    expect(tokens).not.toContain('pt sans narrow');
    expect(tokens).not.toContain("'PT Sans'");
  });

  it('no sheet asks for a retired face', () => {
    const offending: string[] = [];
    for (const [file, css] of files) {
      for (const { line, text } of lines(blanked(css))) {
        if (/var\(\s*--(?:label|ui)\s*\)/u.test(text)) offending.push(`${file}:${line} ${text.trim()}`);
      }
    }
    expect(offending, 'a retired face is still asked for: var(--label) / var(--ui)').toEqual([]);
  });

  it('no sheet uppercases a word: the register is lowercase as written', () => {
    const offending: string[] = [];
    for (const [file, css] of files) {
      for (const { line, text } of lines(blanked(css))) {
        if (/text-transform\s*:\s*uppercase/iu.test(text)) offending.push(`${file}:${line} ${text.trim()}`);
      }
    }
    expect(offending, 'uppercase is not a register: the words are written in the case they print').toEqual([]);
  });

  it('every font-family in the sheets is var(--serif), var(--mono) or inherit — a third face entered the styles', () => {
    const allowed = new Set(['var(--serif)', 'var(--mono)', 'inherit']);
    const offending: string[] = [];
    for (const [file, css] of files) {
      // `tokens.css` owns the two families (its `@font-face` and its `:root`); every other
      // sheet may only name one of the two tokens.
      if (file === TOKENS) continue;
      const body = withoutFontFaces(css);
      body.split('\n').forEach((text, index) => {
        const match = /font-family\s*:\s*([^;}]+)/iu.exec(text);
        if (match === null) return;
        const value = (match[1] ?? '').trim();
        if (!allowed.has(value)) offending.push(`${file}:${index + 1} font-family: ${value}`);
      });
    }
    expect(offending, 'a third face entered the styles — a sheet may only name serif, mono or inherit').toEqual([]);
  });

  it('keeps the serif on the reading column and the mono on the marks (the two tokens are used)', () => {
    const all = [...files.values()].map(blanked).join('\n');
    expect(all.match(/font-family:\s*var\(--serif\)/gu)?.length ?? 0).toBeGreaterThan(20);
    expect(all.match(/font-family:\s*var\(--mono\)/gu)?.length ?? 0).toBeGreaterThan(20);
  });
});
