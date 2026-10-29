/**
 * BOOK-199 (audit #21) — the palette, measured. WCAG 2.2, normal text: every pair a reader can
 * meet as a word must be ≥4.5:1 against the paper it sits on.
 *
 * The numbers are computed from `tokens.css` itself, so the table cannot drift from the sheet:
 * darkening or lightening a mark is a change this file sees. Two fills are translucent, so their
 * pair is the composite of `--live-bg` / `--revise-bg` over the paper of the theme — the colour a
 * glyph actually stands on.
 */

import { describe, expect, it } from 'vitest';

import tokens from './tokens.css?raw';

const sheets = import.meta.glob<string>('./*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Themes as tokens.css declares them: the day palette on `:root`, night on `[data-theme]`. */
const THEMES = [
  { name: 'day', selector: String.raw`:root\s*\{` },
  { name: 'night', selector: String.raw`\[data-theme='night'\]\s*\{` },
] as const;

type Rgb = [number, number, number];
type Token = { kind: 'hex'; rgb: Rgb } | { kind: 'rgba'; rgb: Rgb; alpha: number };

/** The declarations of the first block opened by `selector`, comments stripped. */
function blockOf(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const open = new RegExp(selector, 'u').exec(bare);
  if (open === null) return '';
  const start = open.index + open[0].length;
  let depth = 1;
  for (let index = start; index < bare.length; index += 1) {
    if (bare[index] === '{') depth += 1;
    if (bare[index] === '}') depth -= 1;
    if (depth === 0) return bare.slice(start, index);
  }
  return bare.slice(start);
}

/** A colour token, or `null` for anything that is not a colour (a size, a family, a name). */
function tokenOf(value: string): Token | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{6})$/iu.exec(text);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    return {
      kind: 'hex',
      rgb: [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as Rgb,
    };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu.exec(text);
  if (rgba !== null) {
    return {
      kind: 'rgba',
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])] as Rgb,
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return null;
}

function paletteOf(selector: string): Map<string, Token> {
  const block = blockOf(tokens, selector);
  const palette = new Map<string, Token>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/giu)) {
    const token = tokenOf(match[2] ?? '');
    if (token !== null) palette.set(match[1] ?? '', token);
  }
  return palette;
}

/** The colour a token paints on `paper`: a solid value, or a translucent one composited on it. */
function rgbOf(palette: Map<string, Token>, name: string, paper: Rgb): Rgb {
  const token = palette.get(name);
  if (token === undefined) throw new Error(`${name} is not a colour in this theme`);
  if (token.kind === 'hex' || token.alpha >= 1) return token.rgb;
  return token.rgb.map(
    (channel, index) => Math.round(channel * token.alpha + (paper[index] ?? 0) * (1 - token.alpha)),
  ) as Rgb;
}

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG 2.2 contrast ratio: (L1 + 0.05) / (L2 + 0.05), lighter over darker. */
function ratio(foreground: Rgb, background: Rgb): number {
  const one = luminance(foreground);
  const two = luminance(background);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

/**
 * Every pair a word can stand on. The tinted fills are the composites of the accent's own wash,
 * because that is what the paper under the glyph really is.
 */
const PAIRS = [
  { name: '--ink on --paper (a reader’s name)', ink: '--ink', on: '--paper' },
  { name: '--ink-2 on --paper', ink: '--ink-2', on: '--paper' },
  { name: '--ink-3 on --paper', ink: '--ink-3', on: '--paper' },
  { name: '--ink-3 on --live-bg', ink: '--ink-3', on: '--live-bg' },
  { name: '--ink-3 on --revise-bg', ink: '--ink-3', on: '--revise-bg' },
  { name: '--live on --paper', ink: '--live', on: '--paper' },
  { name: '--live on --live-bg', ink: '--live', on: '--live-bg' },
  { name: '--revise on --paper', ink: '--revise', on: '--paper' },
  { name: '--revise on --revise-bg', ink: '--revise', on: '--revise-bg' },
] as const;

describe('the palette measures up (WCAG 2.2, normal text ≥4.5)', () => {
  for (const theme of THEMES) {
    it(`holds every ink pair in the ${theme.name} palette`, () => {
      const palette = paletteOf(theme.selector);
      const paper = rgbOf(palette, '--paper', [0, 0, 0]);
      for (const pair of PAIRS) {
        // The background is the composite too, so a tinted fill is measured as it is painted.
        const background = rgbOf(palette, pair.on, paper);
        const value = ratio(rgbOf(palette, pair.ink, paper), background);
        expect(Number(value.toFixed(2)), `${theme.name}: ${pair.name} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('never uses the hairline tokens as a text ink', () => {
    // `--rule-2` is 2.1:1 on paper: a rule is not a word (BOOK-199, `.note-action:disabled`).
    for (const [name, css] of Object.entries(sheets)) {
      const bare = css.replace(/\/\*[\s\S]*?\*\//gu, '');
      expect(bare, name).not.toMatch(/(?:^|[;{\s])color\s*:\s*var\(--rule-?2?\)/u);
    }
  });
});
