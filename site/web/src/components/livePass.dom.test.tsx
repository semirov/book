// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { passSpanOf, type PassSpan } from '../lib/passDiff.ts';
import type { PassLayout } from '../lib/passMotion.ts';
import { PASS_FIXTURES } from '../lib/passMotionFixtures.ts';
import { LivePass } from './LivePass.tsx';

/**
 * BOOK-121 — the renderer that paints one pass in place.
 *
 * jsdom lays nothing out, so the boxes are injected through `getBoundingClientRect` and the
 * frames are pulled by hand: `requestAnimationFrame` is a queue and `performance.now` is a knob,
 * which is what makes "what is true at 200 ms" an assertion instead of a race.
 *
 * What this proves: the layout handed to `planPass` is the fixture's own; the ink toggles only
 * the graphemes the engine reaches; the run is laid out once and its text never changes; both
 * carets are placed from the engine's lines and never stand in one place; every exit (settled,
 * reduced, late, unmounted) behaves. What it cannot prove: that the boxes in a real browser are
 * where the paragraph puts them, and that the ink forces no reflow there — that is the browser
 * recording.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const START = 1_764_000_000_000;
const LINE = 30.24;

const rect = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** The block and its run, laid out as the fixture says: `per` graphemes a line from `firstLine`. */
function stubRects(options: { per: number; firstLine: number; blockLines: number }): ReturnType<typeof vi.spyOn> {
  const { per, firstLine, blockLines } = options;
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('p-pass')) return rect(0, 0, 342, blockLines * LINE);
    const index = Number(this.getAttribute('data-i') ?? '-1');
    if (index < 0) return rect(0, 0, 0, 0);
    return rect((firstLine + Math.floor(index / per)) * LINE, 8 + (index % per) * 12, 12, LINE);
  });
}

type DrawOptions = {
  text: string;
  span: PassSpan;
  /** What the injected `now` answers; the pass's own clock is `startAt` = `START`. */
  nowAt?: number;
  reduced?: boolean;
  onSettled?: () => void;
  onMeasure?: (layout: PassLayout) => void;
};

let frames: FrameRequestCallback[] = [];
let clock = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  frames = [];
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  // The sheet sets the leading; jsdom has no cascade, so the declared line box is injected the
  // same way the boxes are. The fallback (gaps between line tops) is `passMeasure.test.ts`'s.
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: `${LINE}px` } as CSSStyleDeclaration);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mount one pass. Each test gets its own tree: a pass is one mount. */
async function draw(options: DrawOptions): Promise<HTMLParagraphElement> {
  if (container === null) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  const nowAt = options.nowAt ?? START;
  await act(async () => {
    root?.render(
      <LivePass
        blockId="ch01#aaaa1111"
        text={options.text}
        span={options.span}
        startAt={START}
        now={() => nowAt}
        reduced={options.reduced}
        onSettled={options.onSettled}
        onMeasure={options.onMeasure}
      />,
    );
  });
  const paragraph = container.querySelector('p.p-pass');
  if (paragraph === null) throw new Error('the pass rendered no paragraph');
  return paragraph as HTMLParagraphElement;
}

/** Pull the frame that is due `ms` after the previous one. */
async function step(ms: number): Promise<void> {
  clock += ms;
  const next = frames.shift();
  await act(async () => {
    next?.(clock);
  });
}

const pending = (paragraph: Element): number => paragraph.querySelectorAll('.pg.is-pending').length;
const graphemes = (paragraph: Element): number => paragraph.querySelectorAll('.pg').length;
const caret = (paragraph: Element, kind: 'read' | 'write'): HTMLElement | null =>
  paragraph.querySelector<HTMLElement>(`.caret-${kind}`);

/** A caret's opacity: the CSSOM write, or the sheet's own 0 before the engine gives it a line. */
const opacityOf = (element: HTMLElement | null): number =>
  element === null || element.style.opacity === '' ? 0 : Number(element.style.opacity);

/** The line the caret stands on, read back out of its transform. */
const lineOf = (element: HTMLElement | null): number => {
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/u.exec(element?.style.transform ?? '');
  return match === null ? Number.NaN : Number(match[2]) / LINE;
};

const REPLACEMENT = PASS_FIXTURES.find((entry) => entry.name.startsWith('replacement'))?.input;
if (REPLACEMENT === undefined) throw new Error('the replacement fixture is missing');
const REPLACEMENT_SPAN = passSpanOf(REPLACEMENT.before, REPLACEMENT.after);
if (REPLACEMENT_SPAN === null) throw new Error('the replacement fixture has no span');

