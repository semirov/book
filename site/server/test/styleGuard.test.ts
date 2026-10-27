import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHIP_SELECTORS, LADDER, MIN_FONT_PX, styleProblems } from '../../scripts/styles.mjs';

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
  it('reports nothing on this repository: the floor holds, the regime is adaptive, the chips resolve', () => {
    // `requireChips` is the mode `arch.mjs` runs: every chip of BOOK-70 must have a rule here,
    // including the three reference lines (`.stamp-time`, `.ch-data`, `.seam-filing-stamp`).
    expect(styleProblems(STYLES, { requireChips: true })).toEqual([]);
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
    for (const name of ['base.css', 'book.css', 'chrome.css', 'legal.css', 'live.css']) {
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

  it('fails a shimmer, a spinner and a hand-built moving gradient, on their own lines', () => {
    const problems = seeded({
      'bg.css': ['.x { width: 10px; }', '.y { background-position: 0 0; }', ''].join('\n'),
      'shimmer.css': ['.a { color: var(--ink); }', '.a::after { animation-name: shimmer; }', ''].join('\n'),
      'spinner.css': ['.s .spinner { width: 12px; }', ''].join('\n'),
    });
    expect(problems.map((problem) => `${problem.file.split('/').pop()}:${problem.line}`)).toEqual([
      'bg.css:2',
      'shimmer.css:2',
      'spinner.css:1',
    ]);
    expect(problems.map((problem) => problem.message)).toEqual([
      'background-position — a moving gradient is a shimmer built by hand (BOOK-DOC-43 §5)',
      'shimmer — a placeholder never animates time passing; it is a static form with blank fields (BOOK-DOC-43 §5)',
      'spinner — a failing fetch is a sentence and a retry, never a spinner (chrome.css:173, BOOK-DOC-43 §5)',
    ]);
    // The house rule lives in a comment today: a commented word is not a declaration.
    expect(seeded({ 'chrome.css': ['/* never a spinner, never a shimmer */', '.a { color: var(--ink); }', ''].join('\n') })).toEqual([]);
  });

  it('admits one fade in a .skel rule, and nothing else that moves', () => {
    // The one legal motion: the exact shorthand, on the wrapper itself.
    expect(
      seeded({
        'skel.css': [
          '.skel {',
          '  opacity: 1;',
          '  animation: skel-in var(--dur-tick) var(--ease-out) both;',
          '}',
          '.skel-line::before { background: var(--rule-2); }',
          '',
        ].join('\n'),
      }),
    ).toEqual([]);

    const problems = seeded({
      'loop.css': ['.skel { opacity: 1; }', '.skel-register { animation: pulse 1s infinite; }', ''].join('\n'),
      'named.css': ['.skel .skel-line { animation-name: blink; }', '.skel-p { animation-iteration-count: infinite; }', ''].join('\n'),
      // The two false negatives the review found: a descendant selector and a longhand that
      // overrides the otherwise legal shorthand.
      'nested.css': ['.focus-stage .skel-sheet { animation: pulse 1s infinite; }', ''].join('\n'),
      'override.css': ['.skel { animation: skel-in var(--dur-tick) var(--ease-out) both; animation-duration: 4s; }', ''].join('\n'),
    });
    expect(problems.map((problem) => `${problem.file.split('/').pop()}:${problem.line}`)).toEqual([
      'loop.css:2',
      'named.css:1',
      'named.css:2',
      'nested.css:1',
      'override.css:1',
    ]);
    expect(problems[0]?.message).toBe(
      'animation: pulse 1s infinite — a .skel rule admits only «skel-in var(--dur-tick) var(--ease-out) both», the one 120 ms fade in (BOOK-DOC-43 §5)',
    );
    // A longhand is a problem by name — including `animation-name: skel-in`, which overrides
    // the shorthand instead of restating it.
    expect(problems[1]?.message).toBe(
      'animation-name: blink — the shorthand «skel-in var(--dur-tick) var(--ease-out) both» is the only motion a placeholder owns; a longhand such as animation-name overrides it (BOOK-DOC-43 §5)',
    );
    expect(problems[2]?.message).toBe(
      'animation-iteration-count: infinite — the shorthand «skel-in var(--dur-tick) var(--ease-out) both» is the only motion a placeholder owns; a longhand such as animation-iteration-count overrides it (BOOK-DOC-43 §5)',
    );
    expect(problems[3]?.message).toBe(
      'animation: pulse 1s infinite — a .skel rule admits only «skel-in var(--dur-tick) var(--ease-out) both», the one 120 ms fade in (BOOK-DOC-43 §5)',
    );
    expect(problems[4]?.message).toBe(
      'animation-duration: 4s — the shorthand «skel-in var(--dur-tick) var(--ease-out) both» is the only motion a placeholder owns; a longhand such as animation-duration overrides it (BOOK-DOC-43 §5)',
    );
  });

  it('reads the last compound of a selector: a child, a descendant and a pseudo-element are silent when still', () => {
    expect(
      seeded({
        'clean.css': [
          '.page > .skel-chapter { color: var(--ink); }',
          '@media (max-width: 599px) { .skel-x { color: var(--ink); } }',
          '.skel-line:hover::before { background: var(--rule); }',
          '/* .skel { animation: pulse 1s infinite; } — a commented rule is not a rule */',
          '',
        ].join('\n'),
      }),
    ).toEqual([]);
    // A skeleton class that is only a name prefix is not the skeleton: `.skeleton` is no rule.
    expect(seeded({ 'x.css': ['.skeleton { animation: pulse 1s infinite; }', ''].join('\n') })).toEqual([]);
  });
});

/**
 * BOOK-70 — the chips. Two audits agreed on one form: one size for every chip (12 px), one of
 * two inks, one line, never an ellipsis, never a motion; a reference chip is mono and tabular;
 * a receipt is a sentence at 14 px. The registry is the contract, so a chip that loses its rule
 * or drifts by a pixel fails here as well as in `arch.mjs`.
 */
describe('BOOK-70 — the chips', () => {
  /** The ten chips, complete and legal: a sheet set the registry can check. */
  const CHIPS: Record<string, string> = {
    '.ch-print': 'font-size: 12px; color: var(--live); white-space: nowrap',
    '.sec-meta': 'font-size: 12px; color: var(--ink-3); white-space: nowrap',
    '.seam-filing-n': 'font-family: var(--mono); font-size: 12px; letter-spacing: .02em; font-variant-numeric: tabular-nums; white-space: nowrap',
    '.author-plus': 'font-family: var(--mono); font-size: 12px; letter-spacing: .02em; font-variant-numeric: tabular-nums; white-space: nowrap',
    '.seam-filing-stamp': 'font-family: var(--mono); font-size: 12px; letter-spacing: .02em; font-variant-numeric: tabular-nums; white-space: nowrap',
    '.stamp-time': 'font-family: var(--mono); font-size: 12px; letter-spacing: .02em; font-variant-numeric: tabular-nums; white-space: nowrap',
    '.ch-data': 'font-family: var(--mono); font-size: 12px; letter-spacing: .02em; font-variant-numeric: tabular-nums; white-space: nowrap',
    '.stamp-state': 'font-size: 12px; color: var(--ink-3); white-space: nowrap',
    '.filing-state': 'font-size: 12px; color: var(--ink-3); white-space: nowrap',
    '.filing-sentence': 'font-size: 14px; color: var(--ink-2)',
  };

  function sheet(overrides: Record<string, string> = {}, omit: string[] = []): string {
    return Object.entries({ ...CHIPS, ...overrides })
      .filter(([selector]) => !omit.includes(selector))
      .map(([selector, body]) => `${selector} { ${body}; }`)
      .join('\n');
  }

  const messages = (problems: Array<{ message: string }>): string[] => problems.map((problem) => problem.message);

  it('pins the registry: ten chips, each with a tier and a fact', () => {
    expect(CHIP_SELECTORS.map((chip) => chip.selector)).toEqual([
      '.ch-print',
      '.sec-meta',
      '.seam-filing-n',
      '.author-plus',
      '.seam-filing-stamp',
      '.stamp-time',
      '.ch-data',
      '.stamp-state',
      '.filing-state',
      '.filing-sentence',
    ]);
    for (const chip of CHIP_SELECTORS) {
      expect(['state', 'count', 'ref', 'sentence']).toContain(chip.tier);
      expect(chip.fact.length, chip.selector).toBeGreaterThan(10);
    }
    // Every moment and numeral the guard can prove is registered as a reference line.
    expect(CHIP_SELECTORS.filter((chip) => chip.tier === 'ref').map((chip) => chip.selector)).toEqual([
      '.seam-filing-n',
      '.author-plus',
      '.seam-filing-stamp',
      '.stamp-time',
      '.ch-data',
    ]);
    expect(CHIP_SELECTORS.filter((chip) => chip.tier === 'sentence').map((chip) => chip.selector)).toEqual(['.filing-sentence']);
    // `.qline` is a data line, not a chip: a chip never carries a second voice beside it.
    expect(CHIP_SELECTORS.map((chip) => chip.selector)).not.toContain('.qline');
    // BOOK-112 removed the header's `.live` chip: the reading surface prints no state at all.
    expect(CHIP_SELECTORS.map((chip) => chip.selector)).not.toContain('.live');
  });

  it('passes a complete chip set, and reads a chip declared inside a grouped selector list', () => {
    expect(seeded({ 'chips.css': sheet() })).toEqual([]);
    // The same chip, reachable only through a group: `.ch-print` and `.brand` share the rule.
    const grouped = seeded({
      'chips.css': `.ch-print, .brand { font-size: 12px; color: var(--live); white-space: nowrap; }\n${sheet({}, ['.ch-print'])}`,
    });
    expect(grouped).toEqual([]);
  });

  it('fails a chip that is 11 px or 13 px: the size is one', () => {
    const under = seeded({ 'chips.css': sheet({ '.ch-print': 'font-size: 11px; color: var(--live); white-space: nowrap' }) });
    expect(messages(under)).toContain('.ch-print: font-size: 11px resolves to 11px, but a state chip is 12px');
    const over = seeded({ 'chips.css': sheet({ '.sec-meta': 'font-size: 13px; color: var(--ink-3); white-space: nowrap' }) });
    expect(messages(over)).toContain('.sec-meta: font-size: 13px resolves to 13px, but a count chip is 12px');
    // A size that cannot be proven is a failure too, not a pass.
    const unknown = seeded({ 'chips.css': sheet({ '.ch-print': 'font-size: var(--nope); color: var(--live); white-space: nowrap' }) });
    expect(messages(unknown)).toContain('.ch-print: font-size: var(--nope) cannot be proven to be 12px');
  });

  it('fails a chip that animates, shimmers, transitions or clips itself', () => {
    const base = CHIPS['.ch-print'] as string;
    for (const [property, message] of [
      ['animation: pulse 1s infinite', '.ch-print: a chip never animates — no animation'],
      ['transition: color 120ms', '.ch-print: a chip never animates — no transition'],
      ['text-overflow: ellipsis', '.ch-print: a chip is never ellipsized — an ellipsized state is a lie'],
      ['overflow: hidden', '.ch-print: a chip may not clip its own line — overflow would hide the fact it states'],
    ] as const) {
      const problems = seeded({ 'chips.css': sheet({ '.ch-print': `${base}; ${property}` }) });
      expect(messages(problems), property).toContain(message);
    }
  });

  it('fails a chip that would wrap or ellipsize: one line, nowrap', () => {
    const problems = seeded({ 'chips.css': sheet({ '.stamp-state': 'font-size: 12px; color: var(--ink-3)' }) });
    expect(messages(problems)).toContain('.stamp-state: a chip takes one line — white-space: nowrap');
    // A sentence may wrap, so its missing nowrap is not a problem.
    expect(seeded({ 'chips.css': sheet({ '.filing-sentence': 'font-size: 14px; color: var(--ink-2); white-space: normal' }) })).toEqual([]);
  });

  it('fails a third ink on a state or count chip, and a reference chip that is not mono/tabular', () => {
    const ink = seeded({ 'chips.css': sheet({ '.filing-state': 'font-size: 12px; color: var(--revise); white-space: nowrap' }) });
    expect(messages(ink)).toContain(".filing-state: a chip's ink is var(--live) or var(--ink-3), not var(--revise)");
    const inherited = seeded({ 'chips.css': sheet({ '.ch-print': 'font-size: 12px; white-space: nowrap' }) });
    expect(messages(inherited)).toContain(".ch-print: a chip's ink is var(--live) or var(--ink-3), not inherited");

    const voice = seeded({ 'chips.css': sheet({ '.author-plus': 'font-size: 12px; letter-spacing: .12em; white-space: nowrap' }) });
    expect(messages(voice)).toContain('.author-plus: a reference chip is mono — font-family: var(--mono)');
    expect(messages(voice)).toContain('.author-plus: a reference chip is set at .02em, not .12em');
    expect(messages(voice)).toContain('.author-plus: a reference chip is tabular');
  });

  it('fails a sentence set at chip size, and a registered chip with no rule at all', () => {
    const sentence = seeded({ 'chips.css': sheet({ '.filing-sentence': 'font-size: 12px; color: var(--ink-2)' }) });
    expect(messages(sentence)).toContain('.filing-sentence: font-size: 12px resolves to 12px, but a sentence is 14px');

    const missing = seeded({ 'chips.css': sheet({}, ['.filing-sentence']) });
    expect(messages(missing)).toContain(
      '.filing-sentence: a registered chip has no rule in the sheets — the BOOK-70 registry cannot outlive the rule',
    );
  });

  it('reports the chip’s own rule, not the sheet it happens to be grouped in', () => {
    const problems = seeded({
      'a.css': '.ch-print { font-size: 12px; color: var(--live); white-space: nowrap; }',
      'b.css': '.ch-print { animation: blink 2s infinite; }',
    });
    const hit = problems.find((problem) => problem.message.includes('never animates'));
    expect(hit?.file.split('/').pop()).toBe('b.css');
    expect(hit?.line).toBe(1);
  });

  it('fails on the real sheets when a chip loses its rule — the registry cannot rot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-chips-'));
    try {
      for (const name of readdirSync(STYLES)) {
        const css = readFileSync(join(STYLES, name), 'utf8');
        writeFileSync(join(dir, name), css.replace(/\.filing-sentence \{[^}]*\}/u, ''), 'utf8');
      }
      expect(messages(styleProblems(dir))).toContain(
        '.filing-sentence: a registered chip has no rule in the sheets — the BOOK-70 registry cannot outlive the rule',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports every absent chip in the real-tree mode, and stays quiet for a fixture', () => {
    // The hatch that made deleting the whole registry pass: a set with no chip at all used to be
    // read as a fixture. `arch.mjs` asks for `requireChips`, so all eleven absences are findings.
    const empty = seeded({ 'base.css': 'body { margin: 0; }\n' });
    expect(empty).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'book-chips-empty-'));
    try {
      writeFileSync(join(dir, 'base.css'), 'body { margin: 0; }\n', 'utf8');
      const strict = styleProblems(dir, { requireChips: true });
      expect(strict.map((problem) => problem.message.split(':')[0])).toEqual(CHIP_SELECTORS.map((chip) => chip.selector));
      expect(strict.every((problem) => problem.message.includes('no rule in the sheets'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges a compound or a functional-pseudo selector, and not a longer class name', () => {
    // `.sec-meta.is-huge` and `:is(.brand, .sec-meta)` used to slip past the exact-match merge.
    for (const bypass of ['.sec-meta.is-huge', ':is(.brand, .sec-meta)', '.sec-meta[data-huge]', '.sec-meta:hover']) {
      const problems = seeded({ 'chips.css': `${sheet()}\n${bypass} { font-size: 20px; }\n` });
      expect(messages(problems), bypass).toContain('.sec-meta: font-size: 20px resolves to 20px, but a count chip is 12px');
    }
    // True negatives: a different class that starts with the same letters, and a part whose
    // subject is a child (`.sec-meta .dot`, `.sec-meta.idle .dot`) are not the chip's own declaration.
    expect(seeded({ 'chips.css': `${sheet()}\n.sec-metawire { font-size: 20px; }\n` })).toEqual([]);
    expect(seeded({ 'chips.css': `${sheet()}\n.sec-meta .dot { font-size: 20px; }\n` })).toEqual([]);
    expect(seeded({ 'chips.css': `${sheet()}\n.sec-meta.idle .dot { font-size: 20px; }\n` })).toEqual([]);
  });
});
