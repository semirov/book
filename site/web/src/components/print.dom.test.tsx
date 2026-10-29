// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { passSpanOf } from '../lib/passDiff.ts';
import { PRINT } from '../lib/printPlan.ts';
import { printFollowState, resetPrintFollow } from '../lib/printFollow.ts';
import { PrintFollow } from './PrintFollow.tsx';
import { PrintPass } from './PrintPass.tsx';
import { rules } from './cssRules.ts';

/**
 * BOOK-220 §11.2 — the printing renderer, measured in the tree.
 *
 * jsdom lays nothing out, so the boxes are injected and the frames are pulled by hand: the
 * layout is a grid (20 graphemes a line, 12 px a cell, 30 px a line) and `requestAnimationFrame`
 * is a queue. What is asserted is the contract and only the contract: one caret node, a
 * monotonic reveal through a clip whose edge is the caret, a ghost that holds a deletion's
 * geometry (struck, then gone), a replacement in one beat, a rewrite that prints per character
 * with no cross-fade anywhere, the reduced-motion mark, and «следить»'s four rules.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', { query: '?raw', import: 'default', eager: true });

const START = 1_764_000_000_000;
const PER = 20;
const CELL = 12;
const LINE = 30;
const WIDTH = PER * CELL;
/** The printing block starts below the fold: following it means scrolling down, never up. */
const BLOCK_TOP = 1_200;

const box = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;


let frames: FrameRequestCallback[] = [];
let clock = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let scrolled: number[] = [];
/** Every draw is a new print: the page keys a renderer by the pass it belongs to. */
let printKey = 0;
let scrollY = 0;

function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('p-pass') || this.classList.contains('pass-copy')) return box(BLOCK_TOP, 0, WIDTH, 8 * LINE);
    return box(0, 0, 0, 0);
  });
  type RectFn = { getClientRects: () => DOMRectList };
  const proto = Range.prototype as unknown as RectFn;
  if (typeof proto.getClientRects !== 'function') proto.getClientRects = () => [] as unknown as DOMRectList;
  vi.spyOn(proto, 'getClientRects').mockImplementation(function (this: Range) {
    const index = this.startOffset;
    const top = BLOCK_TOP + Math.floor(index / PER) * LINE;
    const left = (index % PER) * CELL;
    return [box(top, left, CELL, LINE)] as unknown as DOMRectList;
  });
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: `${LINE}px` } as CSSStyleDeclaration);
}

