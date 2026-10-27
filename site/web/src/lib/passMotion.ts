/**
 * The live pass's clock (BOOK-116 #3705, BOOK-DOC-56, BOOK-121): `planPass` builds a pure schedule
 * from the caller's measured layout and refuses one that is not the block's final layout; `frameAt`
 * says what is true at pass-relative `at` (t0 = the patch commit; a late reader lands true, never a
 * replay). No DOM, no timers: the caller owns the loop and the geometry, and the tests pin numbers.
 */

import { graphemes } from './reveal.ts';

export const PASS = {
  /** Desktop 40 cps (25.0 ms/grapheme) and phone 34 cps (29.4 ms). Not the house's 18 cps. */
  cps: { desktop: 40, phone: 34 },
  /** The ceiling: above 60 cps two glyphs share a paint and the effect reads as streaming. */
  maxCps: 60,
  /** The whole write run is capped at four seconds: `rateFor` lifts the base rate for long runs. */
  maxTypeMs: 4_000,
  /** A diff above this share is a rewrite, not an edit; the rewrite cross-fade is backlogged. */
  rewriteShare: 0.6,
  /** Micro-pauses after a grapheme, only when another follows; a plan times one block. */
  pause: { breath: 60, sentence: 140, paragraph: 220, space: 0 },
  /** Selection: the span paints in 160 ms, each word's box in 120, 20 ms apart, then holds 100. */
  selection: { paintMs: 160, wordMs: 120, staggerMs: 20, holdMs: 100 },
  /** Insertion: the point holds 220 ms solid; the first grapheme lands at 220. */
  insertion: { holdMs: 220 },
  /** Deletion: a 400 ms hold, then 140 ms word fades 60 ms apart, the swap after the last. */
  deletion: { holdMs: 400, wordFadeMs: 140, staggerMs: 60, sweepLinesPerSec: 3 },
  /** A replacement box never fades faster than this, however short its slice is. */
  contraction: { floorMs: 100 },
  /** The read caret: up at 4.0 lines/s with one shaping curve, then a 180 ms fade. */
  blue: { linesPerSec: 4, fadeMs: 180, easing: [0.4, 0, 0.2, 1] },
  /** The write caret: down the tail at 2.4 lines/s, a 140 ms fade, a 220 ms last-line rest. */
  red: { tailLinesPerSec: 2.4, fadeMs: 140, restMs: 220, easing: [0.22, 0.68, 0.24, 1] },
} as const;

/** A normal plan asked for a non-finite time, or a reduced one asked for any time, is settled. */
export const STATIC_TIMELINE_MS = Number.POSITIVE_INFINITY;

export type PassKind = 'replacement' | 'insertion' | 'deletion';
export type PassBeat = 'paint' | 'hold' | 'point' | 'type' | 'fade' | 'tail' | 'settled' | 'static';

/**
 * The geometry the caller measured off-flow, before the swap: `runLines[i]` is the line of new
 * grapheme `i` in the final layout, `spanStartLine`/`spanLines` the changed span. `planPass`
 * validates the map; nothing here measures.
 */
export type PassLayout = {
  linePx: number;
  blockLines: number;
  runLines: readonly number[];
  spanStartLine: number;
  spanLines: number;
};

/** One selection box: grapheme indices — into the new run for a replacement, into the old text
 * for a deletion. Insertion has no boxes. */
export type ScheduledWord = {
  index: number;
  from: number;
  to: number;
  paintStartMs: number;
  paintEndMs: number;
  fadeStartMs: number;
  fadeEndMs: number;
};

export type PassPlanInput = {
  kind: PassKind;
  before: string;
  after: string;
  cps?: number;
  layout: PassLayout;
  /** Per-old-word grapheme ranges into the new run; overrides the proportional mapping. */
  wordRanges?: readonly (readonly [number, number])[];
  reducedMotion?: boolean;
};

export type PassPlan = {
  kind: PassKind;
  reduced: boolean;
  layout: PassLayout;
  cps: number;
  graphemes: readonly string[];
  inkTimes: readonly number[];
  splitMs: number;
  swapMs: number;
  persistMs: number;
  settleMs: number;
  words: readonly ScheduledWord[];
  blue: { startMs: number; distanceLines: number; climbMs: number; fadeStartMs: number; fadeEndMs: number };
  red: { fadeStartMs: number; fadeEndMs: number; tailMs: number };
};

