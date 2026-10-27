import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LADDER, MIN_FONT_PX, styleProblems } from '../../scripts/styles.mjs';

/**
 * BOOK-DOC-35 AC6 — the build guard for the type floor and the adaptive regime.
 *
 * `scripts/arch.mjs` prints `styleProblems` and exits 1 on a non-empty list; the same call is
 * made here. The real sheet set must be clean, the six ladder values are pinned, and every
 * rejection path runs on a seeded sheet — a guard that only passes on a clean tree could be
 * grepping nothing. File names matter: the ladder is only legal in `tokens.css`, so the
 * token cases write that name and the rest do not.
 */
const STYLES = resolve(import.meta.dirname, '../../web/src/styles');

/** A throwaway sheet set: `{ 'tokens.css': '…', 'base.css': '…' }`. */
function seeded(files: Record<string, string>): Array<{ file: string; line: number; message: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'book-styles-'));
  try {
    for (const [name, css] of Object.entries(files)) writeFileSync(join(dir, name), css, 'utf8');
    return styleProblems(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('BOOK-DOC-35 — the styles guard', () => {
  it('reports nothing on this repository: the floor holds and the regime is adaptive', () => {
    expect(styleProblems(STYLES)).toEqual([]);
  });

  it('pins the ladder: 12 / 13 / 14 / 15 → 18 / 19, declared once in tokens.css', () => {
    expect(LADDER).toEqual({
      '--fs-micro': 12,
      '--fs-label': 13,
      '--fs-meta': 14,
      '--fs-note': 15,
      '--fs-body': 18,
      '--fs-lead': 19,
    });
    const tokens = readFileSync(join(STYLES, 'tokens.css'), 'utf8');
    for (const [name, px] of Object.entries(LADDER)) expect(tokens).toContain(`${name}: ${px}px;`);
    // The retired rung stays retired: its name is not a ladder value.
    expect(tokens).not.toContain('--fs-nano');
    // And no other sheet declares a rung.
    for (const name of ['base.css', 'book.css', 'chrome.css', 'live.css']) {
      const css = readFileSync(join(STYLES, name), 'utf8');
      expect(css, name).not.toMatch(/--fs-[a-z0-9-]+\s*:/u);
    }
  });

  it('fails a sub-floor rung, a returning rung, and a rung outside tokens.css', () => {
    const problems = seeded({
      'tokens.css': [':root {', '  --fs-micro: 9.5px;', '  --fs-nano: 12px;', '}', ''].join('\n'),
      'base.css': ['@media (max-width: 599px) {', '  :root { --fs-body: 17px; }', '}', ''].join('\n'),
    });
    const messages = problems.map((problem) => problem.message);
    expect(messages).toContain('--fs-micro resolves to 9.5px, below the 12px floor');
    expect(messages).toContain('--fs-nano is not on the type ladder — a removed rung may not return');
    expect(messages).toContain('--fs-body is declared outside tokens.css — the ladder has one home');
    // Sorted by file (base.css before tokens.css), then down each sheet.
    expect(problems.map((problem) => `${problem.file.split('/').pop()}:${problem.line}`)).toEqual([
      'base.css:2',
      'tokens.css:2',
      'tokens.css:3',
    ]);
  });

  it('fails a var() resolving through another custom property, and reads the shorthand', () => {
    const problems = seeded({
      'type.css': [
        ':root { --type-micro: 9px; }',
        '.a { font-size: var(--type-micro, 12px); }',
        '.b { font: 11px/1.4 serif; }',
        '.c { font-size: 0.62rem; }',
        '.d { font-size: calc(6px + 2px); }',
        '.e { font-size: calc(var(--unknown) * 2); }',
        '.f { font-size: 0.86em; }',
        '/* .ghost { font-size: 9px; } — a commented rule is not a rule */',
        '',
      ].join('\n'),
    });
    const messages = problems.map((problem) => problem.message);
    // The fallback never applies: the token is declared, so the rendered size is 9px.
    expect(messages).toContain('font-size: var(--type-micro, 12px) is 9px, below the 12px floor');
    expect(messages).toContain('font: 11px is 11px, below the 12px floor');
    expect(messages).toContain('font-size: 0.62rem is 9.92px, below the 12px floor');
    expect(messages).toContain('font-size: calc(6px + 2px) is 8px, below the 12px floor');
    expect(messages).toContain('font-size: calc(var(--unknown) * 2) cannot be proven ≥12px');
    // The documented relative size and the commented-out rule are not problems.
    expect(messages.some((message) => message.includes('0.86em'))).toBe(false);
    expect(messages.some((message) => message.includes('9px; }'))).toBe(false);
    expect(problems.map((problem) => problem.line)).toEqual([2, 3, 4, 5, 6]);
  });

  it('fails a keyword size, which no sheet can prove is ≥12px', () => {
    const problems = seeded({
      'keyword.css': ['.a { font: x-small serif; }', '.b { font-size: small; }', ''].join('\n'),
    });
    expect(problems.map((problem) => problem.message)).toEqual([
      'font: x-small cannot be proven ≥12px',
      'font-size: small cannot be proven ≥12px',
    ]);
  });

  it('fails every spelling of a min-width query, and passes max-width and min-width: 0', () => {
    const problems = seeded({
      'a.css': '@media screen and (min-width: 1024px) { p { font-size: 13px; } }\n',
      'b.css': '@media (width >= 1024px) { p { font-size: 13px; } }\n',
      'c.css': '@media (600px <= width) { p { font-size: 13px; } }\n',
      'd.css': '@media (max-width: 1023px) { p { font-size: 13px; } }\n.row { min-width: 0; }\n',
    });
    expect(problems.map((problem) => problem.file.split('/').pop())).toEqual(['a.css', 'b.css', 'c.css']);
    for (const problem of problems) expect(problem.line).toBe(1);
  });

  it('passes the floor exactly, rem at the root size, a clamp minimum and a token calc', () => {
    const problems = seeded({
      'tokens.css': [':root { --fs-micro: 12px; --fs-lead: 19px; }', ''].join('\n'),
      'clean.css': [
        '.mark { font-size: var(--fs-micro); }',
        '.lead { font-size: calc(var(--fs-lead) + 4px); }',
        '.rem { font-size: 0.75rem; }',
        '.clamp { font-size: clamp(12px, 4vw, 40px); }',
        '.shorthand { font: 700 13px/1.4 var(--label); }',
        '@media (max-width: 1023px) { .mark { font-size: 15px; } }',
        '.row { min-width: 0; }',
        '',
      ].join('\n'),
    });
    expect(problems).toEqual([]);
    expect(MIN_FONT_PX).toBe(12);
  });
});