beforeEach(() => {
  frames = [];
  clock = 1_000;
  scrolled = [];
  scrollY = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  stubLayout();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  (window as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy = (_x: number, y: number) => {
    // A document does not scroll above its own start: the stub clamps like the browser does.
    const next = Math.max(0, scrollY + y);
    const delta = next - scrollY;
    if (delta === 0) return;
    scrolled.push(delta);
    scrollY = next;
  };
  resetPrintFollow();
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPrintFollow();
});

async function step(ms: number): Promise<void> {
  const next = frames.shift();
  clock += ms;
  await act(async () => next?.(clock));
}

async function frames_(count: number, ms = 100): Promise<void> {
  for (let index = 0; index < count; index += 1) await step(ms);
}

/** Mount one print, and the head's control beside it (the page's own shape). */
async function draw(options: {
  text: string;
  before?: string;
  after?: string;
  nowAt?: number;
  reduced?: boolean;
  follow?: boolean;
  onSettled?: () => void;
}): Promise<HTMLParagraphElement> {
  const span = passSpanOf(options.before ?? '', options.after ?? options.text);
  if (span === null) throw new Error('the fixture names no change');
  if (container === null) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  printKey += 1;
  const key = printKey;
  await act(async () => {
    root?.render(
      <>
        {options.follow === true ? <PrintFollow /> : null}
        <PrintPass
          key={key}
          blockId="ch01#aaaa1111"
          text={options.text}
          span={span}
          startAt={START}
          now={() => START + (options.nowAt ?? 0)}
          reduced={options.reduced === true}
          onSettled={options.onSettled}
        />
      </>,
    );
  });
  const paragraph = container.querySelector<HTMLParagraphElement>('p.p-pass');
  if (paragraph === null) throw new Error('no printing paragraph');
  return paragraph;
}

const revealed = (paragraph: HTMLElement): number => Number(paragraph.getAttribute('data-revealed'));
const sheet = (path: string): string => {
  const found = Object.entries(sheets).find(([name]) => name.endsWith(`/${path}`));
  if (found === undefined) throw new Error(`no sheet ${path}`);
  return found[1];
};

describe('one caret, one clip', () => {
  it('paints exactly one caret element, and no blue/red pair anywhere', async () => {
    const text = 'Первый абзац стоит на месте, и его никто не трогал.';
    const paragraph = await draw({ text, before: 'стоит', after: 'стоит крепко' });
    expect(paragraph.querySelectorAll('.caret-ink')).toHaveLength(1);
    expect(paragraph.querySelector('.caret-read')).toBeNull();
    expect(paragraph.querySelector('.caret-write')).toBeNull();
    // The pair is gone from the sheet too, not only from the tree.
    const css = sheet('pass-live.css');
    expect(css).not.toContain('.caret-read');
    expect(css).not.toContain('.caret-write');
  });

  it('reveals monotonically, and the clip edge is the caret', async () => {
    const text = 'Она походила на мою подпись, как тень на человека, брошенная на снег.';
    const paragraph = await draw({ text, before: '', after: text });
    const copy = paragraph.querySelector<HTMLElement>('.pass-copy');
    if (copy === null) throw new Error('no copy');
    let seen = revealed(paragraph);
    const clips: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      await step(250);
      const now = revealed(paragraph);
      expect(now).toBeGreaterThanOrEqual(seen);
      seen = now;
      clips.push(copy.style.clipPath);
    }
    expect(seen).toBeGreaterThan(10);
    expect(clips.some((clip) => clip.startsWith('polygon('))).toBe(true);
    // An L-shaped polygon: the caret's line is cut at its x, the lines below stay dark.
    const first = clips.find((clip) => clip.startsWith('polygon(')) ?? '';
    expect(first.match(/px/gu)?.length).toBe(12);
    expect(copy.textContent).toBe(text);
  });

  it('lays the paragraph out once: the DOM node count does not follow the text', async () => {
    const long = 'слово '.repeat(600);
    const big = await draw({ text: long, before: 'иное '.repeat(200), after: long });
    // The copy is one text node: no character is an element, whatever the block's length.
    expect(big.querySelector('.pass-copy')?.querySelectorAll('*').length).toBe(0);
    const bigCount = big.querySelectorAll('*').length;
    await draw({ text: 'короткий блок', before: 'иное', after: 'короткий' });
    const shortCount = container?.querySelector('p.p-pass')?.querySelectorAll('*').length ?? -1;
    expect(shortCount).toBe(bigCount);
  });
});

