/**
 * BOOK-220 §11.2 (BOOK-DOC-84, page 488) — the print engine: the clock of one printed block.
 *
 * The owner's contract, and only this:
 *
 *   • **30 cps desk / 26 cps phone**, a **seeded per-grapheme jitter of ±25 %** (the same pass
 *     keeps the same rhythm), a **word-end pause ×1.4**, and the punctuation pauses the engine
 *     already had (breath 60 ms, sentence 140 ms, paragraph 220 ms);
 *   • **hesitations**: one per 40–60 characters, 120–260 ms, never two in a row and never inside
 *     a number or a name — a hesitation is a typing beat, not a hole in the schedule;
 *   • **no ease-in/out, no compression, no duration cap as a speed control**: the base interval
 *     is constant for the whole run, so a 27 000-character chapter takes ~15 minutes and that is
 *     the accepted cost of the effect. `maxTypeMs` is gone; what is left is a *runaway guard*
 *     (a single step may not exceed `PRINT.stepGuardMs`, and a plan longer than
 *     `PRINT.planGuardMs` is refused) which never lifts or lowers the base rate;
 *   • **one caret**: `caret()` answers the grapheme index the ink has reached — the renderer
 *     maps it onto the measured layout and paints a single mark there.
 *
 * Pure: no DOM, no timers, no `Date.now`. The caller measures, the caller owns the frame loop,
 * and the seed makes the rhythm the pass's own rather than the machine's.
 */

import { graphemes } from './reveal.ts';

export type PrintKind = 'replacement' | 'insertion' | 'deletion';

export const PRINT = {
  /** The reader's pace: 30 characters a second on a desk, 26 in the hand. */
  cps: { desktop: 30, phone: 26 },
  /** Every interval is the base × (1 ± this), seeded per grapheme: same pass, same rhythm. */
  jitter: 0.25,
  /** The last grapheme of a word is followed by the base interval × this. */
  wordEnd: 1.4,
  /** Micro-pauses after punctuation, only when another grapheme follows. */
  pause: { breath: 60, sentence: 140, paragraph: 220 },
  /** One hesitation per this many characters, its own length, and never closer than `gap`. */
  hesitation: { everyFrom: 40, everyTo: 60, fromMs: 120, toMs: 260, gap: 8 },
  /**
   * The runaway guard: a single step is clamped to this, so a schedule bug cannot park the ink
   * for a second, and a plan longer than `planGuardMs` (an hour of print) is refused instead of
   * printing forever. Neither number touches the base rate — that is the contract's point.
   */
  stepGuardMs: 420,
  planGuardMs: 3_600_000,
  /** The beat before the first grapheme: a replacement selects, an insertion points, a deletion holds. */
  holdMs: { replacement: 260, insertion: 220, deletion: 400 },
  /** The strike's life on a ghost (deletion and replacement): the fade, then the one reflow. */
  strikeMs: 600,
} as const;

export type PrintPlanInput = {
  kind: PrintKind;
  /** What the pass removed and what it wrote (the minimal span, `passDiff.ts`). */
  before: string;
  after: string;
  /** Characters per second: the device's rate, 30 or 26. */
  cps?: number;
  /** The pass's own seed (`key`, `blockId`, anything stable): the same pass prints the same way. */
  seed: string | number;
  reducedMotion?: boolean;
};

export type PrintPlan = {
  kind: PrintKind;
  reduced: boolean;
  seed: number;
  cps: number;
  /** The constant base interval, ms per grapheme — the number the jitter rides on. */
  baseMs: number;
  /** The run's graphemes (the new text); empty for a deletion. */
  graphemes: readonly string[];
  /** When each grapheme's ink lands, ms from the plan's zero. Monotone, strictly increasing. */
  inkTimes: readonly number[];
  /** Gap indices that carry a hesitation; tests read them, the renderer does not. */
  hesitations: readonly number[];
  /** The hold before the first grapheme. */
  holdMs: number;
  /** The ghost's strike and fade (0 when there is no ghost). */
  strikeMs: number;
  /** The pass is over at this instant. */
  totalMs: number;
};

