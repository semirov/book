// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { passSpanOf, type PassSpan } from '../lib/passDiff.ts';
import type { PassLayout } from '../lib/passMotion.ts';
import { PASS_FIXTURES } from '../lib/passMotionFixtures.ts';
import { LivePass } from './LivePass.tsx';

/**
 * BOOK-121 / BOOK-DOC-84 §4 — the renderer that paints one pass in place.
 *
 * jsdom lays nothing out, so the boxes are injected through `getBoundingClientRect` and the
 * frames are pulled by hand: `requestAnimationFrame` is a queue and `performance.now` is a knob,
 * which is what makes "what is true at 200 ms" an assertion instead of a race.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const START = 1_764_000_000_000;
const LINE = 30.24;

const rect = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** The block and its run, as the fixture says: `per` graphemes a line from `firstLine`. */
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
  /** The page's provenance door, as `ChapterProse` hands it over (`history && sentence`). */
  prov?: boolean;
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
  // The sheet sets the leading; jsdom has no cascade, so the line box is injected too.
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

/** Mount one pass. */
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
        prov={options.prov}
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

/** A caret's opacity: the CSSOM write, or the sheet's 0 before the engine gives it a line. */
const opacityOf = (element: HTMLElement | null): number =>
  element === null || element.style.opacity === '' ? 0 : Number(element.style.opacity);

/** The line the caret stands on, read back out of its transform. */
const lineOf = (element: HTMLElement | null): number => {
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/u.exec(element?.style.transform ?? '');
  return match === null ? Number.NaN : Number(match[2]) / LINE;
};

/** The x the caret stands at, read back out of its transform. */
const xOf = (element: HTMLElement | null): number => {
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/u.exec(element?.style.transform ?? '');
  return match === null ? Number.NaN : Number(match[1]);
};

const REPLACEMENT = PASS_FIXTURES.find((entry) => entry.name.startsWith('replacement'))?.input;
if (REPLACEMENT === undefined) throw new Error('the replacement fixture is missing');
const REPLACEMENT_SPAN = passSpanOf(REPLACEMENT.before, REPLACEMENT.after);
if (REPLACEMENT_SPAN === null) throw new Error('the replacement fixture has no span');

