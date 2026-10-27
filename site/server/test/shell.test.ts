import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The shell and the palette as shipped (BOOK-DOC-3 §3, BOOK-DOC-6 Job B).
 *
 * These are string checks on the files the browser gets before React runs — the shell's
 * metadata and the CSS. They exist because three of them regressed invisibly: a genre label
 * and a length promise in the share card, a warm-beige paper with a grain layer, and empty
 * TOC numerals dimmed to `--ink-3`. They live on the server side because a `web/` source file
 * may not touch `node:` (arch rule 2), and this is a build guard, not a component test.
 */

const WEB = join(import.meta.dirname, '..', '..', 'web');
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const styles = Object.fromEntries(
  ['base', 'book', 'cascade', 'chrome', 'chronicle', 'focus', 'live', 'tokens'].map((name) => [
    name,
    readFileSync(join(WEB, 'src', 'styles', `${name}.css`), 'utf8'),
  ]),
);
const css = Object.values(styles).join('\n');

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
    const day = rule(':root', styles.tokens);
    expect(day).toContain('--paper: #cfd3d2');
    expect(day).toContain('--paper-2: #dde1e0');
    expect(day).toContain('--ink: #14171a');
    expect(day).toContain('--ink-2: #4e5455');
    expect(day).toContain('--rule: #a6adac');
    const night = rule("[data-theme='night']", styles.tokens);
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
    // BOOK-DOC-35 §5: a 12px numeral needs a 26px row to keep the column quiet, and the four
    // part heads lose 8px of air each so the two-column spread still fits the sheet.
    expect(rule('.toc-row-empty')).toContain('height: 26px');
    expect(rule('.toc-part-h')).toContain('padding: 32px 0 10px');
    expect(rule('.toc-link')).toContain('min-height: 44px');
  });
});