const BREATH = new Set([',', ';', ':', '—']);
const SENTENCE = new Set(['.', '!', '?', '…']);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** The reader's rate: 30 characters a second on a desk, 26 in the hand (one place, two callers). */
export function deviceCps(width: number): number {
  return Number.isFinite(width) && width < 600 ? PRINT.cps.phone : PRINT.cps.desktop;
}

/** The seed as a 32-bit integer: FNV-1a over the string, or the number itself. */
export function hashSeed(seed: string | number): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.abs(Math.trunc(seed)) >>> 0;
  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Mulberry32: 32 bits of state, one `random()` per draw, identical on every machine. */
function randomOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const isSpace = (cluster: string): boolean => /\s/u.test(cluster);

/** A pause follows a grapheme only when another grapheme follows it in the run. */
export function pauseAfter(cluster: string): number {
  if (BREATH.has(cluster)) return PRINT.pause.breath;
  if (SENTENCE.has(cluster)) return PRINT.pause.sentence;
  if (cluster === '\n') return PRINT.pause.paragraph;
  return 0;
}

type Token = { from: number; to: number };

/** Runs of non-space graphemes, in order: the unit a name or a number is read as. */
function tokensOf(clusters: readonly string[]): Token[] {
  const tokens: Token[] = [];
  let start = -1;
  for (let index = 0; index < clusters.length; index += 1) {
    if (!isSpace(clusters[index] ?? '')) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      tokens.push({ from: start, to: index });
      start = -1;
    }
  }
  if (start >= 0) tokens.push({ from: start, to: clusters.length });
  return tokens;
}

const UPPER = /^\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const ANY_DIGIT = /\p{Nd}/u;

/** Is the token's first grapheme the first one of its sentence? */
function opensSentence(clusters: readonly string[], token: Token): boolean {
  let index = token.from - 1;
  while (index >= 0 && isSpace(clusters[index] ?? '')) index -= 1;
  if (index < 0) return true;
  const previous = clusters[index] ?? '';
  return SENTENCE.has(previous) || BREATH.has(previous) || previous === '«' || previous === '—' || previous === '(';
}

/**
 * The gaps a hesitation may not sit in: inside a number (any token holding a digit) or inside a
 * name (a capitalised word that is not the first word of its sentence). A hesitation is a
 * typing beat; putting one inside «1965» or «Пётр» reads as a defect, not as a person.
 */
export function blockedGaps(clusters: readonly string[]): ReadonlySet<number> {
  const blocked = new Set<number>();
  for (const token of tokensOf(clusters)) {
    const first = clusters[token.from] ?? '';
    const body = clusters.slice(token.from, token.to);
    const number = body.some((cluster) => ANY_DIGIT.test(cluster));
    const name = UPPER.test(first) && body.some((cluster) => LOWER.test(cluster)) && !opensSentence(clusters, token);
    if (!number && !name) continue;
    for (let gap = token.from; gap < token.to - 1; gap += 1) blocked.add(gap);
  }
  return blocked;
}

/**
 * The hesitation positions: one every 40–60 characters, moved forward out of a number or a
 * name, never closer than `gap` to the one before it. Seeded — the same pass hesitates in the
 * same places.
 */
function hesitationsOf(clusters: readonly string[], random: () => number): number[] {
  const { everyFrom, everyTo, gap } = PRINT.hesitation;
  const blocked = blockedGaps(clusters);
  const out: number[] = [];
  const last = clusters.length - 1;
  let cursor = 0;
  while (cursor < last) {
    const step = everyFrom + Math.floor(random() * (everyTo - everyFrom + 1));
    let at = cursor + step;
    while (at < last && blocked.has(at)) at += 1;
    if (at >= last) break;
    // Never two in a row — and never so close that the two read as one long stall.
    if (out.length > 0 && at - (out[out.length - 1] ?? 0) < gap) {
      cursor = at;
      continue;
    }
    out.push(at);
    cursor = at;
  }
  return out;
}