describe('the replacement fixture, frame by frame', () => {
  /** The fixture's own layout: 21 graphemes on line 2, the last two on line 3, six lines. */
  const fixtureRects = (): ReturnType<typeof vi.spyOn> =>
    stubRects({ per: 21, firstLine: 2, blockLines: 6 });

  it('inks 0 / 0 / 20 / 23 graphemes at 0 / 200 / 800 / 1600 and settles at 1940', async () => {
    fixtureRects();
    const settled = vi.fn();
    const measured: PassLayout[] = [];
    const paragraph = await draw({
      text: REPLACEMENT.after,
      span: REPLACEMENT_SPAN,
      onSettled: settled,
      onMeasure: (layout) => measured.push(layout),
    });

    // The layout the plan was built from is the fixture's, line for line.
    expect(measured).toHaveLength(1);
    expect(measured[0]?.blockLines).toBe(6);
    expect(measured[0]?.spanStartLine).toBe(2);
    expect(measured[0]?.spanLines).toBe(2);
    expect(measured[0]?.linePx).toBeCloseTo(LINE, 5);
    expect(measured[0]?.runLines).toEqual(REPLACEMENT.layout.runLines);

    // t = 0 — the box paints; nothing is inked, and no caret has been born yet.
    expect(graphemes(paragraph)).toBe(23);
    expect(pending(paragraph)).toBe(23);
    expect(paragraph.getAttribute('data-pass')).toBe('paint');
    expect(opacityOf(caret(paragraph, 'read'))).toBe(0);
    expect(opacityOf(caret(paragraph, 'write'))).toBe(0);

    // t = 200 — the hold: still nothing inked, still no caret standing anywhere. The elements
    // are in the tree from the mount — the engine gives them a line at the split (260) — and
    // until then their opacity is 0, so nothing is painted at the block's corner.
    await step(200);
    expect(pending(paragraph)).toBe(23);
    expect(paragraph.getAttribute('data-pass')).toBe('hold');
    expect(caret(paragraph, 'read')).not.toBeNull();
    expect(caret(paragraph, 'write')).not.toBeNull();
    expect(opacityOf(caret(paragraph, 'read'))).toBe(0);
    expect(opacityOf(caret(paragraph, 'write'))).toBe(0);
    expect(settled).not.toHaveBeenCalled();

    // t = 800 — typing: 20 of 23 inked, both carets born at the span's ends.
    await step(600);
    expect(pending(paragraph)).toBe(3);
    expect(paragraph.getAttribute('data-pass')).toBe('type');
    const read = caret(paragraph, 'read');
    const write = caret(paragraph, 'write');
    expect(read).not.toBeNull();
    expect(write).not.toBeNull();
    expect(opacityOf(read)).toBeGreaterThan(0);
    expect(opacityOf(write)).toBeGreaterThan(0);
    // Blue climbs, red descends with the ink: while the run is being written, the blue is always
    // on a line below the red's — the two never share a line and never trade places.
    expect(lineOf(read)).toBeCloseTo(2.85, 1);
    expect(lineOf(write)).toBeCloseTo(2, 1);
    expect(lineOf(read)).toBeGreaterThan(lineOf(write));

    // t = 1600 — the tail: every grapheme inked, the carets on their last lines.
    await step(800);
    expect(pending(paragraph)).toBe(0);
    expect(paragraph.getAttribute('data-pass')).toBe('tail');
    expect(lineOf(read)).toBeCloseTo(0.04, 1);
    expect(lineOf(write)).toBeCloseTo(4.75, 1);
    // The blue has finished its climb and stands above the red, which is still walking the run
    // down: the two crossed *in time*, never in place — see the crossing test below.
    expect(lineOf(read)).toBeLessThan(lineOf(write));
    expect(settled).not.toHaveBeenCalled();

    // t = 1940 — the settle frame: both carets leave with it, the caller hears it once.
    await step(340);
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(caret(paragraph, 'read')).toBeNull();
    expect(caret(paragraph, 'write')).toBeNull();
    expect(pending(paragraph)).toBe(0);
    expect(settled).toHaveBeenCalledTimes(1);

    // No frame is scheduled past the settle: the loop is over.
    expect(frames).toHaveLength(0);
    await step(500);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('stands both carets from the split to the tail, and never puts them in one place', async () => {
    fixtureRects();
    const paragraph = await draw({ text: REPLACEMENT.after, span: REPLACEMENT_SPAN });

    // From the split (260) to the last ink (870) both carets stand, and the blue climbs: its line
    // never goes back down.
    await step(260);
    let blue = Number.POSITIVE_INFINITY;
    for (let at = 260; at <= 860; at += 20) {
      const read = caret(paragraph, 'read');
      const write = caret(paragraph, 'write');
      expect(read).not.toBeNull();
      expect(write).not.toBeNull();
      // Born at this instant: no ink yet. 120 ms later both are fully inked.
      if (at === 260) expect(opacityOf(read)).toBe(0);
      if (at >= 380) expect(opacityOf(read)).toBeGreaterThan(0.9);
      if (at >= 380) expect(opacityOf(write)).toBeGreaterThan(0.9);
      const line = lineOf(read);
      expect(line).toBeLessThanOrEqual(blue);
      blue = line;
      // The engine's own numbers carry the two past each other (the blue climbs the block, the
      // write caret walks the run down); what must never happen is one caret standing on the
      // other, so no frame may put them in the same place.
      const sameLine = Math.abs(line - lineOf(write)) < 0.01;
      const sameX = read?.style.transform.split(',')[0] === write?.style.transform.split(',')[0];
      expect(sameLine && sameX).toBe(false);
      await step(20);
    }
    expect(pending(paragraph)).toBe(0);
    expect(paragraph.getAttribute('data-pass')).toBe('tail');
  });

  it('never re-reads the boxes after the first frame', async () => {
    const rects = fixtureRects();
    const measured: PassLayout[] = [];
    const paragraph = await draw({
      text: REPLACEMENT.after,
      span: REPLACEMENT_SPAN,
      onMeasure: (layout) => measured.push(layout),
    });

    // One read of the block and one of each grapheme, and no more, ever.
    const read = rects.mock.calls.length;
    expect(read).toBe(24);
    expect(measured).toHaveLength(1);

    for (let index = 0; index < 10; index += 1) await step(200); // t = 2000: past the settle
    expect(rects.mock.calls.length).toBe(read);
    expect(measured).toHaveLength(1);
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
  });

  it('lays the run out once: no child is added or removed, and no character changes, while it inks', async () => {
    fixtureRects();
    const settled = vi.fn();
    const paragraph = await draw({
      text: REPLACEMENT.after,
      span: REPLACEMENT_SPAN,
      onSettled: settled,
    });
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(paragraph, { childList: true, subtree: true, characterData: true });

    const atZero = paragraph.textContent;
    // The whole final text is there before the first character is visible…
    expect(atZero?.startsWith(REPLACEMENT.after)).toBe(true);
    await step(400);
    const midInk = paragraph.textContent;
    for (let index = 0; index < 7; index += 1) await step(200); // t = 1700: ink and tail done
    observer.disconnect();

    // …and it is the same text at 400 ms and after the ink: only colour moved.
    expect(midInk).toBe(atZero);
    expect(paragraph.textContent).toBe(atZero);
    expect(paragraph.querySelectorAll('.pg')).toHaveLength(23);
    const childList = records.filter((record) => record.type === 'childList');
    expect(childList).toHaveLength(0);
    expect(records.filter((record) => record.type === 'characterData')).toHaveLength(0);

    // The settle frame takes the carets with it and leaves the same text behind.
    await step(340);
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(paragraph.textContent).toBe(atZero);
    expect(caret(paragraph, 'read')).toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);

    // A screen reader gets one sentence: the whole final block, once, and never a character.
    expect(paragraph.querySelector('.pass-visual')?.getAttribute('aria-hidden')).toBe('true');
    expect(paragraph.querySelector('.visually-hidden')?.textContent).toBe(REPLACEMENT.after);
    expect(paragraph.querySelector('.pass-span')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('settles at once on a late mount, with no caret and no frame', async () => {
    fixtureRects();
    const settled = vi.fn();
    const measured: PassLayout[] = [];
    const paragraph = await draw({
      text: REPLACEMENT.after,
      span: REPLACEMENT_SPAN,
      nowAt: START + 5_000,
      onSettled: settled,
      onMeasure: (layout) => measured.push(layout),
    });

    expect(measured).toHaveLength(1);
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(pending(paragraph)).toBe(0);
    expect(caret(paragraph, 'read')).toBeNull();
    expect(caret(paragraph, 'write')).toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });

  it('renders settled at t = 0 under reduced motion, with no caret element at all', async () => {
    fixtureRects();
    const settled = vi.fn();
    const paragraph = await draw({
      text: REPLACEMENT.after,
      span: REPLACEMENT_SPAN,
      reduced: true,
      onSettled: settled,
    });

    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(pending(paragraph)).toBe(0);
    expect(opacityOf(caret(paragraph, 'read'))).toBe(0);
    expect(paragraph.querySelector('.caret-read')).toBeNull();
    expect(paragraph.querySelector('.caret-write')).toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);
    // Reduced motion is not a fast loop: nothing was ever scheduled.
    expect(frames).toHaveLength(0);
  });
});

describe('a deletion paints its ghost and swaps once', () => {
  const span = passSpanOf('шум реки затих', 'шум затих');
  if (span === null) throw new Error('the deletion fixture has no span');

  it('holds the removed text in the flow, then drops it at the swap', async () => {
    stubRects({ per: 5, firstLine: 1, blockLines: 5 });
    const settled = vi.fn();
    const paragraph = await draw({ text: 'шум затих', span, onSettled: settled });

    expect(span).toEqual({ before: 'реки ', after: '', kind: 'deletion', offset: 4 });
    expect(paragraph.querySelector('.pass-span-gone')?.textContent).toBe('реки ');
    expect(paragraph.querySelector('.pass-visual')?.textContent).toBe('шум реки затих');

    // 600: the words are fading, the ghost is still set.
    await step(600);
    expect(paragraph.getAttribute('data-pass')).toBe('fade');
    expect(paragraph.querySelector('.pass-span-gone')).not.toBeNull();

    // 800: the swap — the one reflow this path allows, and the final text is the block's own.
    await step(200);
    expect(paragraph.getAttribute('data-pass')).toBe('tail');
    expect(paragraph.querySelector('.pass-span-gone')).toBeNull();
    expect(paragraph.querySelector('.pass-visual')?.textContent).toBe('шум затих');

    // Settled at 1033.33: nothing of the pass is left but the prose.
    await step(400);
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(settled).toHaveBeenCalledTimes(1);
    expect(paragraph.querySelector('.caret-write')).toBeNull();
    expect(paragraph.querySelector('.pass-span')).toBeNull();
  });
});

describe('the third exit: unmounted', () => {
  it('stops the loop and never calls onSettled after the tree has gone', async () => {
    stubRects({ per: 21, firstLine: 2, blockLines: 6 });
    const settled = vi.fn();
    await draw({ text: REPLACEMENT.after, span: REPLACEMENT_SPAN, onSettled: settled });
    await step(400);

    const queued = frames.shift();
    await act(async () => root?.unmount());
    root = null;

    // The frame that was already scheduled when the tree left runs against nothing.
    await act(async () => {
      clock += 10_000;
      queued?.(clock);
    });
    expect(settled).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });
});

describe('the split it renders', () => {  it('leaves the settled prefix and suffix as plain text on either side of the run', async () => {
    const span = passSpanOf('Он шёл по берегу', 'Он бежал по берегу');
    if (span === null) throw new Error('no span');
    stubRects({ per: 4, firstLine: 0, blockLines: 2 });
    const paragraph = await draw({ text: 'Он бежал по берегу', span });

    expect(paragraph.querySelector('.pass-span')?.textContent).toBe('бежа');
    expect(paragraph.querySelector('.pass-visual')?.textContent).toBe('Он бежал по берегу');
    expect(paragraph.querySelectorAll('.pg')).toHaveLength(4);
    // It is animating, not settled: all four graphemes start un-inked.
    expect(pending(paragraph)).toBe(4);
  });

  it('settles when the span does not describe this text, instead of painting a guess', async () => {
    const span = passSpanOf('Он шёл по берегу', 'Он бежал по берегу');
    if (span === null) throw new Error('no span');
    stubRects({ per: 4, firstLine: 0, blockLines: 2 });
    const settled = vi.fn();
    const measured: PassLayout[] = [];
    const paragraph = await draw({
      text: 'Ничего похожего здесь нет',
      span,
      onSettled: settled,
      onMeasure: (layout) => measured.push(layout),
    });

    expect(paragraph.querySelector('.pass-span')).toBeNull();
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(paragraph.querySelector('.visually-hidden')?.textContent).toBe('Ничего похожего здесь нет');
    expect(measured).toHaveLength(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });
});