export type PassCaret = { line: number; col: number; resting: boolean; fading: boolean; opacity: number };
export type PassWord = { index: number; from: number; to: number; opacity: number };

export type PassFrame = {
  at: number;
  beat: PassBeat;
  revealed: number;
  selected: boolean;
  selectionOpacity: number;
  words: readonly PassWord[];
  swapped: boolean;
  blue: PassCaret | null;
  red: PassCaret | null;
  persist: boolean;
  settled: boolean;
  lines: number;
  runLines: readonly number[];
  graphemeCount: number;
};

const BREATH = new Set([',', ';', ':', '—']);
const SENTENCE = new Set(['.', '!', '?', '…']);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** A pause follows a grapheme only when another grapheme follows it in the run. */
function pauseAfter(grapheme: string): number {
  if (BREATH.has(grapheme)) return PASS.pause.breath;
  if (SENTENCE.has(grapheme)) return PASS.pause.sentence;
  return PASS.pause.space;
}

/** The effective type rate: a long run is lifted to fit `PASS.maxTypeMs`, the ceiling keeps one
 * grapheme per paint; `base` is the device rate (40 or 34). */
export function rateFor(runLength: number, base: number): number {
  const floor = Number.isFinite(base) && base > 0 ? base : PASS.cps.desktop;
  const perSecond = Math.max(0, runLength) / (PASS.maxTypeMs / 1_000);
  return Math.min(PASS.maxCps, Math.max(floor, perSecond));
}

