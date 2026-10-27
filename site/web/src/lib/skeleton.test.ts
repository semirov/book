import { describe, expect, it } from 'vitest';

import skeletonCss from '../styles/skeleton.css?raw';
import tokensCss from '../styles/tokens.css?raw';
import {
  CHAPTER_BOX_PX,
  CHAPTER_WIDTHS,
  SKELETON_LINES,
  SKELETON_MIN_HEIGHT_PX,
  statusLine,
  type SkeletonSurface,
} from './skeleton.ts';

/**
 * BOOK-DOC-43 §3 and §6 — the numbers a coder must not invent (BOOK-66).
 *
 * Two things live here: the table the component renders from, and the copy the status line
 * prints. The last block reads the sheets as text, because the widths and the reserves are CSS
 * the table cannot prove on its own — and a stylesheet read that came back empty would make
 * that block pass for nothing, so the reads are pinned non-empty first.
 */

const SURFACES: readonly SkeletonSurface[] = ['boot', 'chapter', 'register', 'chronicle', 'authors', 'chain', 'sheet'];

describe('the shape of a placeholder', () => {
  it('draws a chapter as 3 / 3 / 2 prose lines and every list as three rows', () => {
    expect(SKELETON_LINES.chapter).toEqual([3, 3, 2]);
    expect(SKELETON_LINES.register).toEqual([3]);
    expect(SKELETON_LINES.chronicle).toEqual([3]);
    expect(SKELETON_LINES.authors).toEqual([3]);
    expect(SKELETON_LINES.chain).toEqual([3]);
    expect(SKELETON_LINES.sheet).toEqual([2, 2]);
  });

  it('ends its lines raggedly: the eight §3 widths, in order, none of them full', () => {
    expect(CHAPTER_WIDTHS).toEqual([94, 88, 62, 97, 91, 55, 90, 68]);
    expect(CHAPTER_WIDTHS.some((width) => width === 100)).toBe(false);
    // The three paragraph endings 62 / 55 / 68 are the signature that this is prose.
    expect([CHAPTER_WIDTHS[2], CHAPTER_WIDTHS[5], CHAPTER_WIDTHS[7]]).toEqual([62, 55, 68]);
  });

  it('reserves the surface heights of §3, and nothing for boot or chapter', () => {
    expect(SKELETON_MIN_HEIGHT_PX).toEqual({
      register: 236,
      chronicle: 150,
      authors: 132,
      chain: 220,
      sheet: 176,
    });
  });

  it('floors the chapter box at the form’s own worst case (§3, corrected)', () => {
    expect(CHAPTER_BOX_PX).toBe(279);
    // 8 lines of 1.68em plus two paragraph gaps of 1.02em, at the widest prose size (18 px):
    // 278.64 px. The form therefore fits the box it sits in, and a short chapter cannot grow
    // the page — the CLS §3 forbids.
    expect(8 * 1.68 * 18 + 2 * 1.02 * 18).toBe(278.64);
    expect(CHAPTER_BOX_PX).toBeGreaterThanOrEqual(278.64);
    // The floor is the form's height, not a new reserve: the surface list above stays as is.
    expect('chapter' in SKELETON_MIN_HEIGHT_PX).toBe(false);
  });
});

describe('the one sentence a wait may say', () => {
  it('says nothing while the wait is quiet, on every surface', () => {
    for (const surface of SURFACES) expect(statusLine(surface, 'quiet', 7)).toBeNull();
  });

  it('names the chapter it is reading, as a field number', () => {
    expect(statusLine('chapter', 'skeleton', 7)).toBe('читаем главу 07');
    expect(statusLine('chapter', 'slow', 7)).toBe('глава идёт дольше обычного · текст появится здесь же');
    // A chapter status with no number keeps the verb and invents no field number: the app
    // always passes `entry.n`, so this is the defensive branch, not a second copy.
    expect(statusLine('chapter', 'skeleton')).toBe('читаем главу');
  });

  it('prints the §6 label register on every surface, and its slow sentence', () => {
    expect(SURFACES.filter((surface) => surface !== 'chapter').map((surface) => statusLine(surface, 'skeleton'))).toEqual([
      'опись читается',
      'замечания читаются',
      'записи читаются',
      'доли считаются',
      'цепочка читается…',
      'правка читается',
    ]);
    expect(SURFACES.map((surface) => statusLine(surface, 'slow', 7))).toEqual([
      'опись идёт дольше обычного · книга откроется здесь же',
      'глава идёт дольше обычного · текст появится здесь же',
      'замечания идут дольше обычного · строки появятся здесь же',
      'записи идут дольше обычного · хроника появится здесь же',
      'доли считаются дольше обычного · цифры появятся здесь же',
      'цепочка идёт дольше обычного · история появится здесь же',
      'правка идёт дольше обычного · лист заполнится здесь же',
    ]);
    // No surface promises progress the page cannot measure.
    for (const surface of SURFACES) {
      for (const stage of ['skeleton', 'slow'] as const) {
        const line = statusLine(surface, stage, 7) ?? '';
        expect(line).not.toMatch(/почти готово|осталось|подождите|%|загруз/iu);
      }
    }
  });
});

describe('the sheets carry the same numbers', () => {
  it('declares all eight width tokens and uses each one', () => {
    // Why these reads are not vacuous: a failed `?raw` import comes back as an empty string,
    // and every assertion below would then miss the same way. Pin the anchors first.
    expect(tokensCss).toContain('--skel-w1:');
    expect(skeletonCss).toContain('.skel-line');
    CHAPTER_WIDTHS.forEach((width, index) => {
      expect(tokensCss).toContain(`--skel-w${index + 1}: ${width}%;`);
      expect(skeletonCss).toContain(`width: var(--skel-w${index + 1});`);
    });
    // Geometry, not ink: the widths are not repainted for the night register.
    expect(tokensCss).not.toMatch(/\[data-theme='night'\][\s\S]*--skel-w/u);
  });

  it('reserves every row height as a literal min-height, and gives the chapter none', () => {
    for (const [variant, px] of Object.entries(SKELETON_MIN_HEIGHT_PX)) {
      expect(skeletonCss, variant).toContain(`.skel-${variant} {\n  min-height: ${px}px;`);
    }
    // The chapter's reserve is the existing `.ch-placeholder` box: a height here would make
    // the placeholder add pixels instead of zero.
    expect(skeletonCss).not.toMatch(/\.skel-chapter[^{]*\{[^}]*height/iu);
  });

  it('is one 120 ms fade in, on the wrapper, with nothing inside it moving', () => {
    expect(skeletonCss).toContain('animation: skel-in var(--dur-tick) var(--ease-out) both;');
    expect(skeletonCss).toContain('@keyframes skel-in');
    expect(skeletonCss).not.toMatch(/shimmer|spinner|gradient|background-position|transition/iu);
    // A bar is a 2 px hairline in a 1.68 em line box, at the optical centre of the line.
    expect(skeletonCss).toContain('top: calc(0.55 * 1.68em - 1px);');
    expect(skeletonCss).toContain('background: var(--rule-2);');
  });
});