describe('deletion', () => {
  it('keeps the removed text at its geometry, struck, and drops it after 600 ms', async () => {
    const text = 'абзац стоит на месте.';
    const paragraph = await draw({ text, before: 'Первый ', after: '' });
    const ghost = paragraph.querySelector<HTMLElement>('.pass-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe('Первый ');
    // The sheet gives the ghost its strike and takes it out of the flow: one node, no line.
    const css = sheet('pass-live.css');
    expect(css).toContain('.pass-ghost');
    expect(css).toMatch(/position:\s*absolute/u);
    expect(css).toMatch(/text-decoration:\s*line-through/u);
    expect(css).toMatch(/text-decoration-thickness:\s*1px/u);
    expect(css).toMatch(/text-decoration-color:\s*var\(--rule-2\)/u);
    // The removed text is never "deleted by not drawing": it is painted until the fade ends.
    expect(ghost?.style.opacity === '' || Number(ghost?.style.opacity) > 0.5).toBe(true);
    await frames_(4, 120);
    expect(paragraph.querySelector('.pass-ghost')).not.toBeNull();
    await frames_(4, 120);
    expect(paragraph.querySelector('.pass-ghost')).toBeNull();
    // The pass is over: no caret, the block is the ordinary paragraph.
    expect(paragraph.querySelector('.caret-ink')).toBeNull();
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
  });
});

describe('replacement and rewrite', () => {
  it('strikes the old text while the new one inks at the same place — one beat', async () => {
    const text = 'Она походила на мою роспись, как тень на человека.';
    const paragraph = await draw({ text, before: 'подпись', after: 'роспись' });
    await step(100);
    const ghost = paragraph.querySelector<HTMLElement>('.pass-ghost');
    expect(ghost?.textContent).toBe('под');
    const earlyOpacity = Number(ghost?.style.opacity ?? '1');
    const earlyReveal = revealed(paragraph);
    await step(200);
    const lateOpacity = Number(paragraph.querySelector<HTMLElement>('.pass-ghost')?.style.opacity ?? '0');
    expect(revealed(paragraph)).toBeGreaterThan(earlyReveal);
    expect(lateOpacity).toBeLessThan(earlyOpacity);
    expect(paragraph.querySelectorAll('.caret-ink')).toHaveLength(1);
  });

  it('a large rewrite prints per character — there is no cross-fade path', async () => {
    const text = 'Новый текст блока, переписанный целиком, без единого общего слова.';
    const paragraph = await draw({ text, before: 'Совсем другое предложение о другом.', after: text });
    const copy = paragraph.querySelector<HTMLElement>('.pass-copy');
    if (copy === null) throw new Error('no copy');
    // No opacity on the copy, ever: the reveal is a clip, not an appearance.
    expect(copy.style.opacity).toBe('');
    let previous = revealed(paragraph);
    for (let index = 0; index < 4; index += 1) {
      await step(300);
      const now = revealed(paragraph);
      expect(now - previous).toBeLessThan(text.length - 5);
      previous = now;
      expect(copy.style.opacity).toBe('');
    }
    expect(previous).toBeGreaterThan(5);
    expect(sheet('pass-live.css')).not.toMatch(/animation|transition/u);
  });

  it('a new block prints from its first character', async () => {
    const text = 'Первый абзац новой главы, которую только что написали.';
    const paragraph = await draw({ text, before: '', after: text });
    expect(revealed(paragraph)).toBe(0);
    await step(300);
    const first = revealed(paragraph);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThan(10);
    await frames_(6, 300);
    expect(revealed(paragraph)).toBeGreaterThan(first);
  });
});

describe('reduced motion', () => {
  it('sets the text at once, shows the strike for 600 ms, and never paints a caret', async () => {
    let settled = 0;
    const paragraph = await draw({ text: 'Абзац до правки.', before: 'до', after: 'после', reduced: true, onSettled: () => (settled += 1) });
    expect(paragraph.querySelector('.caret-ink')).toBeNull();
    expect(paragraph.querySelector('.pass-ghost')?.textContent).toBe('до');
    expect(paragraph.getAttribute('data-pass')).toBe('static');
    const copy = paragraph.querySelector<HTMLElement>('.pass-copy');
    expect(copy?.style.clipPath).toBe('none');
    expect(settled).toBe(0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, PRINT.strikeMs + 20));
    });
    expect(paragraph.querySelector('.pass-ghost')).toBeNull();
    expect(settled).toBe(1);
  });
});