/** One CSS timing function: solve x(t) by bisection, then read y(t). */
function cubicBezier(easing: readonly [number, number, number, number], x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = easing;
  const at = (t: number): number => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const value = (t: number): number => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let step = 0; step < 24; step += 1) {
    if (at(t) < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return clamp(value(t), 0, 1);
}

type Span = { from: number; to: number };

/** Runs of non-space graphemes: the unit a selection box is drawn on. */
function wordSpans(clusters: readonly string[]): Span[] {
  const spans: Span[] = [];
  let start = -1;
  for (let index = 0; index < clusters.length; index += 1) {
    const space = /\s/u.test(clusters[index] ?? '');
    if (!space && start < 0) start = index;
    if (space && start >= 0) {
      spans.push({ from: start, to: index });
      start = -1;
    }
  }
  if (start >= 0) spans.push({ from: start, to: clusters.length });
  return spans;
}

/** Old word i owns `[round(i·new/words), round((i+1)·new/words))` of the new run. */
function proportionalRanges(words: number, newLength: number): (readonly [number, number])[] {
  return Array.from({ length: words }, (_, index) => [
    Math.round((index * newLength) / words),
    Math.round(((index + 1) * newLength) / words),
  ]);
}

function inkTimesFor(clusters: readonly string[], splitMs: number, cps: number): number[] {
  const msPerGrapheme = 1_000 / cps;
  const times: number[] = [];
  let clock = splitMs;
  for (let index = 0; index < clusters.length; index += 1) {
    times.push(clock);
    clock += msPerGrapheme;
    if (index < clusters.length - 1) clock += pauseAfter(clusters[index] ?? '');
  }
  return times;
}

/** The caller's layout must be the block's final one; anything else is a `RangeError`. */
function assertLayout(kind: PassKind, layout: PassLayout, runLength: number): void {
  const fail = (why: string): never => { throw new RangeError(`planPass: ${why}`); };
  const { blockLines: block, spanStartLine: start, spanLines: span, runLines, linePx } = layout;
  if (!Number.isFinite(linePx) || linePx <= 0) fail('layout.linePx is not a positive finite number');
  if (!Number.isInteger(block) || block < 1) fail('layout.blockLines is not an integer ≥ 1');
  if (!Number.isInteger(start) || start < 0 || start >= block) fail('layout.spanStartLine is outside the block');
  if (!Number.isInteger(span) || span < 0 || span > block - start) fail('layout.spanLines does not fit the block');
  if (kind === 'deletion' && runLines.length > 0) fail('a deletion has no new run: layout.runLines must be empty');
  if (kind === 'deletion') return;
  if (runLines.length !== runLength) fail(`layout.runLines maps ${runLines.length}, not the ${runLength} graphemes`);
  for (const [index, line] of runLines.entries()) {
    const where = `layout.runLines[${index}] = ${line}`;
    if (!Number.isInteger(line) || line < 0 || line >= block) fail(`${where} is not a line of the block`);
    if (line < (runLines[index - 1] ?? 0)) fail(`${where} goes back from the line before`);
  }
}

/** The deletion's red sweep: down the span, never past the block's last line. */
function sweepLines(layout: PassLayout): number {
  return Math.min(layout.spanLines, Math.max(0, layout.blockLines - 1 - layout.spanStartLine));
}

export function planPass(input: PassPlanInput): PassPlan {
  const kind = input.kind;
  const after = graphemes(input.after);
  const before = graphemes(input.before);
  assertLayout(kind, input.layout, after.length);
  const base = input.cps !== undefined && Number.isFinite(input.cps) && input.cps > 0 ? input.cps : PASS.cps.desktop;
  const cps = rateFor(after.length, base);
  const splitMs =
    kind === 'deletion' ? PASS.selection.paintMs + PASS.deletion.holdMs
      : kind === 'insertion' ? PASS.insertion.holdMs
        : PASS.selection.paintMs + PASS.selection.holdMs;
  const inkTimes = inkTimesFor(after, splitMs, cps);
  const lastInkMs = inkTimes[inkTimes.length - 1] ?? splitMs;
  const oldSpans = wordSpans(before);

  const paintOf = (index: number): { paintStartMs: number; paintEndMs: number } => ({
    paintStartMs: index * PASS.selection.staggerMs,
    paintEndMs: index * PASS.selection.staggerMs + PASS.selection.wordMs,
  });

  let words: ScheduledWord[];
  if (kind === 'insertion') {
    // Nothing is selected: the insertion point is a caret, not a span.
    words = [];
  } else if (kind === 'deletion') {
    words = oldSpans.map((span, index) => {
      const paint = paintOf(index);
      const from = clamp(input.wordRanges?.[index]?.[0] ?? span.from, 0, before.length);
      const fadeStartMs = splitMs + index * PASS.deletion.staggerMs;
      return {
        index,
        from,
        to: clamp(input.wordRanges?.[index]?.[1] ?? span.to, from, before.length),
        ...paint,
        fadeStartMs,
        fadeEndMs: fadeStartMs + PASS.deletion.wordFadeMs,
      };
    });
  } else {
    const ranges =
      input.wordRanges !== undefined && input.wordRanges.length > 0
        ? input.wordRanges
        : proportionalRanges(oldSpans.length, after.length);
    words = oldSpans.map((_span, index) => {
      const paint = paintOf(index);
      const range = ranges[index];
      const from = clamp(range?.[0] ?? 0, 0, after.length);
      const to = clamp(range?.[1] ?? from, from, after.length);
      // Fewer new graphemes than old words: the surplus words all collapse in the last 100 ms.
      const surplus = from >= to || from >= after.length;
      const fadeStartMs = surplus ? lastInkMs - PASS.contraction.floorMs : (inkTimes[from] ?? lastInkMs);
      const naturalEnd = surplus ? lastInkMs : (inkTimes[to - 1] ?? lastInkMs);
      return {
        index,
        from,
        to,
        ...paint,
        fadeStartMs,
        fadeEndMs: Math.max(naturalEnd, fadeStartMs + PASS.contraction.floorMs),
      };
    });
  }

  const swapMs =
    kind === 'deletion' ? words.reduce((latest, word) => Math.max(latest, word.fadeEndMs), splitMs) : splitMs;
  const persistMs = kind === 'deletion' ? swapMs : lastInkMs;

  /** Blue is born at the block's bottom (deleting: the span's first line) and climbs it; 1 line
   * at 4.0 lines/s from 560 arrives at 810. */
  const blueStartMs = splitMs;
  const blueStartLine = kind === 'deletion' ? input.layout.spanStartLine : input.layout.blockLines;
  const blueDistance =
    kind === 'deletion' ? Math.min(input.layout.spanLines, Math.max(0, blueStartLine)) : input.layout.blockLines;
  const blueClimbMs = (blueDistance / PASS.blue.linesPerSec) * 1_000;
  const blueFadeStartMs = Math.max(blueStartMs + blueClimbMs, persistMs);
  const blueFadeEndMs = blueFadeStartMs + PASS.blue.fadeMs;

  let redTailMs: number;
  let redFadeStartMs: number;
  if (kind === 'deletion') {
    const sweepDistance = sweepLines(input.layout);
    redTailMs = (sweepDistance / PASS.deletion.sweepLinesPerSec) * 1_000;
    const rest = sweepDistance === 0 ? PASS.red.restMs : 0;
    redFadeStartMs = splitMs + redTailMs + rest;
  } else {
    const lastLine = input.layout.runLines[after.length - 1] ?? input.layout.spanStartLine;
    const remaining = Math.max(0, input.layout.blockLines - 1 - lastLine);
    redTailMs = (remaining / PASS.red.tailLinesPerSec) * 1_000;
    const rest = remaining === 0 ? PASS.red.restMs : 0;
    redFadeStartMs = lastInkMs + redTailMs + rest;
  }
  const redFadeEndMs = redFadeStartMs + PASS.red.fadeMs;

  return {
    kind,
    reduced: input.reducedMotion === true,
    layout: input.layout,
    cps,
    graphemes: after,
    inkTimes,
    splitMs,
    swapMs,
    persistMs,
    settleMs: Math.max(blueFadeEndMs, redFadeEndMs, persistMs, swapMs),
    words,
    blue: {
      startMs: blueStartMs,
      distanceLines: blueDistance,
      climbMs: blueClimbMs,
      fadeStartMs: blueFadeStartMs,
      fadeEndMs: blueFadeEndMs,
    },
    red: { fadeStartMs: redFadeStartMs, fadeEndMs: redFadeEndMs, tailMs: redTailMs },
  };
}

function countInked(inkTimes: readonly number[], at: number): number {
  let count = 0;
  for (const time of inkTimes) {
    if (time > at) break;
    count += 1;
  }
  return count;
}

function ramp(value: number, from: number, to: number): number {
  if (to <= from) return value >= to ? 0 : 1;
  return clamp((value - from) / (to - from), 0, 1);
}

function fadeOpacity(at: number, startMs: number, endMs: number): number {
  return 1 - ramp(at, startMs, endMs);
}

function wordOpacity(word: ScheduledWord, at: number): number {
  if (at < word.paintStartMs) return 0;
  if (at < word.paintEndMs) return ramp(at, word.paintStartMs, word.paintEndMs);
  if (at < word.fadeStartMs) return 1;
  if (at < word.fadeEndMs) return fadeOpacity(at, word.fadeStartMs, word.fadeEndMs);
  return 0;
}

function selectionEnd(plan: PassPlan): number {
  return plan.words.reduce((latest, word) => Math.max(latest, word.fadeEndMs), 0);
}

function beatAt(plan: PassPlan, at: number): PassBeat {
  if (plan.kind === 'deletion') {
    if (at < PASS.selection.paintMs) return 'paint';
    if (at < plan.splitMs) return 'hold';
    if (at < plan.swapMs) return 'fade';
    return 'tail';
  }
  if (plan.kind === 'insertion') {
    if (at < plan.splitMs) return 'point';
    if (at < plan.persistMs) return 'type';
    return 'tail';
  }
  if (at < PASS.selection.paintMs) return 'paint';
  if (at < plan.splitMs) return 'hold';
  if (at < plan.persistMs) return 'type';
  return 'tail';
}

function blueAt(plan: PassPlan, at: number): PassCaret | null {
  const { startMs, distanceLines, climbMs, fadeStartMs, fadeEndMs } = plan.blue;
  if (at < startMs || at >= fadeEndMs) return null;
  const progress = ramp(at, startMs, startMs + climbMs);
  const eased = cubicBezier(PASS.blue.easing, progress);
  const startLine = plan.kind === 'deletion' ? plan.layout.spanStartLine : plan.layout.blockLines;
  const fading = at >= fadeStartMs;
  return {
    line: Math.max(0, startLine - distanceLines * eased),
    col: 0,
    resting: false,
    fading,
    opacity: fading ? fadeOpacity(at, fadeStartMs, fadeEndMs) : 1,
  };
}

function redAt(plan: PassPlan, at: number): PassCaret | null {
  const startMs = plan.kind === 'insertion' ? 0 : plan.splitMs;
  if (at < startMs || at >= plan.red.fadeEndMs) return null;
  const fading = at >= plan.red.fadeStartMs;
  const opacity = fading ? fadeOpacity(at, plan.red.fadeStartMs, plan.red.fadeEndMs) : 1;

  if (plan.kind === 'deletion') {
    const sweepDistance = sweepLines(plan.layout);
    const travelled = ((at - plan.splitMs) / 1_000) * PASS.deletion.sweepLinesPerSec;
    const resting = sweepDistance === 0 && at < plan.red.fadeStartMs;
    return {
      line: plan.layout.spanStartLine + Math.min(sweepDistance, Math.max(0, travelled)),
      col: 0,
      resting,
      fading,
      opacity,
    };
  }

  const revealed = countInked(plan.inkTimes, at);
  if (revealed === 0) {
    // Only an insertion can be here: the point holds 220 ms before the first grapheme.
    return {
      line: plan.layout.runLines[0] ?? plan.layout.spanStartLine,
      col: 0,
      resting: at < plan.splitMs,
      fading,
      opacity,
    };
  }
  if (at < plan.persistMs) {
    return {
      line: plan.layout.runLines[revealed - 1] ?? plan.layout.spanStartLine,
      col: revealed,
      resting: false,
      fading,
      opacity,
    };
  }

  const lastLine = plan.layout.runLines[plan.inkTimes.length - 1] ?? plan.layout.spanStartLine;
  const remaining = Math.max(0, plan.layout.blockLines - 1 - lastLine);
  const travelled = ((at - plan.persistMs) / 1_000) * PASS.red.tailLinesPerSec;
  return {
    line: lastLine + Math.min(remaining, Math.max(0, travelled)),
    col: revealed,
    resting: remaining === 0 && at < plan.red.fadeStartMs,
    fading,
    opacity,
  };
}

function settledFrame(plan: PassPlan, at: number, beat: 'static' | 'settled'): PassFrame {
  return {
    at,
    beat,
    revealed: plan.graphemes.length,
    selected: false,
    selectionOpacity: 0,
    words: plan.words.map((word) => ({ index: word.index, from: word.from, to: word.to, opacity: 0 })),
    swapped: true,
    blue: null,
    red: null,
    persist: true,
    settled: true,
    lines: plan.layout.blockLines,
    runLines: plan.layout.runLines,
    graphemeCount: plan.graphemes.length,
  };
}

/**
 * What is true at `atMs`: negative clamps to 0, non-finite is settled, a reduced-motion plan is
 * settled at every time. `lines`/`runLines`/`graphemeCount` echo the validated plan; the DOM's
 * 0 px proof belongs to the strip session.
 */
export function frameAt(plan: PassPlan, atMs: number): PassFrame {
  const finite = Number.isFinite(atMs);
  const at = finite ? Math.max(0, atMs) : plan.settleMs;
  if (plan.reduced) return settledFrame(plan, at, 'static');
  if (!finite || at >= plan.settleMs) return settledFrame(plan, at, 'settled');

  const words = plan.words.map((word) => ({
    index: word.index,
    from: word.from,
    to: word.to,
    opacity: wordOpacity(word, at),
  }));
  const selectionOpacity = words.reduce((latest, word) => Math.max(latest, word.opacity), 0);
  return {
    at,
    beat: beatAt(plan, at),
    revealed: countInked(plan.inkTimes, at),
    selected: plan.words.length > 0 && at < selectionEnd(plan),
    selectionOpacity,
    words,
    swapped: at >= plan.swapMs,
    blue: blueAt(plan, at),
    red: redAt(plan, at),
    persist: at >= plan.persistMs,
    settled: false,
    lines: plan.layout.blockLines,
    runLines: plan.layout.runLines,
    graphemeCount: plan.graphemes.length,
  };
}