/**
 * The plan: one interval per grapheme, no easing ramp anywhere — `inkTimes[i] - inkTimes[i-1]`
 * is the jittered base (×1.4 at a word's end) plus any punctuation or hesitation beat, and the
 * base never changes over the run.
 */
export function planPrint(input: PrintPlanInput): PrintPlan {
  const reduced = input.reducedMotion === true;
  const clusters = input.kind === 'deletion' ? [] : graphemes(input.after);
  const base = input.cps !== undefined && Number.isFinite(input.cps) && input.cps > 0 ? input.cps : PRINT.cps.desktop;
  const baseMs = 1_000 / base;
  const seed = hashSeed(input.seed);
  const holdMs = PRINT.holdMs[input.kind];
  const strikeMs = input.kind === 'insertion' ? 0 : PRINT.strikeMs;

  if (reduced) {
    // Nothing inks: the final text is set at once and only the ghost's strike has a life.
    return {
      kind: input.kind,
      reduced: true,
      seed,
      cps: base,
      baseMs,
      graphemes: clusters,
      inkTimes: [],
      hesitations: [],
      holdMs: 0,
      strikeMs,
      totalMs: strikeMs,
    };
  }

  const random = randomOf(seed);
  // One draw per grapheme, before anything else draws: the jitter is a property of the run, so
  // adding a hesitation rule later cannot shift it.
  const jitter = clusters.map(() => 1 + (random() * 2 - 1) * PRINT.jitter);
  const hesitations = hesitationsOf(clusters, random);
  // The hesitation's own length, drawn in the hesitations' order (one draw each).
  const hesitationMs = new Map<number, number>();
  for (const at of hesitations) {
    const span = PRINT.hesitation.toMs - PRINT.hesitation.fromMs;
    hesitationMs.set(at, PRINT.hesitation.fromMs + Math.round(random() * span));
  }

  const inkTimes: number[] = [];
  let clock = holdMs;
  for (let index = 0; index < clusters.length; index += 1) {
    inkTimes.push(clock);
    const isLast = index === clusters.length - 1;
    const wordEnd = isLast || isSpace(clusters[index + 1] ?? '');
    let step = baseMs * (jitter[index] ?? 1) * (wordEnd ? PRINT.wordEnd : 1);
    if (!isLast) {
      step += pauseAfter(clusters[index] ?? '');
      step += hesitationMs.get(index) ?? 0;
    }
    clock += Math.min(step, PRINT.stepGuardMs);
  }

  const totalMs = clock;
  if (totalMs > PRINT.planGuardMs) {
    throw new RangeError(`planPrint: ${String(totalMs)} ms is past the ${String(PRINT.planGuardMs)} ms guard`);
  }

  return {
    kind: input.kind,
    reduced: false,
    seed,
    cps: base,
    baseMs,
    graphemes: clusters,
    inkTimes,
    hesitations,
    holdMs,
    strikeMs,
    totalMs,
  };
}

/** How many of `times` have come at `at` (a binary search: the ink is monotone by construction). */
export function countUntil(times: readonly number[], at: number): number {
  if (!Number.isFinite(at)) return times.length;
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((times[middle] ?? Number.POSITIVE_INFINITY) <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** How many graphemes the ink has laid at `at` (0 before the first, all after the last). */
export function revealedAt(plan: PrintPlan, at: number): number {
  return countUntil(plan.inkTimes, at);
}

/** The caret's grapheme index: the leading edge of the ink, never behind it and never ahead. */
export function caretIndexAt(plan: PrintPlan, at: number): number {
  return clamp(revealedAt(plan, at), 0, plan.graphemes.length);
}

/** The instant the last grapheme's interval ends: the print is over then (a ghost: after its fade). */
export function settleMs(plan: PrintPlan): number {
  return Math.max(plan.totalMs, plan.strikeMs);
}