describe('«следить»', () => {
  it('is absent while nothing prints, and appears with the print', async () => {
    expect(document.querySelector('.print-follow')).toBeNull();
    await draw({ text: 'Печатается абзац.', before: 'Печатается', after: 'Печатается новый', follow: true });
    const control = document.querySelector<HTMLButtonElement>('.print-follow');
    expect(control).not.toBeNull();
    expect(control?.textContent).toBe('следить');
    expect(control?.getAttribute('data-follow')).toBe('off');
  });

  it('keeps the caret on the 45 % line, one write per frame, nothing inside ±40 px', async () => {
    // The block sits at the top of the document; the caret walks down it, so without following
    // the page the caret's centre would fall far below the 45 % line.
    const text = 'слово '.repeat(400);
    // A whole-block rewrite: the caret walks the block, so the page has something to follow.
    const paragraph = await draw({ text, before: 'иное '.repeat(400), after: text, follow: true });
    const control = document.querySelector<HTMLButtonElement>('.print-follow');
    await act(async () => control?.click());
    expect(document.querySelector('.print-follow')?.getAttribute('data-follow')).toBe('on');

    /** The caret's own centre in document coordinates, read off the transform it was given. */
    const centre = (): number => {
      const caret = paragraph.querySelector<HTMLElement>('.caret-ink');
      const found = /translate3d\([^,]+,\s*(-?[\d.]+)px/u.exec(caret?.style.transform ?? '');
      return found === null ? 0 : BLOCK_TOP + Number(found[1]) + LINE / 2;
    };
    const target = (window.innerHeight as number) * 0.45;
    let worst = 0;
    let writesAfterFrames = 0;
    let started = false;
    for (let index = 0; index < 20; index += 1) {
      const before = scrolled.length;
      await step(250);
      const here = Math.abs(centre() - scrollY - target);
      if (scrolled.length > before) {
        started = true;
        // The write landed the centre on the line: the band is 40 px, so the residual is smaller.
        writesAfterFrames += 1;
        worst = Math.max(worst, here);
        expect(here).toBeLessThanOrEqual(40);
      } else if (started) {
        // No write while inside the band (or a line's worth of ink has not moved it out yet).
        expect(here).toBeLessThanOrEqual(40 + LINE);
      }
    }
    expect(writesAfterFrames).toBeGreaterThan(1);
    expect(scrolled.length).toBeLessThanOrEqual(20);
    expect(worst).toBeLessThanOrEqual(40);
  });

  it('turns off on a manual scroll, and says so on the control', async () => {
    await draw({ text: 'Печатается абзац целиком.', before: 'абзац', after: 'абзац новый', follow: true });
    await act(async () => document.querySelector<HTMLButtonElement>('.print-follow')?.click());
    expect(document.querySelector('.print-follow')?.getAttribute('data-follow')).toBe('on');
    await act(async () => {
      window.dispatchEvent(new Event('wheel'));
    });
    expect(document.querySelector('.print-follow')?.getAttribute('data-follow')).toBe('off');
    const written = scrolled.length;
    await frames_(3, 200);
    expect(scrolled.length).toBe(written);
  });

  it('survives a chapter boundary: the next print keeps the state, and idle takes the control away', async () => {
    await draw({ text: 'Первый абзац главы.', before: 'Первый', after: 'Первый новый', follow: true });
    await act(async () => document.querySelector<HTMLButtonElement>('.print-follow')?.click());
    await frames_(6, 400);
    // The block settled; the next chapter's print begins with the same store.
    await draw({ text: 'Первый абзац следующей главы.', before: 'Первый', after: 'Первый второй', follow: true });
    expect(document.querySelector('.print-follow')?.getAttribute('data-follow')).toBe('on');
    // The print ends and the control leaves the head — while the state itself survives the
    // chapter boundary, which is what the next print will read.
    await frames_(12, 500);
    expect(document.querySelector('.print-follow')).toBeNull();
    expect(printFollowState().on).toBe(true);
  });
});

describe('the sheet', () => {
  it('names the one caret and the ghost and nothing character-sized', () => {
    const css = sheet('pass-live.css');
    expect(css).toContain('.caret-ink');
    expect(css).toContain('.pass-copy');
    expect(css).not.toContain('.pg');
    expect(rules(css).some(([selector]) => selector === '.p-pass')).toBe(true);
  });
});