describe('the replacement fixture, frame by frame', () => {
  /** The fixture's own layout: 21 graphemes on line 2, the last two on line 3, six lines. */
  const fixtureRects = (): ReturnType<typeof vi.spyOn> =>
    stubRects({ per: 21, firstLine: 2, blockLines: 6 });

  it('inks 0 / 0 / 20 / 23 graphemes at 0 / 200 / 800 / 1600, then settles', async () => {
    fixtureRects();
    const settled = vi.fn();
    const measured: PassLayout[] = [];
    const paragraph = await draw({
      text: REPLACEMENT.after,
      span: REPLACEMENT_SPAN,
      onSettled: settled,
      onMeasure: (layout) => measured.push(layout),
    });

    // The layout the plan was built from is the fixture's.
    expect(measured).toHaveLength(1);
    expect(measured[0]?.blockLines).toBe(6);
    expect(measured[0]?.spanStartLine).toBe(2);
    expect(measured[0]?.spanLines).toBe(2);
    expect(measured[0]?.linePx).toBeCloseTo(LINE, 5);
    expect(measured[0]?.runLines).toEqual(REPLACEMENT.layout.runLines);

    // t = 0 — the box paints; nothing is inked, no caret born yet.
    expect(graphemes(paragraph)).toBe(23);
    expect(pending(paragraph)).toBe(23);
    expect(paragraph.getAttribute('data-pass')).toBe('paint');
    expect(opacityOf(caret(paragraph, 'read'))).toBe(0);
    expect(opacityOf(caret(paragraph, 'write'))).toBe(0);

    // t = 200 — the hold: nothing inked, no caret standing; both elements are in the tree
    // from the mount and their opacity is 0 until the engine gives them a line at the split.
    await step(200);
    expect(pending(paragraph)).toBe(23);
    expect(paragraph.getAttribute('data-pass')).toBe('hold');
    expect(caret(paragraph, 'read')).not.toBeNull();
    expect(caret(paragraph, 'write')).not.toBeNull();
    expect(opacityOf(caret(paragraph, 'read'))).toBe(0);
    expect(opacityOf(caret(paragraph, 'write'))).toBe(0);
    expect(settled).not.toHaveBeenCalled();

    // t = 800 — typing: 20 of 23 inked, both carets born.
    await step(600);
    expect(pending(paragraph)).toBe(3);
    expect(paragraph.getAttribute('data-pass')).toBe('type');
    const read = caret(paragraph, 'read');
    const write = caret(paragraph, 'write');
    expect(read).not.toBeNull();
    expect(write).not.toBeNull();
    expect(opacityOf(read)).toBeGreaterThan(0);
    expect(opacityOf(write)).toBeGreaterThan(0);
    // BOOK-DOC-84 §4: the blue is born at the run's first line and climbs to line 0; by 800 ms
    // its 2-line climb (500 ms at 4.0 lines/s) is over. The red descends with the ink.
    expect(lineOf(read)).toBeCloseTo(0, 1);
    expect(lineOf(write)).toBeCloseTo(2, 1);
    expect(lineOf(read)).toBeLessThan(lineOf(write));
    // Its x is the run's own first grapheme, never a column edge or a gutter step.
    expect(xOf(read)).toBeCloseTo(8, 1);

    await step(800);
    // t = 1600 — the tail: every grapheme inked.
    expect(pending(paragraph)).toBe(0);
    expect(paragraph.getAttribute('data-pass')).toBe('tail');
    expect(lineOf(read)).toBeCloseTo(0.04, 1);
    expect(lineOf(write)).toBeCloseTo(4.75, 1);
    // The blue has finished its climb: they crossed in time.
    expect(lineOf(read)).toBeLessThan(lineOf(write));
    expect(settled).not.toHaveBeenCalled();

    await step(340);
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(caret(paragraph, 'read')).toBeNull();
    expect(caret(paragraph, 'write')).toBeNull();
    expect(pending(paragraph)).toBe(0);
    expect(settled).toHaveBeenCalledTimes(1);

    expect(frames).toHaveLength(0);
    await step(500);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('stands both carets from the split to the tail', async () => {
    fixtureRects();
    const paragraph = await draw({ text: REPLACEMENT.after, span: REPLACEMENT_SPAN });

    // From the split to the last ink both stand; the blue never goes back down.
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
      // The red's x advances with the ink; the blue climbs while the red walks the run down,
      // and no frame may put them in one place.
      const sameLine = Math.abs(line - lineOf(write)) < 0.01;
      const sameX = read?.style.transform.split(',')[0] === write?.style.transform.split(',')[0];
      expect(sameLine && sameX).toBe(false);
      // The red's x is a grapheme column of the run (the fixture's 12 px grid), never a guess.
      expect((xOf(write) - 8) % 12).toBeCloseTo(0, 5);
      await step(20);
    }
    // t = 1600 — the tail: every grapheme inked.
    expect(pending(paragraph)).toBe(0);
    expect(paragraph.getAttribute('data-pass')).toBe('tail');
  });
  it('is born at the run’s first line and its first grapheme, not below the paragraph', async () => {
    fixtureRects();
    const paragraph = await draw({ text: REPLACEMENT.after, span: REPLACEMENT_SPAN });
    await step(260); // the split: both carets are born here
    const read = caret(paragraph, 'read');
    // The fixture's run starts on line 2 (the paragraph has six); the old frame was line 6.
    expect(lineOf(read)).toBeCloseTo(2, 1);
    expect(xOf(read)).toBeCloseTo(8, 1);
    await step(260); // +260 ms of a 500 ms climb: halfway up
    expect(lineOf(read)).toBeLessThan(2);
    expect(lineOf(read)).toBeGreaterThan(0);
  });

  it('never re-reads the boxes after the first frame', async () => {
    const rects = fixtureRects();
    const measured: PassLayout[] = [];
    const paragraph = await draw({
      text: REPLACEMENT.after,
      span: REPLACEMENT_SPAN,
      onMeasure: (layout) => measured.push(layout),
    });

    // One read of the block and one of each grapheme.
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
    expect(atZero?.startsWith(REPLACEMENT.after)).toBe(true);
    await step(400);
    const midInk = paragraph.textContent;
    for (let index = 0; index < 7; index += 1) await step(200); // t = 1700: ink and tail done
    observer.disconnect();

    // …and the same text after the ink.
    expect(midInk).toBe(atZero);
    expect(paragraph.textContent).toBe(atZero);
    expect(paragraph.querySelectorAll('.pg')).toHaveLength(23);
    const childList = records.filter((record) => record.type === 'childList');
    expect(childList).toHaveLength(0);
    expect(records.filter((record) => record.type === 'characterData')).toHaveLength(0);

    // The settle frame takes the carets with it.
    await step(340);
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(paragraph.textContent).toBe(atZero);
    expect(caret(paragraph, 'read')).toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);

    // A screen reader gets one sentence: the final block, once.
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

  it('shows the static mark for the window under reduced motion — no carets, no loop', async () => {
    vi.useFakeTimers();
    fixtureRects();
    const settled = vi.fn();
    const paragraph = await draw({
      text: REPLACEMENT.after,
      span: REPLACEMENT_SPAN,
      reduced: true,
      onSettled: settled,
    });

    // D7: the rule and two ticks, `data-pass="static"` — never "nothing".
    expect(paragraph.getAttribute('data-pass')).toBe('static');
    expect(pending(paragraph)).toBe(0);
    expect(paragraph.querySelector('.pass-span')).not.toBeNull();
    expect(paragraph.querySelector('.pass-tick-first')).not.toBeNull();
    expect(paragraph.querySelector('.pass-tick-last')).not.toBeNull();
    expect(paragraph.querySelector('.caret-read')).toBeNull();
    expect(paragraph.querySelector('.caret-write')).toBeNull();
    // The ticks stand at the run's first and last glyph.
    expect(xOf(paragraph.querySelector<HTMLElement>('.pass-tick-first'))).toBeCloseTo(8, 1);
    expect(xOf(paragraph.querySelector<HTMLElement>('.pass-tick-last'))).toBeGreaterThan(8);
    expect(settled).not.toHaveBeenCalled();
    // Reduced motion is not a loop: no animation frame was ever scheduled.
    expect(frames).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(paragraph.getAttribute('data-pass')).toBe('settled');
    expect(paragraph.querySelector('.pass-tick-first')).toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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

    await step(600);
    expect(paragraph.getAttribute('data-pass')).toBe('fade');
    expect(paragraph.querySelector('.pass-span-gone')).not.toBeNull();
    // 800: the swap — the one reflow this path allows.
    await step(200);
    expect(paragraph.getAttribute('data-pass')).toBe('tail');
    expect(paragraph.querySelector('.pass-span-gone')).toBeNull();
    expect(paragraph.querySelector('.pass-visual')?.textContent).toBe('шум затих');
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

    // The already-scheduled frame runs against nothing.
    await act(async () => {
      clock += 10_000;
      queued?.(clock);
    });
    expect(settled).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });
});

describe('the provenance door', () => {
  const expectProse = (paragraph: Element, text: string, runGraphemes: number): void => {
    expect(paragraph.querySelector('.pass-visual')?.textContent).toBe(text);
    expect(paragraph.querySelector('.visually-hidden')?.textContent).toBe(text);
    expect(paragraph.querySelectorAll('.pg')).toHaveLength(runGraphemes);
  };

  it('paints the ordinary paragraph’s door, adding nothing to the prose', async () => {
    stubRects({ per: 21, firstLine: 2, blockLines: 6 });
    const paragraph = await draw({ text: REPLACEMENT.after, span: REPLACEMENT_SPAN, prov: true });

    const door = paragraph.querySelector('.prov');
    expect(door).not.toBeNull();
    // The same box the ordinary paragraph gives it, and the same place: last in flow.
    expect(door?.tagName).toBe('BUTTON');
    expect(door?.getAttribute('type')).toBe('button');
    expect(door?.getAttribute('aria-hidden')).toBe('true');
    expect((door as HTMLButtonElement).tabIndex).toBe(-1);
    expect(door?.textContent).toBe('⋯');
    expect(paragraph.lastElementChild).toBe(door);
    expectProse(paragraph, REPLACEMENT.after, REPLACEMENT_SPAN.after.length);
  });

  it('leaves it out when the page has none', async () => {
    stubRects({ per: 21, firstLine: 2, blockLines: 6 });
    const paragraph = await draw({ text: REPLACEMENT.after, span: REPLACEMENT_SPAN, prov: false });

    expect(paragraph.querySelector('.prov')).toBeNull();
    expect(paragraph.textContent?.includes('⋯')).toBe(false);
    expectProse(paragraph, REPLACEMENT.after, REPLACEMENT_SPAN.after.length);
  });
});

describe('the split it renders', () => {
  it('leaves the settled prefix and suffix as plain text on either side of the run', async () => {
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

  it('settles when the span does not describe this text', async () => {
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
